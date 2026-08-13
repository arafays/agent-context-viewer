/**
 * Imperative session transcript viewer (port of session-detail.tsx).
 *
 * Builds the same LLine[]/RLine[] transcript as the React version, hops between
 * block tag lines with j/k, and opens a focused reader overlay (an internal
 * `ScreenInstance`) for any block's full content.
 */
import { BoxRenderable } from "@opentui/core"
import type {
  AgentSession,
  ContentBlockView,
  NormalizedMessage,
  SessionEventView,
  SessionMeta
} from "../adapters/types.ts"
import { type Line, renderHeader, renderKeyHint, renderLines } from "./framework.ts"
import { createReader, type ReaderContent } from "./reader.ts"
import type { AppCtx, JumpTarget, ScreenInstance } from "./screen.ts"
import type { Theme } from "./theme.ts"
import { tildeHome, wordWrap } from "./util.ts"

/** Max chars of a single message's text/thinking we materialise inline. */
const MAX_BLOCK_CHARS = 4000
/** Raw tool-result lines shown inline before the "Enter to expand" hint. */
const TOOL_RESULT_PREVIEW_LINES = 12
/** Soft cap on a tool result's full expanded body. */
const TOOL_RESULT_FULL_CAP = 200_000
/** Indent (columns) for body lines under their tag header. */
const BODY_INDENT = 2

type Kind =
  | "system"
  | "header"
  | "spacer"
  | "close"
  | "user"
  | "assistant"
  | "thinking"
  | "usage"
  | "toolUse"
  | "toolResult"
  | "hint"
  | "compaction"
  | "model"
  | "thinkingLvl"
  | "custom"
  | "note"

/** A logical (pre-wrap) transcript line. */
interface LLine {
  text: string
  color?: string
  dim?: boolean
  bold?: boolean
  kind: Kind
  turn: number
  /** true → this is a block header/tag line (bold label). */
  isTag?: boolean
  /** indentation for body lines (columns), 0 for tag/spacer. */
  indent?: number
  expand?: ReaderContent
}

/** A rendered (wrapped) transcript line. */
interface RLine extends LLine {
  cont: boolean
}

/** Semantic color roles, resolved from the live terminal theme. */
function C(t: Theme) {
  return {
    system: t.system,
    user: t.user,
    thinking: t.thinking,
    assistant: t.assistant,
    toolUse: t.toolUse,
    toolResult: t.toolResult,
    toolError: t.toolError,
    compaction: t.compaction,
    model: t.system,
    custom: t.custom,
    note: t.toolResult,
    hint: t.toolResult
  }
}

export function createSessionDetail(
  session: AgentSession,
  meta: SessionMeta,
  jump?: JumpTarget,
  fromProject?: string | null
): ScreenInstance {
  let showThinking = false
  let anchorIdx = 0 // position within `anchors` (jump targets)
  let reader: ScreenInstance | null = null
  let jumpApplied = false

  function buildLlines(theme: Theme): LLine[] {
    const c = C(theme)
    const out: LLine[] = []
    const spacer = (turn: number) => out.push({ text: "", kind: "spacer", turn, indent: 0 })
    // tag header for a block
    const tag: TagFn = (text, color, turn, kind, expand) =>
      out.push({ text, color, bold: true, kind, turn, isTag: true, indent: 0, expand })
    // one or more body lines (pre-wrap; wrapping happens later)
    const body: BodyFn = (text, color, dim, turn, kind, expand) =>
      out.push({ text, color, dim, kind, turn, indent: BODY_INDENT, expand })

    // leading system prompt — first jump target, expandable in the reader
    const sysPrompt = (session.contextInfo.systemPrompt ?? "").trim()
    if (sysPrompt) {
      const expand = { title: "system prompt", body: sysPrompt, color: c.system }
      tag(
        `system prompt${session.contextInfo.reconstructed ? " · reconstructed" : ""} · ${fmt(sysPrompt.length)} chars`,
        c.system,
        -1,
        "system",
        expand
      )
      spacer(-1)
    }

    for (const turn of session.turns) {
      // turn header
      const model = turn.model ?? "—"
      const mode = turn.thinkingLevel ? ` · think:${turn.thinkingLevel}` : ""
      const reqs = turn.assistantCalls.length
      const ctxTokens = turn.usage.input + turn.usage.cacheRead
      tag(
        `turn ${turn.index} · ${model}${mode} · ${reqs} req${reqs !== 1 ? "s" : ""} · ctx ${fmt(ctxTokens)}`,
        c.system,
        turn.index,
        "header"
      )

      // leading events
      if (turn.events.length) {
        for (const e of turn.events) buildEvent(out, e, turn.index, tag, body, c)
        spacer(turn.index)
      }

      // user prompt
      if (turn.userMessage) {
        appendMessage(out, turn.userMessage, turn.index, tag, body, c)
        spacer(turn.index)
      }

      for (let ai = 0; ai < turn.assistantCalls.length; ai++) {
        const call = turn.assistantCalls[ai]
        if (!call) continue

        // usage
        const input = call.usage?.input ?? 0
        const output = call.usage?.output ?? 0
        const cache = call.usage?.cacheRead ?? 0
        const cacheW = call.usage?.cacheWrite ?? 0
        const usage =
          cacheW > 0
            ? `in ${fmt(input)} · cache ${fmt(cache)} · cacheW ${fmt(cacheW)} · out ${fmt(output)}`
            : `in ${fmt(input)} · cache ${fmt(cache)} · out ${fmt(output)}`
        body(usage, c.toolResult, true, turn.index, "usage")
        out.push({ text: "", kind: "spacer", turn: turn.index, indent: 0 })

        // thinking — inline preview is capped, but the expanded reader gets the full text
        const thinkFull = collectBlocks(call.blocks, (b) => b.kind === "thinking" || b.kind === "reasoning")
        const thinkTxt = thinkFull.slice(0, MAX_BLOCK_CHARS)
        if (thinkTxt.trim()) {
          const expand = { title: "thinking", body: thinkFull, color: c.thinking }
          if (showThinking) {
            tag("thinking", c.thinking, turn.index, "thinking", expand)
            for (const l of thinkTxt.split("\n")) body(l, c.thinking, true, turn.index, "thinking", expand)
          } else {
            const preview = thinkFull.replace(/\s+/g, " ").trim().slice(0, 72)
            tag(`thinking · ${preview}${thinkFull.length > 72 ? "…" : ""}`, c.thinking, turn.index, "thinking", expand)
          }
          out.push({ text: "", kind: "spacer", turn: turn.index, indent: 0 })
        }

        // assistant text — inline preview is capped, expanded reader gets the full text
        const textFull = collectBlocks(call.blocks, (b) => b.kind === "text")
        const textTxt = textFull.slice(0, MAX_BLOCK_CHARS)
        if (textTxt.trim()) {
          const expand = { title: "assistant text", body: textFull, color: c.assistant }
          tag("assistant", c.assistant, turn.index, "assistant", expand)
          for (const l of textTxt.split("\n")) body(l, c.assistant, false, turn.index, "assistant", expand)
          out.push({ text: "", kind: "spacer", turn: turn.index, indent: 0 })
        }

        // tool calls (actions)
        for (const b of call.blocks) {
          if (b.kind !== "tool_use") continue
          const inputPreview = b.input ? truncateVisual(JSON.stringify(b.input) ?? String(b.input), 96) : "(no args)"
          const expand = {
            title: `tool call · ${b.toolName ?? "tool"}`,
            lang: "json",
            body: prettyToolInput(b.input),
            color: c.toolUse
          }
          tag(`tool · call · ${b.toolName ?? "tool"}(${inputPreview})`, c.toolUse, turn.index, "toolUse", expand)
        }

        // tool results — paired output of the actions. Inline preview is capped;
        // the expanded reader gets the full, uncapped text.
        for (const tr of turn.toolResults) {
          const fullRaw = tr.blocks.map((b) => b.text ?? "").join("\n")
          const previewSrc = fullRaw.slice(0, TOOL_RESULT_FULL_CAP)
          const raw = previewSrc.split("\n")
          const color = tr.isError ? c.toolError : c.toolResult
          const expand = { title: `tool result · ${tr.toolName ?? "tool"}`, body: fullRaw, color }
          tag(
            `result${tr.isError ? " · error" : ""} · ${tr.toolName ?? "tool"}`,
            color,
            turn.index,
            "toolResult",
            expand
          )
          for (const l of raw.slice(0, TOOL_RESULT_PREVIEW_LINES))
            body(l, color, true, turn.index, "toolResult", expand)
          const totalLines = fullRaw.split("\n").length
          const more = totalLines - TOOL_RESULT_PREVIEW_LINES
          if (more > 0)
            body(
              `+${more} more line${more === 1 ? "" : "s"} — Enter to expand`,
              c.hint,
              true,
              turn.index,
              "hint",
              expand
            )
          out.push({ text: "", kind: "spacer", turn: turn.index, indent: 0 })
        }
      }

      out.push({ text: "└─", color: c.toolResult, dim: true, kind: "close", turn: turn.index, indent: 0 })
      spacer(turn.index)
    }
    return out
  }

  function build(ctx: AppCtx): { rLines: RLine[]; anchors: number[] } {
    const cols = ctx.cols
    const llines = buildLlines(ctx.theme)

    // wrap each logical line to its available width (prefix 2 + indent)
    const rLines: RLine[] = []
    for (const ll of llines) {
      if (ll.kind === "spacer") {
        rLines.push({ ...ll, text: "", cont: false })
        continue
      }
      const ww = Math.max(4, cols - 2 - (ll.indent ?? 0))
      const segs = wordWrap(ll.text, ww)
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i] ?? ""
        rLines.push({ ...ll, text: seg, cont: i > 0 })
      }
    }

    // Jump targets: the block tag lines (system prompt, turn headers, user
    // prompt, thinking, assistant text, each tool call, each tool result,
    // events…). The cursor only ever rests on one of these; j/k hops between.
    const anchors: number[] = []
    for (let i = 0; i < rLines.length; i++) if (rLines[i]?.isTag) anchors.push(i)
    return { rLines, anchors }
  }

  return {
    render(container, ctx) {
      if (reader) {
        reader.render(container, ctx)
        return
      }

      const renderer = ctx.renderer
      const theme = ctx.theme
      const cols = ctx.cols
      const rows = ctx.rows

      const { rLines, anchors } = build(ctx)

      // Fuzzy-search jump: place the cursor on the first tag line of the matched
      // turn (turn headers are always tag lines, so the anchor exists).
      if (jump && !jumpApplied) {
        const idx = anchors.findIndex((a) => rLines[a]?.turn === jump.turn)
        if (idx >= 0) {
          anchorIdx = idx
          jumpApplied = true
        }
      }

      const cursor = anchors.length > 0 ? (anchors[Math.min(anchorIdx, anchors.length - 1)] ?? 0) : 0
      const safeCursor = Math.min(cursor, Math.max(0, rLines.length - 1))

      const viewportRows = Math.max(1, rows - 5)
      const half = Math.max(1, Math.floor(viewportRows / 2))
      const start = Math.max(0, Math.min(safeCursor - half, Math.max(0, rLines.length - viewportRows)))
      const visible = rLines.slice(start, start + viewportRows)

      const subtitle = `${meta.name ?? meta.id.slice(0, 8)}  ${tildeHome(meta.cwd || meta.project)} · ${session.turns.length} turns · ${session.assistantCalls.length} reqs · ${anchors.length} blocks`

      renderHeader(renderer, container, meta.name ?? meta.id.slice(0, 8), subtitle, theme, cols)

      const bodyBox = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: cols })
      const lines: Line[] = visible.map((line, i) => {
        const absIdx = start + i
        const isCursor = absIdx === safeCursor && !line.cont && line.kind !== "spacer"
        const indent = " ".repeat(line.indent ?? 0)
        return {
          text: indent + line.text,
          color: line.color,
          bold: line.bold || isCursor,
          dim: line.dim,
          cursor: isCursor
        }
      })
      renderLines(renderer, bodyBox, lines)
      container.add(bodyBox)

      renderKeyHint(
        renderer,
        container,
        [
          ["block", "j/k"],
          ["half page", "Ctrl-u/d"],
          ["top/bot", "g/G"],
          ["expand", "Enter"],
          ["context", "c"],
          ["sys prompt", "s"],
          ["files", "f"],
          ["thinking", "t"],
          ["help", "?"],
          ["back", "q"],
          ["quit app", "Q"]
        ],
        theme,
        cols
      )
    },

    handleKey(key, ctx) {
      if (reader) {
        reader.handleKey(key, ctx)
        return
      }

      const { rLines, anchors } = build(ctx)
      const n = anchors.length
      if (n === 0) return // nothing to hop between

      const viewportRows = Math.max(1, ctx.rows - 5)
      const half = Math.max(1, Math.floor(viewportRows / 2))

      if (key.name === "down" || key.name === "j") {
        anchorIdx = Math.min(anchorIdx + 1, n - 1)
        ctx.rerender()
      } else if (key.name === "up" || key.name === "k") {
        anchorIdx = Math.max(0, anchorIdx - 1)
        ctx.rerender()
      } else if (key.name === "pagedown" || (key.name === "d" && key.ctrl)) {
        anchorIdx = pageAnchor(anchors, anchorIdx, half)
        ctx.rerender()
      } else if (key.name === "pageup" || (key.name === "u" && key.ctrl)) {
        anchorIdx = pageAnchor(anchors, anchorIdx, -half)
        ctx.rerender()
      } else if (key.name === "home" || (key.name === "g" && !key.shift)) {
        anchorIdx = 0
        ctx.rerender()
      } else if (key.name === "end" || (key.name === "g" && key.shift)) {
        anchorIdx = n - 1
        ctx.rerender()
      } else if (key.name === "return" || key.name === "enter") {
        const cursor = anchors.length > 0 ? (anchors[Math.min(anchorIdx, anchors.length - 1)] ?? 0) : 0
        const safeCursor = Math.min(cursor, Math.max(0, rLines.length - 1))
        const rl = rLines[safeCursor]
        if (rl?.expand) {
          reader = createReader(rl.expand, () => {
            reader = null
            ctx.rerender()
          })
          ctx.rerender()
        }
      } else if (key.name === "t") {
        showThinking = !showThinking
        ctx.rerender()
      } else if (key.name === "c" && !key.ctrl) {
        ctx.openContext(session)
      } else if (key.name === "s") {
        ctx.openSysprompt(session)
      } else if (key.name === "f") {
        ctx.openFiles(session)
      } else if ((key.name === "q" || key.name === "escape") && !key.ctrl && !key.shift) {
        ctx.backFromDetail(meta, fromProject ?? null)
      }
    }
  }
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)
}

/**
 * Half-page (Ctrl-u/d, PgUp/PgDn) hop: jump to the anchor nearest to
 * `anchors[from] + delta` rendered lines, always moving at least one block.
 */
function pageAnchor(anchors: number[], from: number, delta: number): number {
  if (anchors.length === 0) return 0
  if (delta >= 0) {
    const target = (anchors[from] ?? 0) + delta
    for (let i = from + 1; i < anchors.length; i++) {
      if ((anchors[i] ?? Number.POSITIVE_INFINITY) >= target) return i
    }
    return anchors.length - 1
  }
  const target = (anchors[from] ?? 0) + delta
  for (let i = from - 1; i >= 0; i--) {
    if ((anchors[i] ?? Number.NEGATIVE_INFINITY) <= target) return i
  }
  return 0
}

function truncateVisual(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…"
}

function collectBlocks(blocks: ContentBlockView[], pred: (b: ContentBlockView) => boolean): string {
  return blocks
    .filter(pred)
    .map((b) => b.text ?? "")
    .join("\n")
}

function prettyToolInput(input: unknown): string {
  if (input == null) return "(no input)"
  try {
    return JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    return String(input)
  }
}

type TagFn = (text: string, color: string, turn: number, kind: Kind, expand?: ReaderContent) => void
type BodyFn = (text: string, color: string, dim: boolean, turn: number, kind: Kind, expand?: ReaderContent) => void

function appendMessage(
  out: LLine[],
  msg: NormalizedMessage,
  turnIdx: number,
  tag: TagFn,
  body: BodyFn,
  c: ReturnType<typeof C>
) {
  const full = msg.blocks
    .filter((b) => b.kind === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim()
  const txt = full.slice(0, MAX_BLOCK_CHARS)
  const isUser = msg.role === "user"
  const color = isUser ? c.user : c.note
  const expand = { title: isUser ? "user message" : "message", body: full, color }
  tag(isUser ? "user · prompt" : "message", color, turnIdx, isUser ? "user" : "note", expand)
  if (!txt) {
    body("(empty)", c.note, true, turnIdx, isUser ? "user" : "note", expand)
    return
  }
  for (const l of txt.split("\n")) body(l, color, !isUser, turnIdx, isUser ? "user" : "note", expand)
}

function buildEvent(
  out: LLine[],
  e: SessionEventView,
  turn: number,
  tag: TagFn,
  body: BodyFn,
  c: ReturnType<typeof C>
) {
  const detail = e.detail ?? ""
  const fullBody = typeof e.body === "string" ? e.body : detail
  if (e.kind === "compaction") {
    const expand = { title: "compaction", body: fullBody, color: c.compaction }
    tag("compaction", c.compaction, turn, "compaction", expand)
    body(detail, c.compaction, true, turn, "compaction", expand)
  } else if (e.kind === "model_change") {
    tag("model change", c.model, turn, "model")
    body(`model → ${detail}`, c.model, true, turn, "model")
  } else if (e.kind === "thinking_level_change") {
    tag("thinking level", c.model, turn, "thinkingLvl")
    body(`thinking → ${detail}`, c.model, true, turn, "thinkingLvl")
  } else if (e.kind === "branch_summary") {
    const expand = { title: "branch summary", body: fullBody, color: c.note }
    tag("branch summary", c.note, turn, "note", expand)
    body(detail, c.note, true, turn, "note", expand)
  } else if (e.kind === "label") {
    tag("label", c.note, turn, "note")
    body(detail, c.note, true, turn, "note")
  } else {
    const expand = { title: `event · ${classifyCustom(detail)}`, body: fullBody, color: c.custom }
    tag(`event · ${classifyCustom(detail)}`, c.custom, turn, "custom", expand)
    body(detail, c.custom, true, turn, "custom", expand)
  }
}

function classifyCustom(detail: string): string {
  const d = detail.toLowerCase()
  if (d.includes("skill") || d.includes("prompts:")) return "skill"
  if (d.includes("agents.md") || d.includes("agents") || d.includes("permission")) return "context file"
  if (d.includes("attachment")) return "attachment"
  if (d.startsWith("command:") || d.includes("command:")) return "command"
  if (d.includes("observation")) return "memory"
  if (d.includes("reflection")) return "memory"
  if (d.includes("web-search") || d.includes("web · search")) return "web search"
  if (d.includes("subagent") || d.includes("plannotator")) return "subagent"
  if (d.includes("bash") || d.includes("exec")) return "bash"
  if (d.includes("thread settings")) return "thread settings"
  if (d.includes("mode →")) return "mode"
  return "event"
}
