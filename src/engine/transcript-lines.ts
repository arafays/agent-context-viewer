/**
 * Flatten normalized session data into the single-line "searchable unit"
 * format written to the fff content index.
 *
 * Each message becomes two lines:
 *   - a header line: `[tool] [project] [model] [yyyy-mm-dd] [turn N] <tag>`
 *   - a content line: whitespace-collapsed message text, capped in length
 *
 * fff matches whole lines, so collapsing multi-line text to one line makes
 * each message exactly one match target and keeps per-session files well
 * under fff's max-file-size cap (10MB default).
 *
 * Odd line numbers are headers (they carry the `[turn N]`), even are content.
 */
import type { AgentTool, NormalizedMessage, SessionMeta, Turn } from "../adapters/types.ts"

/** Max chars of a collapsed content line (full text lives in the transcript). */
export const MAX_CONTENT_CHARS = 1000

export interface SearchableLine {
  /** 1-based line number within the session's search file. */
  lineNo: number
  /** header line text */
  header: string
  /** content line text ("" for events with no body) */
  content: string
}

/** Tag for a normalized message. */
export function messageTag(msg: NormalizedMessage): string {
  switch (msg.role) {
    case "user":
      return "user"
    case "assistant":
      return "assistant"
    case "toolResult":
      return msg.toolName ? `tool result: ${msg.toolName}` : "tool result"
    case "compactionSummary":
      return "compaction"
    case "branchSummary":
      return "branch summary"
    case "developer":
      return "developer"
    default:
      return "message"
  }
}

/** All text blocks of a message joined (text/thinking/tool result bodies). */
export function messageText(msg: NormalizedMessage): string {
  const parts: string[] = []
  for (const b of msg.blocks) {
    if (b.kind === "tool_use") {
      parts.push(`tool call: ${b.toolName ?? "tool"} ${JSON.stringify(b.input ?? "")}`)
    } else if (b.kind === "image") {
      parts.push("[image]")
    } else if (b.text) {
      parts.push(b.text)
    }
  }
  return parts.join("\n").trim()
}

/** Collapse multi-line text to a single line, capped, with a [±N lines] marker. */
export function collapse(text: string, max = MAX_CONTENT_CHARS): string {
  const trimmed = text.trim()
  if (!trimmed) return ""
  const newlines = trimmed.split("\n").length - 1
  let line = trimmed.replace(/\s+/g, " ").trim()
  if (newlines > 0) line += ` [+${newlines} more lines]`
  if (line.length > max) line = line.slice(0, max - 1) + "…"
  return line
}

/** Header line for one message in the search file. */
export function searchHeader(meta: SessionMeta, turn: number, tag: string): string {
  const model = meta.model ?? "—"
  const date = meta.updatedAt.slice(0, 10)
  return `[${meta.tool}] [${meta.project || meta.cwd || "?"}] [${model}] [${date}] [turn ${turn}] ${tag}`
}

/** Content line for one message in the search file. */
export function searchContent(text: string): string {
  return collapse(text)
}

/**
 * Incrementally builds the search-file text for a session. Adapters use this
 * during discovery (which already parses every file for counters) so the fuzzy
 * index is populated without paying a full loadSession cost.
 */
export class SearchFileBuilder {
  private lines: string[] = []
  private constructor(private meta: SessionMeta) {}

  static start(meta: SessionMeta): SearchFileBuilder {
    const b = new SearchFileBuilder(meta)
    // session identity line pair (0) — makes name/id/tool/project searchable
    // even for sessions with no messages, and gives every file ≥ 2 lines.
    const identity = meta.name && meta.name !== meta.project ? `${meta.name} — ${meta.id}` : meta.id
    b.emit(0, "session", identity)
    return b
  }

  /** Emit one message as a header/content pair in the given turn. */
  emit(turn: number, tag: string, content: string): void {
    this.lines.push(searchHeader(this.meta, turn, tag))
    this.lines.push(searchContent(content))
  }

  /** Raw text appended verbatim (used for event bodies that span a message). */
  get isEmpty(): boolean {
    return this.lines.length === 0
  }

  toString(): string {
    return this.lines.length === 0 ? "" : this.lines.join("\n") + "\n"
  }
}

/**
 * Build the searchable lines for a fully-loaded session (header/content pairs,
 * interleaved). Used when a session is loaded anyway (e.g. from the detail
 * screen) to refresh its index file with full fidelity.
 */
export function sessionSearchLines(
  meta: SessionMeta,
  turns: Turn[],
  opts?: { startTurn?: number; endTurn?: number; systemPrompt?: string }
): SearchableLine[] {
  const start = opts?.startTurn ?? 0
  const end = opts?.endTurn ?? turns.length - 1
  const out: SearchableLine[] = []
  let lineNo = 0

  const push = (header: string, content: string) => {
    lineNo++
    out.push({ lineNo, header, content })
  }

  // system prompt is the first searchable unit (labeled [system], before any turns)
  const sp = opts?.systemPrompt?.trim()
  if (sp) {
    const model = meta.model ?? "—"
    const date = meta.updatedAt.slice(0, 10)
    push(
      `[${meta.tool}] [${meta.project || meta.cwd || "?"}] [${model}] [${date}] [system] system prompt`,
      collapse(sp)
    )
  }

  for (const turn of turns) {
    if (turn.index < start || turn.index > end) continue
    const model = turn.model ?? "—"
    const date = turn.timestamp ? new Date(turn.timestamp).toISOString().slice(0, 10) : meta.updatedAt.slice(0, 10)
    const header = (tag: string) =>
      `[${meta.tool}] [${meta.project || meta.cwd || "?"}] [${model}] [${date}] [turn ${turn.index}] ${tag}`

    // leading events (model changes, compaction, custom, bash exec…)
    for (const e of turn.events) {
      const detail = e.detail ?? ""
      const body =
        typeof (e as { body?: string }).body === "string" ? ((e as { body?: string }).body as string) : detail
      push(header(`event: ${e.kind}`), collapse(body || detail))
    }

    if (turn.userMessage) {
      const m = turn.userMessage
      push(header(messageTag(m)), collapse(messageText(m)))
    }

    for (const call of turn.assistantCalls) {
      // usage line
      const u = call.usage
      push(
        header("usage"),
        u
          ? `in ${u.input} · out ${u.output} · cache ${u.cacheRead}${u.cacheWrite ? ` · cacheW ${u.cacheWrite}` : ""}`
          : "usage n/a"
      )
      // thinking blocks
      const thinking = call.blocks
        .filter((b) => b.kind === "thinking" || b.kind === "reasoning")
        .map((b) => b.text ?? "")
        .join("\n")
      if (thinking.trim()) {
        push(header("thinking"), collapse(thinking))
      }
      // assistant text
      const text = call.blocks
        .filter((b) => b.kind === "text")
        .map((b) => b.text ?? "")
        .join("\n")
      if (text.trim()) {
        push(header("assistant"), collapse(text))
      }
      // tool calls
      for (const b of call.blocks) {
        if (b.kind === "tool_use") {
          push(header(`tool call: ${b.toolName ?? "tool"}`), collapse(JSON.stringify(b.input ?? "")))
        }
      }
    }

    for (const tr of turn.toolResults) {
      const text = tr.blocks.map((b) => b.text ?? "").join("\n")
      push(header(messageTag(tr)), collapse(text))
    }
  }
  return out
}

/** Serialize SearchableLine[] to file text. */
export function searchLinesToText(lines: SearchableLine[]): string {
  return lines.map((l) => `${l.header}\n${l.content}\n`).join("")
}

/** Whether a tool is a file-based adapter whose sessions load cheaply. */
export function isFileBasedTool(tool: AgentTool): boolean {
  return tool === "pi" || tool === "claude" || tool === "codex"
}
