/**
 * Claude Code adapter — reads sessions from ~/.claude/projects/<slug>/*.jsonl.
 *
 * Per-request data is exact (stored inline):
 *   - assistant.message.usage → input/cache_read/cache_creation/output tokens
 *   - assistant.message.model/provider
 *   - user messages (content string or blocks; tool results are user messages
 *     with tool_result blocks)
 *   - mode entries → plan/code mode changes, ai-title → session name
 *
 * Prompt context (see ./context.ts): newer sessions record the EXACT system
 * prompt in `prompt_snapshot` attachments (text blocks + cliPrefix + tool
 * list), plus exact `instructions` (CLAUDE.md/AGENTS.md contents),
 * `skill_listing`, and `agent_listing_delta` attachments. Older sessions have
 * none of these — the proprietary base prompt is then NOT reconstructed;
 * only recoverable context (context-file hierarchy, skills/agents/commands on
 * disk) is composed, each section labeled with its source in `notes`.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { isFresh as cacheIsFresh, type MetaCache, metaCacheKey } from "../../engine/meta-cache.ts"
import { SearchFileBuilder } from "../../engine/transcript-lines.ts"
import type {
  AgentSession,
  ContentBlockView,
  ContextPoint,
  NormalizedMessage,
  SessionContextInfo,
  SessionEventView,
  SessionMeta,
  Turn,
  UsageTotals
} from "../types.ts"
import {
  buildClaudeContextInfo,
  captureAttachment,
  emptyEvidence,
  normalizeSnapshots,
  type SessionEvidence,
  snapshotPromptAt
} from "./context.ts"

const SCAN_BYTES = 64 * 1024
const zeroUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })

/** Claude Code config dir: CLAUDE_CONFIG_DIR → ~/.claude. */
export function getConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR
  return env ? env : join(homedir(), ".claude")
}

export function getProjectsDir(): string {
  return join(getConfigDir(), "projects")
}

type RawLine = {
  type?: string
  sessionId?: string
  cwd?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  message?: {
    role?: string
    content?: unknown
    usage?: Record<string, number>
    model?: string
    provider?: string
    stop_reason?: string
    id?: string
  }
  mode?: string
  permissionMode?: string
  aiTitle?: string
  uuid?: string
  parentUuid?: string
  userType?: string
  [k: string]: unknown
}

function parseLine(line: string): RawLine | null {
  try {
    const o = JSON.parse(line) as RawLine
    if (o && typeof o === "object") return o
  } catch {
    /* tolerate malformed lines */
  }
  return null
}

function readHeaderLines(path: string): string[] {
  try {
    const fd = openSync(path, "r")
    try {
      const buf = Buffer.alloc(SCAN_BYTES)
      const n = readSync(fd, buf, 0, SCAN_BYTES, 0)
      const text = buf.subarray(0, n).toString("utf8")
      const lines = text.split("\n").slice(0, 40)
      return lines.filter((l) => l.trim().length > 0)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
}

function headerInfo(path: string): { id: string; cwd: string; timestamp: string } {
  let id = basename(path).replace(/\.jsonl$/, "")
  let cwd = ""
  let timestamp = ""
  for (const line of readHeaderLines(path)) {
    const o = parseLine(line)
    if (!o) continue
    if (o.sessionId) id = o.sessionId
    if (typeof o.cwd === "string" && o.cwd) cwd = o.cwd
    if (typeof o.timestamp === "string" && o.timestamp && !timestamp) timestamp = o.timestamp
    if (id && cwd && timestamp) break
  }
  return { id, cwd, timestamp }
}

function readAll(path: string): string {
  const fd = openSync(path, "r")
  try {
    const st = statSync(path)
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off)
      if (n <= 0) break
      off += n
    }
    return buf.toString("utf8")
  } finally {
    closeSync(fd)
  }
}

function walkSessionFiles(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walkSessionFiles(full, out)
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full)
  }
}

/** Discovery: header parse + cheap full-pass counters (no message tree). */
export function discoverSessions(cache?: MetaCache): SessionMeta[] {
  const dir = getProjectsDir()
  if (!existsSync(dir)) return []
  const files: string[] = []
  walkSessionFiles(dir, files)
  const metas: SessionMeta[] = []
  for (const path of files) {
    try {
      const st = statSync(path)
      const { id, cwd, timestamp } = headerInfo(path)
      const ts = timestamp || st.mtime.toISOString()
      const project = cwd.split("/").filter(Boolean).pop() ?? "unknown"
      // Cache hit: reuse the parsed meta (counters + searchText) without a
      // full read + line-parse of the file.
      if (cache) {
        const key = metaCacheKey({ tool: "claude", project, id })
        const entry = cache.read(key)
        if (entry && cacheIsFresh(entry, st.size, st.mtimeMs)) {
          metas.push({ ...entry.meta!, path, updatedAt: st.mtime.toISOString(), sizeBytes: st.size })
          continue
        }
      }

      let messageCount = 0
      let user = 0
      let assistant = 0
      let toolResults = 0
      let compactionCount = 0
      let lastModel: string | undefined
      let title: string | undefined
      let turn = 0
      let lastAssistantKey: string | null = null
      const tokens = zeroUsage()
      const text = readAll(path)
      const metaBase: SessionMeta = {
        tool: "claude",
        id,
        path,
        cwd,
        project,
        startedAt: ts,
        updatedAt: st.mtime.toISOString(),
        sizeBytes: st.size,
        thinkingLevel: undefined,
        messageCount: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolResults: 0,
        tokens,
        compactionCount: 0,
        customTypes: [],
        model: undefined,
        name: undefined
      }
      const searchBuilder = SearchFileBuilder.start(metaBase)
      text.split("\n").forEach((line, lineNo) => {
        const o = parseLine(line)
        if (!o) return
        if (o.type === "assistant" && !o.isSidechain) {
          const u = o.message?.usage
          // mirror load's usage-key grouping so assistantMessages matches the
          // merged assistantCall count (Claude emits one entry per block)
          const key = u
            ? `${num(u.input_tokens)}|${num(u.cache_read_input_tokens)}|${num(u.cache_creation_input_tokens)}|${num(u.output_tokens)}`
            : `n/a|${lineNo}`
          if (key !== lastAssistantKey) {
            assistant++
            lastAssistantKey = key
          }
          messageCount++
          if (typeof o.message?.model === "string") lastModel = o.message.model
          if (u) {
            tokens.input += num(u.input_tokens)
            tokens.output += num(u.output_tokens)
            tokens.cacheRead += num(u.cache_read_input_tokens)
            tokens.cacheWrite += num(u.cache_creation_input_tokens)
          }
          // assistant text (content may be a string or blocks; a single
          // assistant entry is one LLM message → one search unit)
          const content = o.message?.content
          const emitTurn = Math.max(0, turn - 1)
          if (typeof content === "string" && content.trim()) {
            searchBuilder.emit(emitTurn, "assistant", content)
          } else if (Array.isArray(content)) {
            const parts: string[] = []
            for (const b of content as CBlock[]) {
              if (b.type === "text" && b.text) parts.push(b.text)
              else if (b.type === "thinking" && (b.thinking || b.text)) parts.push(b.thinking || b.text || "")
              else if (b.type === "tool_use")
                parts.push(`tool call: ${b.name ?? "tool"} ${JSON.stringify(b.input ?? "")}`)
            }
            const joined = parts.join("\n").trim()
            if (joined) searchBuilder.emit(emitTurn, "assistant", joined)
          }
        } else if (o.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim() && !title) {
          title = o.aiTitle.trim()
        } else if (o.type === "user" && !o.isMeta && !o.isSidechain) {
          const content = o.message?.content
          if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === "tool_result")) {
            toolResults++
            messageCount++
            // tool result text → searchable
            const parts: string[] = []
            for (const b of content as CBlock[]) {
              if (b.type === "text" && b.text) parts.push(b.text)
              else if (b.type === "tool_result") {
                const inner = Array.isArray(b.content)
                  ? (b.content as Array<{ type?: string; text?: string }>).map((x) => x.text ?? "").join("\n")
                  : typeof b.content === "string"
                    ? b.content
                    : ""
                if (inner) parts.push(inner)
              }
            }
            const joined = parts.join("\n").trim()
            if (joined) searchBuilder.emit(Math.max(0, turn - 1), "tool result", joined)
          } else {
            user++
            messageCount++
            if (typeof content === "string" && content.trim()) {
              searchBuilder.emit(turn, "user", content)
            } else if (Array.isArray(content)) {
              const parts: string[] = []
              for (const b of content as CBlock[]) {
                if (b.type === "text" && b.text) parts.push(b.text)
              }
              const joined = parts.join("\n").trim()
              if (joined) searchBuilder.emit(turn, "user", joined)
            }
            turn++
          }
        } else if (isCompactionEntry(o)) {
          compactionCount++
        }
      })
      tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
      const searchText = searchBuilder.toString()
      const meta: SessionMeta = {
        tool: "claude",
        id,
        path,
        cwd,
        project,
        startedAt: ts,
        updatedAt: st.mtime.toISOString(),
        sizeBytes: st.size,
        thinkingLevel: undefined,
        messageCount,
        userMessages: user,
        assistantMessages: assistant,
        toolResults,
        tokens,
        compactionCount,
        customTypes: compactionCount ? [{ type: "compaction", count: compactionCount }] : [],
        model: lastModel,
        name: title ?? project,
        ...(searchText ? { searchText } : {})
      }
      if (cache) {
        cache.write(metaCacheKey({ tool: "claude", project, id }), {
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          meta
        })
      }
      metas.push(meta)
    } catch {
      /* skip unreadable */
    }
  }
  metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  return metas
}

// ---------------------------------------------------------------------------
// full load
// ---------------------------------------------------------------------------

type CBlock = {
  type?: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
  content?: unknown
  is_error?: boolean
}

function blockView(b: CBlock): ContentBlockView | null {
  switch (b.type) {
    case "text":
      return { kind: "text", text: typeof b.text === "string" ? b.text : "" }
    case "thinking":
      return {
        kind: "thinking",
        text: typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : ""
      }
    case "redacted_thinking":
      // The raw payload is a redacted cipher blob under `data`; surface a visible
      // placeholder so the transcript shows that thinking was redacted.
      return { kind: "thinking", text: "[thinking redacted]" }
    case "tool_use":
      return {
        kind: "tool_use",
        toolName: typeof b.name === "string" ? b.name : "tool",
        toolCallId: typeof b.id === "string" ? b.id : undefined,
        input: b.input
      }
    case "tool_result": {
      const inner = Array.isArray(b.content)
        ? (b.content as Array<{ type?: string; text?: string }>)
            .map((x) => (typeof x.text === "string" ? x.text : ""))
            .join("\n")
        : typeof b.content === "string"
          ? b.content
          : ""
      return {
        kind: "tool_result",
        toolCallId:
          typeof (b as { tool_use_id?: string }).tool_use_id === "string"
            ? (b as { tool_use_id?: string }).tool_use_id
            : typeof b.id === "string"
              ? b.id
              : undefined,
        text: inner,
        isError: b.is_error === true
      }
    }
    case "image":
      return { kind: "image", text: "[image]" }
    default:
      return { kind: "unknown" }
  }
}

/** Claude persists compaction as a system entry with subtype compaction/summarization
 *  (older versions: a top-level type compaction/summary). */
function isCompactionEntry(o: RawLine): boolean {
  const subtype = typeof o.subtype === "string" ? o.subtype : ""
  if (subtype === "compaction" || subtype === "summarization") return true
  if (o.type === "compaction" || o.type === "summary") return true
  return false
}

function compactionSummaryOf(o: RawLine): string | null {
  if (!isCompactionEntry(o)) return null
  if (typeof o.summary === "string" && o.summary.trim()) return o.summary.trim()
  const content = o.message?.content
  if (typeof content === "string" && content.trim()) return content.trim().slice(0, 500)
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content as CBlock[]) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text)
    }
    const joined = parts.join("\n").trim()
    if (joined) return joined.slice(0, 500)
  }
  return "compaction"
}

function contentToBlocks(content: unknown): ContentBlockView[] {
  if (typeof content === "string") {
    const trimmed = content.trim()
    if (!trimmed) return []
    return [{ kind: "text", text: content }]
  }
  if (Array.isArray(content)) {
    const blocks: ContentBlockView[] = []
    for (const b of content as CBlock[]) {
      const v = blockView(b)
      if (v) blocks.push(v)
    }
    return blocks
  }
  return []
}

function isCommandWrapper(content: unknown): string | null {
  const s = typeof content === "string" ? content : ""
  const m = s.match(/<command-name>\s*([^<]+)\s*<\/command-name>/)
  return m ? m[1]!.trim() : null
}

export function loadSession(path: string): AgentSession {
  const st = statSync(path)
  const text = readAll(path)
  const lines = text.split("\n")

  const events: SessionEventView[] = []
  const turns: Turn[] = []
  const assistantCalls: NormalizedMessage[] = []
  const evidence: SessionEvidence = emptyEvidence()
  let name: string | undefined
  let currentMode = "code"
  let cwd = ""
  let sessionId = basename(path).replace(/\.jsonl$/, "")
  let gitBranch = ""
  let startedAt = st.mtime.toISOString()
  let currentModel: string | null = null
  let currentTurn: Turn | null = null
  const currentThinking: string | null = null
  /** raw assistant entries awaiting usage-grouping (Claude emits one entry per block) */
  const rawAssistants: Array<{ o: RawLine; lineNo: number; ts: number; turn: Turn }> = []
  /** line numbers of compaction entries — context points trim to messages after the last one */
  const compactionLines: number[] = []

  const ensureTurn = (ts: number): Turn => {
    if (!currentTurn) {
      const t: Turn = {
        index: turns.length,
        timestamp: ts,
        userMessage: null,
        assistantCalls: [],
        toolResults: [],
        events: [],
        usage: zeroUsage(),
        model: currentModel,
        thinkingLevel: currentThinking,
        entryStart: 0,
        entryEnd: 0
      }
      currentTurn = t
      turns.push(t)
      return t
    }
    return currentTurn
  }

  const normMessage = (
    o: RawLine,
    role: NormalizedMessage["role"],
    entryIndex: number,
    extra?: Partial<NormalizedMessage>
  ): NormalizedMessage => {
    const ts = isoToEpoch(o.timestamp, st.mtime.getTime())
    const blocks = contentToBlocks(o.message?.content)
    const u = o.message?.usage
    const usage: UsageTotals | undefined = u
      ? {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
          total:
            num(u.input_tokens) +
            num(u.output_tokens) +
            num(u.cache_read_input_tokens) +
            num(u.cache_creation_input_tokens)
        }
      : undefined
    const model = typeof o.message?.model === "string" ? o.message.model : undefined
    const provider = typeof o.message?.provider === "string" ? o.message.provider : undefined
    return {
      role,
      timestamp: ts,
      blocks,
      usage,
      model: provider && model ? `${provider}/${model}` : model,
      provider,
      stopReason: o.message?.stop_reason,
      entryIndex,
      ...extra
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const o = parseLine(lines[i] ?? "")
    if (!o) continue
    const lineNo = i + 1
    const ts = isoToEpoch(o.timestamp, st.mtime.getTime())

    switch (o.type) {
      case "mode": {
        const mode = typeof o.mode === "string" ? o.mode : ""
        if (mode && mode !== currentMode) {
          currentMode = mode
          const turn = ensureTurn(ts)
          turn.events.push({ kind: "custom", timestamp: ts, detail: `mode → ${mode}` })
        }
        break
      }
      case "permission-mode":
        break
      case "ai-title":
        if (typeof o.aiTitle === "string" && o.aiTitle.trim()) name = o.aiTitle.trim()
        break
      case "user": {
        if (o.isMeta || o.isSidechain) break
        const content = o.message?.content
        const isToolResult = Array.isArray(content) && content.some((b) => (b as CBlock).type === "tool_result")
        const turn = ensureTurn(ts)
        if (isToolResult) {
          const norm = normMessage(o, "toolResult", lineNo)
          turn.toolResults.push(norm)
          turn.entryEnd = lineNo
        } else {
          const cmd = isCommandWrapper(content)
          const norm = normMessage(o, "user", lineNo, cmd ? { customType: `command:${cmd}` } : undefined)
          if (cmd) {
            // replace raw <command-name>… XML with a compact ⌘ line
            const s2 = typeof content === "string" ? content : ""
            const args = (s2.match(/<command-args>([\s\S]*?)<\/command-args>/) ?? [])[1]?.trim() ?? ""
            norm.blocks = [{ kind: "text", text: `⌘ ${cmd}${args ? " " + args : ""}` }]
          }
          currentTurn = {
            index: turns.length,
            timestamp: ts,
            userMessage: norm,
            assistantCalls: [],
            toolResults: [],
            events: [],
            usage: zeroUsage(),
            model: currentModel,
            thinkingLevel: currentThinking,
            entryStart: lineNo,
            entryEnd: lineNo
          }
          turns.push(currentTurn)
          if (cmd) {
            currentTurn.events.push({ kind: "custom", timestamp: ts, detail: `command: ${cmd}` })
          }
        }
        break
      }
      case "assistant": {
        if (o.isSidechain) break
        const turn = ensureTurn(ts)
        if (typeof o.message?.model === "string") currentModel = o.message.model
        rawAssistants.push({ o, lineNo, ts, turn })
        turn.entryEnd = lineNo
        break
      }
      case "attachment": {
        const turn = ensureTurn(ts)
        const att =
          typeof o.attachment === "object" && o.attachment !== null
            ? (o.attachment as Record<string, unknown>)
            : undefined
        const attType = typeof att?.type === "string" ? att.type : "attachment"
        turn.events.push({ kind: "custom", timestamp: ts, detail: `attachment: ${attType}` })
        captureAttachment(evidence, att, lineNo)
        break
      }
      case "system":
      case "compaction":
      case "summary": {
        const summary = compactionSummaryOf(o)
        if (summary !== null) {
          compactionLines.push(lineNo)
          const turn = ensureTurn(ts)
          turn.events.push({ kind: "compaction", timestamp: ts, detail: "compaction", summary })
          turn.entryEnd = lineNo
        }
        break
      }
      case "queue-operation":
      case "file-history-snapshot":
      case "file-history-delta":
      case "last-prompt":
      default:
        break
    }
  }
  if (currentTurn) currentTurn.entryEnd = lines.length

  // ---- group consecutive assistant entries with identical usage into one LLM request ----
  interface AssistantGroup {
    firstLine: number
    ts: number
    blocks: ContentBlockView[]
    usage: UsageTotals
    model: string | undefined
    provider: string | undefined
    stopReason: string | undefined
    turn: Turn
  }
  const groups: AssistantGroup[] = []
  {
    let cur: AssistantGroup | null = null
    let curKey = ""
    const flush = () => {
      if (cur) {
        groups.push(cur)
        cur = null
      }
    }
    for (const ra of rawAssistants) {
      const o = ra.o
      const u = o.message?.usage
      const key = u
        ? `${u.input_tokens}|${u.cache_read_input_tokens}|${u.cache_creation_input_tokens}|${u.output_tokens}`
        : `n/a|${ra.lineNo}`
      const blocks = contentToBlocks(o.message?.content)
      const turn = ra.turn
      if (cur && curKey === key && cur.turn === turn) {
        cur.blocks.push(...blocks)
        continue
      }
      flush()
      cur = {
        firstLine: ra.lineNo,
        ts: ra.ts,
        blocks,
        usage: u
          ? {
              input: num(u.input_tokens),
              output: num(u.output_tokens),
              cacheRead: num(u.cache_read_input_tokens),
              cacheWrite: num(u.cache_creation_input_tokens),
              total: 0
            }
          : zeroUsage(),
        model: typeof o.message?.model === "string" ? o.message.model : undefined,
        provider: typeof o.message?.provider === "string" ? o.message.provider : undefined,
        stopReason: o.message?.stop_reason,
        turn
      }
      curKey = key
    }
    flush()
  }

  for (const g of groups) {
    g.usage.total = g.usage.input + g.usage.output + g.usage.cacheRead + g.usage.cacheWrite
    const model = g.provider && g.model ? `${g.provider}/${g.model}` : g.model
    const norm: NormalizedMessage = {
      role: "assistant",
      timestamp: g.ts,
      blocks: g.blocks,
      usage: g.usage,
      model,
      provider: g.provider,
      stopReason: g.stopReason,
      entryIndex: g.firstLine
    }
    g.turn.assistantCalls.push(norm)
    g.turn.usage.input += g.usage.input
    g.turn.usage.output += g.usage.output
    g.turn.usage.cacheRead += g.usage.cacheRead
    g.turn.usage.cacheWrite += g.usage.cacheWrite
    g.turn.usage.total += g.usage.total
    if (!g.turn.model && model) g.turn.model = model
    assistantCalls.push(norm)
  }

  // pull cwd/sessionId/git from any line that carries them
  let firstTs = ""
  for (const line of lines) {
    const o = parseLine(line)
    if (o?.cwd) cwd = o.cwd
    if (o?.sessionId) sessionId = o.sessionId
    if (typeof o?.gitBranch === "string") gitBranch = o.gitBranch
    if (!firstTs && typeof o?.timestamp === "string" && o.timestamp) firstTs = o.timestamp
    if (o?.type === "user" && o.timestamp) {
      startedAt = o.timestamp
      break
    }
  }
  // align with discovery (first timestamp in the file) when no user message exists
  if (startedAt === st.mtime.toISOString() && firstTs) startedAt = firstTs

  // ---- context points: one per assistant call, before = prior messages ----
  const snapshots = normalizeSnapshots(evidence.promptSnapshots)
  const contextPoints: ContextPoint[] = []
  const ordered: Array<{ line: number; msg: NormalizedMessage }> = []
  const pushOrdered = (m: NormalizedMessage) => ordered.push({ line: m.entryIndex, msg: m })
  for (const turn of turns) {
    if (turn.userMessage) pushOrdered(turn.userMessage)
    for (const t of turn.toolResults) pushOrdered(t)
    for (const a of turn.assistantCalls) pushOrdered(a)
  }
  // stable sort by line (preserve within-turn order)
  ordered.sort((a, b) => a.line - b.line || 0)

  for (let k = 0; k < assistantCalls.length; k++) {
    const call = assistantCalls[k]!
    // trim to messages after the most recent compaction (Claude clears cache on compaction)
    let lastCompaction = -1
    for (const c of compactionLines) {
      if (c < call.entryIndex) lastCompaction = c
      else break
    }
    const before = ordered.filter((x) => x.line > lastCompaction && x.line < call.entryIndex).map((x) => x.msg)
    const turnIndex = turns.findIndex((t) => t.assistantCalls.includes(call))
    const usage: UsageTotals = call.usage ?? zeroUsage()
    // full context sent to the model = fresh input + cache reads + cache writes
    // (Claude's input_tokens excludes cache_creation_input_tokens)
    contextPoints.push({
      requestIndex: k,
      turnIndex: Math.max(0, turnIndex),
      timestamp: call.timestamp,
      model: call.model ?? null,
      thinkingLevel: currentThinking,
      usage,
      contextTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      systemPrompt: snapshotPromptAt(snapshots, call.entryIndex),
      contextMessages: before
    })
  }

  // prompt context (exact prompt_snapshot/instructions/skill/agent attachments
  // when present, otherwise composed from disk) — see ./context.ts
  const project = cwd.split("/").filter(Boolean).pop() ?? "unknown"
  const meta: SessionMeta = {
    tool: "claude",
    id: sessionId,
    path,
    cwd,
    project,
    startedAt,
    updatedAt: st.mtime.toISOString(),
    sizeBytes: st.size,
    name: name ?? project,
    model: currentModel ?? undefined,
    thinkingLevel: currentThinking ?? undefined,
    messageCount: ordered.length,
    userMessages: ordered.filter((x) => x.msg.role === "user").length,
    assistantMessages: assistantCalls.length,
    toolResults: ordered.filter((x) => x.msg.role === "toolResult").length,
    tokens: {
      input: assistantCalls.reduce((s, c) => s + (c.usage?.input ?? 0), 0),
      output: assistantCalls.reduce((s, c) => s + (c.usage?.output ?? 0), 0),
      cacheRead: assistantCalls.reduce((s, c) => s + (c.usage?.cacheRead ?? 0), 0),
      cacheWrite: assistantCalls.reduce((s, c) => s + (c.usage?.cacheWrite ?? 0), 0)
    },
    compactionCount: compactionLines.length,
    customTypes: compactionLines.length ? [{ type: "compaction", count: compactionLines.length }] : []
  }

  const observedTools = [
    ...new Set(
      assistantCalls.flatMap((c) => c.blocks.filter((b) => b.kind === "tool_use").map((b) => b.toolName ?? ""))
    )
  ]
    .filter(Boolean)
    .sort()

  const contextInfo: SessionContextInfo = buildClaudeContextInfo({
    cwd,
    configDir: getConfigDir(),
    evidence,
    observedTools,
    gitBranch
  })

  return {
    meta,
    turns,
    events: [...events, ...turns.flatMap((t) => t.events)],
    assistantCalls,
    contextInfo,
    contextPoints,
    name: name ?? project,
    raw: { contextFiles: contextInfo.contextFiles }
  } satisfies AgentSession
}

function isoToEpoch(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback
  const t = Date.parse(ts)
  return Number.isNaN(t) ? fallback : t
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}
