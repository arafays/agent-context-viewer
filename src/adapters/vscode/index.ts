/**
 * VS Code (GitHub Copilot Chat) adapter.
 *
 * Primary source: `User/workspaceStorage/<hash>/chatSessions/*.jsonl` — per-session
 * ObjectMutationLog files replayed by ./mutation-log.ts into the live chat
 * state ({version, creationDate, customTitle, sessionId, requests[]}). One
 * `request` == one user turn: message.text (user), response[] parts
 * (assistant: thinking / markdown / toolInvocationSerialized / textEditGroup…),
 * modelId, agent, and result.metadata (promptTokens/outputTokens on ~1/3 of
 * requests — the only real per-request usage VS Code stores).
 *
 * Secondary source: `globalStorage/github.copilot-chat/session-store.db`
 * (read-only; WAL copy fallback in ./store.ts) for enrichment (cwd, branch,
 * repository, summary/title) and as a last-resort transcript for sessions
 * with no mutation log on disk.
 *
 * Honesty rules baked into contextInfo notes:
 *  - no literal system prompt is persisted → only labeled persisted fragments
 *    (renderedGlobalContext / renderedUserMessage / instructions) in ./context.ts
 *  - context points are built ONLY for requests with real persisted usage
 *  - tool results / full per-request context are not persisted anywhere
 */
import { existsSync, readFileSync } from "node:fs"
import { isFresh as cacheIsFresh, type MetaCache, metaCacheKey } from "../../engine/meta-cache.ts"
import { SearchFileBuilder } from "../../engine/transcript-lines.ts"
import type {
  AgentSession,
  ContentBlockView,
  ContextPoint,
  NormalizedMessage,
  SessionEventView,
  SessionMeta,
  Turn,
  UsageTotals
} from "../types.ts"
import { buildVscodeContextInfo } from "./context.ts"
import { replayMutationLog } from "./mutation-log.ts"
import {
  type ChatFile,
  type DbSessionRow,
  findStores,
  listChatFiles,
  readDbTurns,
  readSessionDb,
  type SessionDb
} from "./store.ts"

/* ------------------------------ tiny helpers ------------------------------ */

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asArr(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

/** number only when VS Code actually stored one (never coerced to 0). */
function numMaybe(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function zeroUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function projectLabel(cwd: string): string {
  if (!cwd) return ""
  const parts = cwd.split("/").filter(Boolean)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : cwd
}

function iso(ms: number, fallbackMs = 0): string {
  const t = ms > 0 ? ms : fallbackMs
  try {
    return new Date(t).toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

function truncate(text: string, max = 100): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/* --------------------------- raw request parsing -------------------------- */

/** Per-request token usage — only when VS Code persisted real numbers. */
function requestUsage(req: Record<string, unknown>): { usage: UsageTotals; known: boolean } {
  const result = asObj(req.result) ?? {}
  const md = asObj(result.metadata) ?? {}
  const ru = asObj(result.usage) ?? {}
  const input = numMaybe(md.promptTokens) ?? numMaybe(ru.promptTokens) ?? numMaybe(req.promptTokens)
  const output = numMaybe(md.outputTokens) ?? numMaybe(ru.completionTokens) ?? numMaybe(req.completionTokens)
  if (input === undefined && output === undefined) return { usage: zeroUsage(), known: false }
  const i = input ?? 0
  const o = output ?? 0
  return {
    usage: { input: i, output: o, cacheRead: 0, cacheWrite: 0, total: i + o },
    known: true
  }
}

/** Requests that are JSON objects (malformed entries are skipped+counted). */
function rawRequests(state: Record<string, unknown>): { requests: Array<Record<string, unknown>>; skipped: number } {
  const arr = asArr(state.requests) ?? []
  const requests: Array<Record<string, unknown>> = []
  let skipped = 0
  for (const r of arr) {
    const o = asObj(r)
    if (o) requests.push(o)
    else skipped++
  }
  return { requests, skipped }
}

/** User prompt text for a request (message.text, falling back to text parts). */
function userTextOf(req: Record<string, unknown>): string {
  const msg = asObj(req.message)
  const direct = str(msg?.text)
  if (direct.trim()) return direct
  const parts = asArr(msg?.parts) ?? []
  const texts = parts.map((p) => str(asObj(p)?.text)).filter((t) => t.trim().length > 0)
  return texts.join("\n")
}

/** Assistant response parts → normalized content blocks. */
function responseBlocks(resp: unknown[], toolSet: Set<string>): ContentBlockView[] {
  const blocks: ContentBlockView[] = []
  for (const raw of resp) {
    const p = asObj(raw)
    if (!p) continue
    const kind = p.kind === undefined || p.kind === null ? "markdown" : str(p.kind)
    if (kind === "thinking") {
      const t = str(p.value)
      if (t) blocks.push({ kind: "thinking", text: t })
    } else if (kind === "markdown") {
      const t = str(p.value)
      if (t) blocks.push({ kind: "text", text: t })
    } else if (kind === "toolInvocationSerialized") {
      const toolId = str(p.toolId) || "tool"
      toolSet.add(toolId)
      const msg = asObj(p.invocationMessage)
      const invocation = str(msg?.value) || str(p.generatedTitle)
      blocks.push({
        kind: "tool_use",
        toolName: toolId,
        toolCallId: str(p.toolCallId) || undefined,
        input: invocation || undefined
      })
    } else if (kind === "textEditGroup") {
      const uri = asObj(p.uri)
      const file = str(uri?.fsPath)
      blocks.push({ kind: "tool_use", toolName: "textEditGroup", input: file ? { file } : undefined })
    } else if (kind === "workspaceEdit") {
      const edits = asArr(p.edits)
      blocks.push({ kind: "tool_use", toolName: "workspaceEdit", input: edits ? { edits: edits.length } : undefined })
    }
    // UI/telemetry markers carry no transcript content — skipped:
    // inlineReference, undoStop, codeblockUri, progressTaskSerialized,
    // progressMessage, mcpServersStarting, command, elicitationSerialized,
    // questionCarousel, autoModeResolution
  }
  return blocks
}

/* ------------------------------- discovery -------------------------------- */

function metaFromRequests(args: {
  file: ChatFile
  state: Record<string, unknown>
  requests: Array<Record<string, unknown>>
  dbRow: DbSessionRow | null
}): SessionMeta | null {
  const { file, state, requests, dbRow } = args
  if (requests.length === 0) return null // empty chat editor state — nothing to show

  const creation = num(state.creationDate)
  let firstTs = 0
  let lastTs = 0
  let input = 0
  let output = 0
  let toolCount = 0
  let assistantMessages = 0
  let model = ""
  for (const req of requests) {
    const ts = num(req.timestamp)
    const respTs = num(req.responseTimestamp) || ts
    if (!firstTs) firstTs = ts || respTs
    if (respTs > lastTs) lastTs = respTs
    const u = requestUsage(req)
    if (u.known) {
      input += u.usage.input
      output += u.usage.output
    }
    const resp = asArr(req.response) ?? []
    if (resp.length > 0) assistantMessages++
    for (const part of resp) {
      if (asObj(part)?.kind === "toolInvocationSerialized") toolCount++
    }
    const mid = str(req.modelId)
    if (mid) model = mid // last request's model wins (session's current model)
  }

  const cwd = dbRow?.cwd || file.cwd
  const project = projectLabel(cwd)
  const customTitle = str(state.customTitle).trim()
  const summary = dbRow?.summary?.trim() ?? ""
  const firstPrompt = userTextOf(requests[0] ?? {})
  const name = customTitle || truncate(summary || firstPrompt) || undefined

  const meta: SessionMeta = {
    tool: "vscode",
    id: file.id,
    path: file.path,
    cwd,
    project,
    startedAt: iso(creation || firstTs, file.mtimeMs),
    updatedAt: iso(lastTs, file.mtimeMs),
    sizeBytes: file.sizeBytes,
    name,
    model: model || undefined,
    messageCount: requests.length + assistantMessages,
    userMessages: requests.length,
    assistantMessages,
    toolResults: toolCount,
    tokens: { input, output, cacheRead: 0, cacheWrite: 0 },
    compactionCount: 0,
    customTypes: []
  }

  // searchable units: one user + one assistant line per turn (tool output excluded)
  const b = SearchFileBuilder.start(meta)
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]
    if (!req) continue
    const uText = userTextOf(req)
    if (uText.trim()) b.emit(i, "user", uText)
    const resp = asArr(req.response) ?? []
    const reply = resp
      .map((p) => {
        const o = asObj(p)
        const kind = o && (o.kind === undefined || o.kind === null) ? "markdown" : str(o?.kind)
        return kind === "markdown" ? str(o?.value) : ""
      })
      .filter((t) => t.trim().length > 0)
      .join("\n")
    if (reply.trim()) b.emit(i, "assistant", reply)
  }
  const searchText = b.toString()
  if (searchText) meta.searchText = searchText
  return meta
}

function metaFromDbRow(id: string, row: DbSessionRow, db: SessionDb): SessionMeta {
  const cwd = row.cwd
  const started = Date.parse(row.createdAt)
  const updated = Date.parse(row.updatedAt)
  const meta: SessionMeta = {
    tool: "vscode",
    id,
    path: db.path,
    cwd,
    project: projectLabel(cwd),
    startedAt: iso(started, db.mtimeMs),
    updatedAt: iso(updated, db.mtimeMs),
    sizeBytes: db.sizeBytes,
    name: row.summary ? truncate(row.summary) : undefined,
    model: undefined,
    messageCount: row.userMessages + row.assistantResponses,
    userMessages: row.userMessages,
    assistantMessages: row.assistantResponses,
    toolResults: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactionCount: 0,
    customTypes: []
  }
  const turns = readDbTurns(db.path, id)
  if (turns.length > 0) {
    const b = SearchFileBuilder.start(meta)
    for (const t of turns) {
      if (t.userMessage.trim()) b.emit(t.turnIndex, "user", t.userMessage)
      if (t.assistantResponse.trim()) b.emit(t.turnIndex, "assistant", t.assistantResponse)
    }
    const searchText = b.toString()
    if (searchText) meta.searchText = searchText
  }
  return meta
}

/** True when at least one VS Code user-data dir exists on this machine. */
export function isAvailable(): boolean {
  return findStores().length > 0
}

/**
 * Full discovery pass: enumerate chat mutation logs across all VS Code
 * user-data dirs, replay changed files, merge session-store.db enrichment,
 * dedupe by session id, sort newest-first. Returns [] when no store exists.
 */
export function discoverSessions(cache?: MetaCache): SessionMeta[] {
  const stores = findStores()
  if (stores.length === 0) return []
  const db = readSessionDb(stores)
  const files = listChatFiles(stores)

  const byId = new Map<string, SessionMeta>()
  const seenPaths = new Set<string>()

  for (const file of files) {
    if (seenPaths.has(file.path)) continue
    seenPaths.add(file.path)
    const row = db?.rows.get(file.id) ?? null
    const cwd = row?.cwd || file.cwd
    const project = projectLabel(cwd)
    const key = metaCacheKey({ tool: "vscode", project, id: file.id })

    let meta: SessionMeta | null = null
    const cached = cache?.read(key)
    if (cached && cacheIsFresh(cached, file.sizeBytes, file.mtimeMs)) {
      meta = cached.meta
    } else {
      try {
        const { state } = replayMutationLog(readFileSync(file.path, "utf8"))
        if (state) {
          const { requests } = rawRequests(state)
          meta = metaFromRequests({ file, state, requests, dbRow: row })
        }
      } catch {
        meta = null // unreadable/corrupt file — skip, never throw
      }
      if (meta && cache) {
        cache.write(key, { sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, meta })
      }
    }
    if (!meta) continue

    // dedupe overlapping copies of the same session id (multi-root windows
    // can store the same transcript in more than one workspace dir)
    const prev = byId.get(meta.id)
    if (!prev || prev.updatedAt < meta.updatedAt) byId.set(meta.id, meta)
  }

  // sessions present only in session-store.db (no mutation log on disk)
  if (db) {
    for (const [id, row] of db.rows) {
      if (byId.has(id)) continue
      const key = metaCacheKey({ tool: "vscode", project: projectLabel(row.cwd), id })
      const cached = cache?.read(key)
      if (cached && cacheIsFresh(cached, db.sizeBytes, db.mtimeMs) && cached.meta) {
        byId.set(id, cached.meta)
        continue
      }
      const meta = metaFromDbRow(id, row, db)
      if (meta) {
        if (cache) cache.write(key, { sizeBytes: db.sizeBytes, mtimeMs: db.mtimeMs, meta })
        byId.set(id, meta)
      }
    }
  }

  const metas = [...byId.values()]
  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return metas
}

/* -------------------------------- loading --------------------------------- */

function attachEvent(turn: Turn | undefined, e: SessionEventView): void {
  if (turn) turn.events.push(e)
}

/** Normalize a replayed chatSessions state into an AgentSession. */
function normalizeState(
  state: Record<string, unknown>,
  meta: SessionMeta,
  dbRow: DbSessionRow | null,
  malformedLines: number
): AgentSession {
  const { requests, skipped } = rawRequests(state)

  const entries: NormalizedMessage[] = [] // flat transcript (entryIndex space)
  const turns: Turn[] = []
  const assistantCalls: NormalizedMessage[] = []
  const contextPoints: ContextPoint[] = []
  const toolSet = new Set<string>()
  const pending = asArr(state.pendingRequests) ?? []

  let usageKnown = 0
  let prevModel: string | null = null
  let prevAgent: string | null = null
  let lastTs = num(state.creationDate)

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]
    if (!req) continue
    const ts = num(req.timestamp) || lastTs
    const respTs = num(req.responseTimestamp) || ts
    if (respTs > lastTs) lastTs = respTs
    const modelId = str(req.modelId) || null
    const { usage, known } = requestUsage(req)
    if (known) usageKnown++
    const turnEvents: SessionEventView[] = []

    if (modelId && prevModel && modelId !== prevModel) {
      turnEvents.push({ kind: "model_change", timestamp: ts, detail: `model → ${modelId}` })
    }
    const agentId = str(asObj(req.agent)?.id)
    if (agentId && prevAgent && agentId !== prevAgent) {
      turnEvents.push({ kind: "custom", timestamp: ts, detail: `agent → ${agentId}` })
    }
    prevModel = modelId ?? prevModel
    prevAgent = agentId || prevAgent

    // user message
    const userText = userTextOf(req)
    const userPos = entries.length
    const userMsg: NormalizedMessage = {
      role: "user",
      timestamp: ts,
      blocks: userText.trim() ? [{ kind: "text", text: userText }] : [],
      entryIndex: userPos
    }
    entries.push(userMsg)

    // the request's context = everything persisted up to and incl. the user msg
    const contextMessages = entries.slice()

    // assistant response == the (single) LLM request of this turn
    const resp = asArr(req.response) ?? []
    const blocks = responseBlocks(resp, toolSet)
    const err = asObj(asObj(req.result)?.errorDetails)
    if (err) {
      const label = [str(err.code), str(err.message)].filter((s) => s.length > 0).join(" — ")
      turnEvents.push({ kind: "custom", timestamp: respTs, detail: `[response error] ${label || "unknown error"}` })
    }
    const assistantMsg: NormalizedMessage = {
      role: "assistant",
      timestamp: respTs,
      blocks,
      model: modelId ?? undefined,
      usage,
      stopReason: err ? str(err.code) || "error" : undefined,
      entryIndex: entries.length
    }
    entries.push(assistantMsg)
    assistantCalls.push(assistantMsg)

    const turn: Turn = {
      index: i,
      timestamp: ts,
      userMessage: userMsg,
      assistantCalls: [assistantMsg],
      toolResults: [], // tool result payloads are not persisted by chatSessions
      events: turnEvents,
      usage,
      model: modelId,
      thinkingLevel: null,
      entryStart: userPos,
      entryEnd: entries.length - 1
    }
    turns.push(turn)

    // context point ONLY where real usage was persisted (honest curve)
    if (known) {
      contextPoints.push({
        requestIndex: assistantCalls.length - 1,
        turnIndex: i,
        timestamp: respTs,
        model: modelId,
        thinkingLevel: null,
        usage,
        contextTokens: usage.input + usage.cacheRead,
        contextMessages
      })
    }
  }

  // unsent/incomplete requests VS Code kept in memory only
  if (pending.length > 0) {
    attachEvent(turns[turns.length - 1], {
      kind: "custom",
      timestamp: lastTs,
      detail: `[pending] ${pending.length} incomplete request(s) never persisted as a response`
    })
  }

  const contextInfo = buildVscodeContextInfo({
    requests,
    tools: [...toolSet],
    usageKnown,
    malformedLines: malformedLines + skipped,
    dbRow,
    fromDb: false
  })

  return {
    meta,
    turns,
    events: turns.flatMap((t) => t.events),
    assistantCalls,
    contextInfo,
    contextPoints,
    raw: { source: meta.path, state, db: dbRow }
  }
}

/** Last-resort normalization from session-store.db rows (no mutation log). */
function normalizeFromDb(meta: SessionMeta, row: DbSessionRow, dbPath: string): AgentSession {
  const rows = readDbTurns(dbPath, meta.id)
  const entries: NormalizedMessage[] = []
  const turns: Turn[] = []
  const assistantCalls: NormalizedMessage[] = []

  for (const r of rows) {
    const userPos = entries.length
    const userMsg: NormalizedMessage = {
      role: "user",
      timestamp: r.timestamp,
      blocks: r.userMessage.trim() ? [{ kind: "text", text: r.userMessage }] : [],
      entryIndex: userPos
    }
    entries.push(userMsg)
    let last = userPos
    if (r.assistantResponse.trim()) {
      const assistantMsg: NormalizedMessage = {
        role: "assistant",
        timestamp: r.timestamp,
        blocks: [{ kind: "text", text: r.assistantResponse }],
        usage: zeroUsage(),
        entryIndex: entries.length
      }
      entries.push(assistantMsg)
      assistantCalls.push(assistantMsg)
      last = entries.length - 1
    }
    turns.push({
      index: r.turnIndex,
      timestamp: r.timestamp,
      userMessage: userMsg,
      assistantCalls: assistantCalls.filter((a) => a.entryIndex > userPos && a.entryIndex <= last),
      toolResults: [],
      events: [],
      usage: zeroUsage(),
      model: null,
      thinkingLevel: null,
      entryStart: userPos,
      entryEnd: last
    })
  }

  const contextInfo = buildVscodeContextInfo({
    requests: [],
    tools: [],
    usageKnown: 0,
    malformedLines: 0,
    dbRow: row,
    fromDb: true
  })

  return {
    meta,
    turns,
    events: [],
    assistantCalls,
    contextInfo,
    contextPoints: [], // session-store.db stores no token usage
    raw: { source: dbPath, state: null, db: row }
  }
}

/**
 * Full load of one VS Code chat session (mutation log, db fallback).
 * Never throws on malformed data — bad lines are skipped and noted.
 */
export function loadSession(meta: SessionMeta): AgentSession {
  const stores = findStores()
  const db = stores.length > 0 ? readSessionDb(stores) : null
  const dbRow = db?.rows.get(meta.id) ?? null

  if (meta.path.endsWith(".jsonl")) {
    if (existsSync(meta.path)) {
      const text = readFileSync(meta.path, "utf8")
      const { state, malformedLines } = replayMutationLog(text)
      if (state) return normalizeState(state, meta, dbRow, malformedLines)
      // no Initial op — fall through to the db when it knows this session
    }
    if (db && dbRow && db.rows.has(meta.id)) return normalizeFromDb(meta, dbRow, db.path)
    throw new Error(`vscode session not found: ${meta.id}`)
  }

  // meta.path is the session-store.db (db-only session)
  if (db && dbRow) return normalizeFromDb(meta, dbRow, db.path)
  throw new Error(`vscode session not found: ${meta.id}`)
}
