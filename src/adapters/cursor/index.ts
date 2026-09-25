/**
 * Cursor adapter — composer transcripts from Cursor's user-data store.
 *
 * Store map (verified against ~/.config/Cursor/User/globalStorage on Linux):
 *   - `composerHeaders` table: one row per composer (id, workspace, times,
 *     `value` head JSON with name/workspaceIdentifier/agentLocation).
 *   - `cursorDiskKV` blobs:
 *       `composerData:<composerId>`   ordered bubble headers + model/config
 *       `bubbleId:<composerId>:<id>`  one JSON bubble per message/step
 *       `agentKv:blob:<sha256>`       content-addressed request payloads —
 *                                     NO composerId linkage (not attributable)
 *   - `conversation-search.db`: Cursor's own titles + FTS bodies.
 *
 * Design decisions (honesty rules):
 *   - A "session" is a composer that has local bubble rows. 100 of 145
 *     composers on this machine have no local messages (Cursor keeps only
 *     their headers) — they would open as empty transcripts and are skipped.
 *   - `contextPoints` is always empty: every bubble's `tokenCount` is 0 and no
 *     per-request usage exists, so a context curve would have to be invented.
 *   - `contextInfo.systemPrompt` is always "" — the real prompt exists only in
 *     unattributable `agentKv:blob` rows; `notes` explain what is and isn't
 *     recoverable. Nothing is reconstructed from disk.
 *   - Malformed rows are skipped and counted in `notes`, never thrown.
 *
 * Discovery reads headers + composerData sizes + one bubble-key scan (~5ms);
 * JSON parsing of composerData (and the first-user-prompt point read for
 * `searchText`) only happens on a sidecar cache miss (meta-cache.ts, guarded
 * by composerData size + header max-timestamp).
 */
import type { Database } from "bun:sqlite"
import { basename } from "node:path"
import { isFresh as cacheIsFresh, type MetaCache, metaCacheKey } from "../../engine/meta-cache.ts"
import { SearchFileBuilder } from "../../engine/transcript-lines.ts"
import type { AgentSession, ContentBlockView, NormalizedMessage, SessionMeta, Turn, UsageTotals } from "../types.ts"
import { buildCursorContextInfo } from "./context.ts"
import { globalStoragePath, openSearchStore, openStateStore } from "./db.ts"
import {
  type Bubble,
  bubbleKind,
  bubbleUsage,
  type ComposerData,
  type ConversationHeader,
  type HeaderRow,
  type HeaderValue,
  isoToEpoch,
  parseJson,
  parseToolField,
  promptTextOf,
  summaryNodeCount
} from "./schema.ts"

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function projectLabel(cwd: string): string {
  if (!cwd) return ""
  const b = basename(cwd)
  return b && b !== "/" ? b : cwd
}

function uriPath(u: unknown): string {
  const o = u as { uri?: { fsPath?: string } } | undefined
  const p = o?.uri?.fsPath
  return typeof p === "string" && p ? p : ""
}

/** Header-derived cwd only (stable across runs → stable cache keys). */
function headerCwd(h: HeaderRow | undefined): string {
  const v = h?.value
  if (!v) return ""
  return (
    uriPath(v.workspaceIdentifier) || uriPath(v.agentLocation?.environment) || str(v.trackedGitRepos?.[0]?.repoPath)
  )
}

/** Best cwd for display: workspace folder from header or composerData, else repo. */
function resolveCwd(
  header: HeaderRow | undefined,
  cd: ComposerData | null
): { cwd: string; source: "workspace" | "repo" | "none" } {
  const hp = header
    ? uriPath(header.value?.workspaceIdentifier) || uriPath(header.value?.agentLocation?.environment)
    : ""
  if (hp) return { cwd: hp, source: "workspace" }
  const cp = uriPath(cd?.workspaceIdentifier)
  if (cp) return { cwd: cp, source: "workspace" }
  const repo = str(header?.value?.trackedGitRepos?.[0]?.repoPath)
  if (repo) return { cwd: repo, source: "repo" }
  return { cwd: "", source: "none" }
}

/** Cache freshness guard: derived from the header row only, so a cache hit
 * (which skips parsing composerData) computes exactly what the write did. */
function headerMtime(h: HeaderRow | undefined): number {
  if (!h) return 0
  return Math.max(num(h.value?.lastUpdatedAt), h.lastUpdatedAt, h.recency, h.createdAt)
}

function sessionModel(cd: ComposerData | null): string | undefined {
  const n = cd?.modelConfig?.modelName
  if (typeof n === "string" && n.trim() && n.trim() !== "default") return n.trim()
  return undefined
}

function zeroUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

// ---------------------------------------------------------------------------
// store readers
// ---------------------------------------------------------------------------

function readHeaderRows(d: Database): Map<string, HeaderRow> {
  const out = new Map<string, HeaderRow>()
  let rows: Array<Record<string, unknown>>
  try {
    rows = d
      .query(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, recency, isArchived, isSubagent, value
         FROM composerHeaders`
      )
      .all() as Array<Record<string, unknown>>
  } catch {
    return out // table absent in this Cursor version → composerData alone still works
  }
  for (const r of rows) {
    const id = str(r.composerId)
    if (!id) continue
    out.set(id, {
      composerId: id,
      workspaceId: str(r.workspaceId),
      createdAt: num(r.createdAt),
      lastUpdatedAt: num(r.lastUpdatedAt),
      recency: num(r.recency),
      isArchived: num(r.isArchived),
      isSubagent: num(r.isSubagent),
      value: parseJson<HeaderValue>(r.value)
    })
  }
  return out
}

function readHeader(d: Database, id: string): HeaderRow | undefined {
  let row: Record<string, unknown> | null
  try {
    row = d
      .query(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, recency, isArchived, isSubagent, value
         FROM composerHeaders WHERE composerId = ?`
      )
      .get(id) as Record<string, unknown> | null
  } catch {
    return undefined
  }
  if (!row) return undefined
  return {
    composerId: str(row.composerId) || id,
    workspaceId: str(row.workspaceId),
    createdAt: num(row.createdAt),
    lastUpdatedAt: num(row.lastUpdatedAt),
    recency: num(row.recency),
    isArchived: num(row.isArchived),
    isSubagent: num(row.isSubagent),
    value: parseJson<HeaderValue>(row.value)
  }
}

/** composerData point read: parsed JSON + blob size (freshness guard). */
function readComposer(d: Database, id: string): { data: ComposerData | null; size: number } {
  let row: { value: unknown; len: number | null } | null
  try {
    row = d.query(`SELECT value, length(value) len FROM cursorDiskKV WHERE key = ?`).get(`composerData:${id}`) as {
      value: unknown
      len: number | null
    } | null
  } catch {
    return { data: null, size: 0 }
  }
  if (!row) return { data: null, size: 0 }
  return { data: parseJson<ComposerData>(row.value), size: num(row.len) }
}

interface ConversationInfo {
  title: string
  body: string
}

/** Cursor's chat digest (titles + FTS bodies); best-effort, may be absent. */
function readConversations(): Map<string, ConversationInfo> {
  const out = new Map<string, ConversationInfo>()
  const store = openSearchStore()
  if (!store) return out
  try {
    const rows = store.db
      .query(
        `SELECT c.id id, c.title title, f.body body
         FROM conversations c LEFT JOIN conversation_fts f ON f.rowid = c.fts_rowid`
      )
      .all() as Array<{ id?: unknown; title?: unknown; body?: unknown }>
    for (const r of rows) {
      const id = str(r.id)
      if (!id) continue
      out.set(id, { title: str(r.title), body: str(r.body) })
    }
  } catch {
    try {
      const rows = store.db.query(`SELECT id, title FROM conversations`).all() as Array<{
        id?: unknown
        title?: unknown
      }>
      for (const r of rows) {
        const id = str(r.id)
        if (id) out.set(id, { title: str(r.title), body: "" })
      }
    } catch {
      /* digest unavailable → titles/body simply omitted */
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

interface MessageCounts {
  messageCount: number
  users: number
  assistants: number
  tools: number
}

/**
 * Classify bubbles from the ordered header list (cheap, no bubble reads).
 * `messageCount` is the real bubble-row count so the list matches what the
 * transcript viewer will show (headers can be a pruned subset).
 */
function countsFromHeaders(headers: ConversationHeader[] | undefined, bubbleCount: number): MessageCounts {
  if (!headers || headers.length === 0) {
    return { messageCount: bubbleCount, users: 0, assistants: 0, tools: 0 }
  }
  let users = 0
  let assistants = 0
  let tools = 0
  for (const h of headers) {
    if (h.type === 1) users++
    else if (h.grouping?.capabilityType === 15) tools++
    else assistants++
  }
  return { messageCount: bubbleCount, users, assistants, tools }
}

/** First user prompt (exact point read) — feeds `searchText` for `/` search. */
function firstUserBubble(d: Database, id: string, headers: ConversationHeader[] | undefined): Bubble | null {
  const first = headers?.find((h) => h.type === 1 && h.bubbleId)
  if (!first) return null
  let row: { value: unknown } | null
  try {
    row = d.query(`SELECT value FROM cursorDiskKV WHERE key = ?`).get(`bubbleId:${id}:${first.bubbleId}`) as {
      value: unknown
    } | null
  } catch {
    return null
  }
  return row ? parseJson<Bubble>(row.value) : null
}

/**
 * Full discovery pass. Sources: composerHeaders (identity/times), one
 * bubble-key range scan (which composers have local messages + counts),
 * composerData sizes (freshness), conversation-search titles (fallback names).
 */
export function discoverSessions(cache?: MetaCache): SessionMeta[] {
  const store = openStateStore()
  if (!store) return []
  const d = store.db

  // Bubble rows per composer — one index-range scan (~4ms). This is also the
  // authority on which composers have locally loadable transcripts: headers
  // and composerData rows exist for ~100 composers whose messages are absent.
  const bubbleCounts = new Map<string, number>()
  try {
    const keys = d.query(`SELECT key FROM cursorDiskKV WHERE key GLOB 'bubbleId:*'`).all() as Array<{
      key: string
    }>
    for (const r of keys) {
      const id = r.key.slice("bubbleId:".length).split(":")[0]
      if (id) bubbleCounts.set(id, (bubbleCounts.get(id) ?? 0) + 1)
    }
  } catch {
    return []
  }

  const headers = readHeaderRows(d)

  // composerData presence + size (JSON parse deferred to cache misses)
  const cdSizes = new Map<string, number>()
  try {
    const rows = d
      .query(`SELECT key, length(value) len FROM cursorDiskKV WHERE key GLOB 'composerData:*'`)
      .all() as Array<{
      key: string
      len: number | null
    }>
    for (const r of rows) cdSizes.set(r.key.slice("composerData:".length), num(r.len))
  } catch {
    /* sizes stay empty → every composer reads as size 0 */
  }

  const conversations = readConversations()
  const metas: SessionMeta[] = []

  for (const [id, bubbleCount] of bubbleCounts) {
    if (bubbleCount === 0) continue
    const header = headers.get(id)
    const cdSize = cdSizes.get(id) ?? 0
    // Needs at least one describing row; composers with no local messages are
    // never in bubbleCounts, so they are skipped here by construction.
    if (!header && cdSize === 0) continue

    const key = metaCacheKey({ tool: "cursor", project: projectLabel(headerCwd(header)), id })
    const mtime = headerMtime(header)

    if (cache) {
      const entry = cache.read(key)
      if (entry && cacheIsFresh(entry, cdSize, mtime) && entry.meta) {
        metas.push(entry.meta)
        continue
      }
    }

    const { data } = readComposer(d, id)
    const conv = conversations.get(id)
    const cwdInfo = resolveCwd(header, data)
    const counts = countsFromHeaders(data?.fullConversationHeadersOnly, bubbleCount)

    const startedMs = Math.max(num(data?.createdAt), header?.createdAt ?? 0)
    const updatedMs = Math.max(num(data?.lastUpdatedAt), headerMtime(header), startedMs)
    const name = str(header?.value?.name).trim() || str(data?.name).trim() || str(conv?.title).trim() || undefined

    const meta: SessionMeta = {
      tool: "cursor",
      id,
      path: `${globalStoragePath()}#composerData:${id}`,
      cwd: cwdInfo.cwd,
      project: projectLabel(cwdInfo.cwd),
      startedAt: new Date(startedMs).toISOString(),
      updatedAt: new Date(updatedMs).toISOString(),
      sizeBytes: cdSize,
      name,
      model: sessionModel(data),
      thinkingLevel: undefined,
      messageCount: counts.messageCount,
      userMessages: counts.users,
      assistantMessages: counts.assistants,
      toolResults: counts.tools,
      // No session-summed usage is persisted (bubble tokenCount is all-zero;
      // promptTokenBreakdown is a last-request snapshot, not an input total) —
      // zeros here, the snapshot is surfaced in contextInfo.notes instead.
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: summaryNodeCount(data?.promptContextUsageTree),
      customTypes: []
    }
    if (meta.compactionCount > 0) meta.customTypes = [{ type: "summary_message", count: meta.compactionCount }]

    const builder = SearchFileBuilder.start(meta)
    const firstUser = firstUserBubble(d, id, data?.fullConversationHeadersOnly)
    if (firstUser) {
      const preview = promptTextOf(firstUser)
      if (preview) builder.emit(0, "user", preview)
    }
    if (conv?.body) builder.emit(0, "session", conv.body)
    meta.searchText = builder.toString()

    if (cache) cache.write(key, { sizeBytes: cdSize, mtimeMs: mtime, meta })
    metas.push(meta)
  }

  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return metas
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

/** Order bubbles: composerData's render order wins; unreferenced rows (pruned
 * or hidden history — 411 rows in one session on this machine) are merged in
 * by timestamp so nothing recorded is dropped. */
function orderBubbles(cd: ComposerData | null, bubbles: Bubble[]): { ordered: Bubble[]; unreferenced: number } {
  const tsOf = (b: Bubble): number => isoToEpoch(b.createdAt, 0)
  const headers = cd?.fullConversationHeadersOnly

  if (!headers || headers.length === 0) {
    // No persisted render order (single observed case: composerData with an
    // empty header list) → chronological; ties keep discovery order.
    return { ordered: [...bubbles].sort((a, b) => tsOf(a) - tsOf(b)), unreferenced: 0 }
  }

  const byId = new Map<string, Bubble>()
  for (const b of bubbles) if (b.bubbleId) byId.set(b.bubbleId, b)

  const referenced = new Set<string>()
  const ordered: Bubble[] = []
  for (const h of headers) {
    if (!h.bubbleId) continue
    const b = byId.get(h.bubbleId)
    if (b) {
      ordered.push(b)
      referenced.add(h.bubbleId)
    }
  }
  const leftovers = bubbles.filter((b) => !b.bubbleId || !referenced.has(b.bubbleId))
  leftovers.sort((a, b) => tsOf(a) - tsOf(b))
  for (const lo of leftovers) {
    const t = tsOf(lo)
    let idx = ordered.length
    for (let i = 0; i < ordered.length; i++) {
      const cur = ordered[i]
      if (cur && tsOf(cur) > t) {
        idx = i
        break
      }
    }
    ordered.splice(idx, 0, lo)
  }
  return { ordered, unreferenced: leftovers.length }
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result
  if (result == null) return ""
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function newTurn(index: number, ts: number, model: string | null): Turn {
  return {
    index,
    timestamp: ts,
    userMessage: null,
    assistantCalls: [],
    toolResults: [],
    events: [],
    usage: zeroUsage(),
    model,
    thinkingLevel: null,
    entryStart: -1,
    entryEnd: -1
  }
}

function usageOf(bubble: Bubble): UsageTotals | undefined {
  const u = bubbleUsage(bubble)
  if (!u) return undefined
  return { input: u.input, output: u.output, cacheRead: 0, cacheWrite: 0, total: u.input + u.output }
}

/** Merge one bubble's usage/model into the assistant call it belongs to. */
function mergeCall(call: NormalizedMessage, bubble: Bubble): void {
  const model = bubble.modelInfo?.modelName
  if (!call.model && typeof model === "string" && model.trim()) call.model = model.trim()
  const u = bubbleUsage(bubble)
  if (!u) return
  if (!call.usage) {
    call.usage = { input: u.input, output: u.output, cacheRead: 0, cacheWrite: 0, total: u.input + u.output }
    return
  }
  call.usage.input += u.input
  call.usage.output += u.output
  call.usage.total = call.usage.input + call.usage.output + call.usage.cacheRead + call.usage.cacheWrite
}

/**
 * Load one composer: parse every bubble row, order them, and map them onto the
 * normalized model (user bubbles → turns; thinking/text bubbles → assistant
 * calls; toolFormerData → tool_use block on the call + a toolResult message).
 */
export function loadSession(meta: SessionMeta): AgentSession {
  const store = openStateStore()
  if (!store) throw new Error(`cursor store not found: ${globalStoragePath()}`)
  const d = store.db

  const { data: cd } = readComposer(d, meta.id)
  const header = readHeader(d, meta.id)
  const cwdInfo = resolveCwd(header, cd)
  const sessionModelLabel = sessionModel(cd) ?? null
  const fallbackTs = Math.max(num(cd?.createdAt), header?.createdAt ?? 0)

  let rows: Array<{ key: string; value: unknown }> = []
  try {
    rows = d.query(`SELECT key, value FROM cursorDiskKV WHERE key GLOB ?`).all(`bubbleId:${meta.id}:*`) as Array<{
      key: string
      value: unknown
    }>
  } catch {
    rows = []
  }
  if (rows.length === 0 && !cd) throw new Error(`cursor session not found: ${meta.id}`)

  const bubbles: Bubble[] = []
  let skipped = 0
  for (const r of rows) {
    const b = parseJson<Bubble>(r.value)
    if (b && (b.type === 1 || b.type === 2)) {
      if (!b.bubbleId) {
        // ordering needs the id; recover it from `bubbleId:<composer>:<id>`
        const seg = r.key.split(":")
        const recovered = seg[seg.length - 1]
        if (recovered) b.bubbleId = recovered
      }
      bubbles.push(b)
    } else skipped++
  }

  const { ordered, unreferenced } = orderBubbles(cd, bubbles)

  const turns: Turn[] = []
  const assistantCalls: NormalizedMessage[] = []
  let currentTurn: Turn | null = null
  let pendingCall: NormalizedMessage | null = null
  let lastWasTool = false
  let entryIndex = 0

  const ensureTurn = (ts: number): Turn => {
    if (!currentTurn) {
      currentTurn = newTurn(turns.length, ts, sessionModelLabel)
      turns.push(currentTurn)
    }
    return currentTurn
  }

  const startCall = (ts: number, idx: number): NormalizedMessage => {
    const call: NormalizedMessage = {
      role: "assistant",
      timestamp: ts,
      blocks: [],
      entryIndex: idx
    }
    assistantCalls.push(call)
    return call
  }

  for (const bubble of ordered) {
    const ts = isoToEpoch(bubble.createdAt, fallbackTs)
    const idx = entryIndex++
    const kind = bubbleKind(bubble)

    if (kind === "user") {
      const text = promptTextOf(bubble)
      const msg: NormalizedMessage = {
        role: "user",
        timestamp: ts,
        blocks: text ? [{ kind: "text", text }] : [],
        entryIndex: idx,
        usage: usageOf(bubble)
      }
      const turn = newTurn(turns.length, ts, sessionModelLabel)
      turn.userMessage = msg
      turn.entryStart = idx
      turn.entryEnd = idx
      turns.push(turn)
      currentTurn = turn
      pendingCall = null
      lastWasTool = false
      continue
    }

    const turn = ensureTurn(ts)
    if (turn.entryStart < 0) turn.entryStart = idx
    turn.entryEnd = idx

    // thinking + assistant text
    const blocks: ContentBlockView[] = []
    const thinking = bubble.thinking?.text
    if (typeof thinking === "string" && thinking.trim()) blocks.push({ kind: "thinking", text: thinking })
    const text = promptTextOf(bubble)
    if (text.trim()) blocks.push({ kind: "text", text })
    if (blocks.length > 0) {
      if (!pendingCall || lastWasTool) {
        pendingCall = startCall(ts, idx)
        turn.assistantCalls.push(pendingCall)
      }
      pendingCall.blocks.push(...blocks)
      mergeCall(pendingCall, bubble)
      lastWasTool = false
    }

    // tool call + result (one bubble holds both sides)
    const tool = bubble.toolFormerData
    if (tool && (tool.name || tool.toolCallId || tool.modelCallId)) {
      if (!pendingCall) {
        // tool as the first step of a run → its own call (claude-style)
        pendingCall = startCall(ts, idx)
        turn.assistantCalls.push(pendingCall)
      }
      // lastWasTool stays: consecutive tool bubbles share one call (parallel calls)
      const toolName = str(tool.name) || "tool"
      const callId = str(tool.toolCallId) || str(tool.modelCallId) || undefined
      const useBlock: ContentBlockView = {
        kind: "tool_use",
        toolName,
        input: parseToolField(tool.rawArgs ?? tool.params)
      }
      if (callId) useBlock.toolCallId = callId
      pendingCall.blocks.push(useBlock)

      const status = str(tool.status)
      const isError = status === "error" || status === "failed" || status === "cancelled"
      const resultBlock: ContentBlockView = {
        kind: "tool_result",
        toolName,
        text: toolResultText(tool.result)
      }
      if (callId) resultBlock.toolCallId = callId
      if (isError) resultBlock.isError = true
      const resultMsg: NormalizedMessage = {
        role: "toolResult",
        timestamp: ts,
        blocks: [resultBlock],
        entryIndex: idx,
        toolName
      }
      if (callId) resultMsg.toolCallId = callId
      if (isError) resultMsg.isError = true
      turn.toolResults.push(resultMsg)
      lastWasTool = true
      continue
    }

    if (blocks.length === 0) skipped++ // no renderable content (e.g. empty capability bubbles)
  }

  // per-turn rollups (usage totals + best model)
  for (const t of turns) {
    const usage = zeroUsage()
    for (const c of t.assistantCalls) {
      if (!c.usage) continue
      usage.input += c.usage.input
      usage.output += c.usage.output
      usage.cacheRead += c.usage.cacheRead
      usage.cacheWrite += c.usage.cacheWrite
    }
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    t.usage = usage
    const callModel = t.assistantCalls.find((c) => c.model)?.model
    if (callModel) t.model = callModel
  }

  const contextInfo = buildCursorContextInfo({
    composer: cd,
    bubbles: ordered,
    skipped,
    unreferenced,
    cwdSource: cwdInfo.source
  })

  return {
    meta,
    turns,
    // No timestamped non-message evidence exists in the store (statuses/times
    // only), so no events are fabricated.
    events: [],
    assistantCalls,
    contextInfo,
    // Always empty: no per-request usage is persisted (bubble tokenCount is
    // all-zero; promptTokenBreakdown is a single last-request snapshot that
    // has no request index/timestamp to attach a curve point to).
    contextPoints: [],
    name: str(cd?.name).trim() || meta.name,
    raw: { bubbleRows: ordered.length, skipped, unreferenced }
  }
}
