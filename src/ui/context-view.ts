import type { KeyEvent, Renderable } from "@opentui/core"
import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core"
import type { AgentSession } from "../adapters/types.ts"
import { buildRequestSteps, type CompactionInfo, type RequestStep, sessionCurve } from "../engine/context-diff.ts"
import { clamp, clampMove, clearChildren, renderHeader, renderKeyHint, windowStart } from "./framework.ts"
import type { AppCtx, ScreenInstance } from "./screen.ts"
import type { Theme } from "./theme.ts"

export function createContextView(session: AgentSession): ScreenInstance {
  const compactions: CompactionInfo[] = session.turns.flatMap((t) =>
    t.events
      .filter((e) => e.kind === "compaction")
      .map((e) => ({
        entryIndex: typeof e.entryIndex === "number" ? e.entryIndex : t.entryEnd,
        tokensBefore: typeof e.tokensBefore === "number" ? e.tokensBefore : 0,
        summary: String(e.summary ?? ""),
        readFiles: [],
        modifiedFiles: []
      }))
  )
  const steps = buildRequestSteps(session.contextPoints, compactions)
  const curve = sessionCurve(session.contextPoints, compactions)
  const maxCtx = curve.reduce((m, b) => Math.max(m, b.contextTokens), 0) || 1

  let reqSel = 0
  let showSnapshots = true

  function render(container: Renderable, ctx: AppCtx): void {
    clearChildren(container)
    const cols = ctx.cols
    const rows = ctx.rows
    reqSel = clamp(reqSel, steps.length)

    renderHeader(
      ctx.renderer,
      container,
      `Context — ${session.meta.id.slice(0, 8)}`,
      `${session.meta.cwd || session.meta.project} · ${steps.length} LLM requests`,
      ctx.theme,
      cols
    )

    const maxLineWidth = cols - 4
    const barWidth = Math.min(Math.max(cols - 40, 8), 26)
    const curveLines = curve.map((bar) => {
      const pct = bar.contextTokens / maxCtx
      const filled = Math.round(pct * barWidth)
      const empty = barWidth - filled
      const barStr = "█".repeat(filled) + "░".repeat(Math.max(0, empty))
      const compacted = bar.compacted ? " ⚒" : ""
      const raw = `#${String(bar.requestIndex).padStart(3)} ${barStr}  ${fmt(bar.contextTokens)}  in ${fmt(bar.input)}  cache ${fmt(bar.cacheRead)}${compacted}`
      const text = raw.length > maxLineWidth ? raw.slice(0, maxLineWidth - 1) + "…" : raw
      return { text, compacted: bar.compacted, requestIndex: bar.requestIndex }
    })

    const step = steps[reqSel]
    const detailLines = detailLinesFor(step)

    const body = new BoxRenderable(ctx.renderer, { flexDirection: "column", width: cols, flexGrow: 1 })
    container.add(body)

    body.add(
      new TextRenderable(ctx.renderer, {
        content: `TOKENS PER REQUEST (input+cacheRead) — max ${fmt(maxCtx)}`,
        fg: ctx.theme.toolResult,
        attributes: TextAttributes.BOLD
      })
    )

    const detailHeight = detailLines.length + 4
    const listBudget = Math.max(1, rows - 2 - 1 - 1 - detailHeight)
    const curveRows = showSnapshots ? Math.max(1, Math.floor(listBudget / 2)) : listBudget
    const curveStart = windowStart(reqSel, curveLines.length, curveRows)
    for (const c of curveLines.slice(curveStart, curveStart + curveRows)) {
      const selected = c.requestIndex === reqSel
      body.add(
        new TextRenderable(ctx.renderer, {
          content: `${selected ? ">" : " "} ${c.text}`,
          fg: c.compacted ? ctx.theme.warning : undefined,
          attributes: selected ? TextAttributes.BOLD : TextAttributes.DIM
        })
      )
    }

    const detail = new BoxRenderable(ctx.renderer, {
      flexDirection: "column",
      borderStyle: "rounded",
      borderColor: ctx.theme.border,
      padding: 1,
      width: cols
    })
    for (const l of detailLines) {
      const truncated = l.length > maxLineWidth ? l.slice(0, maxLineWidth - 1) + "…" : l
      detail.add(
        new TextRenderable(ctx.renderer, {
          content: truncated,
          fg: l.startsWith("╒") || l.startsWith("  cacheRead") ? ctx.theme.warning : undefined,
          attributes: l.startsWith("+") ? TextAttributes.BOLD : TextAttributes.DIM
        })
      )
    }
    body.add(detail)

    if (showSnapshots) {
      const snapshotRows = Math.max(1, listBudget - curveRows)
      const snapLines = snapshotLinesFor(step, ctx.theme)
      for (const m of snapLines.slice(0, snapshotRows)) {
        const truncated = m.text.length > maxLineWidth ? m.text.slice(0, maxLineWidth - 1) + "…" : m.text
        body.add(
          new TextRenderable(ctx.renderer, {
            content: truncated,
            fg: m.color,
            attributes: m.dim ? TextAttributes.DIM : TextAttributes.BOLD
          })
        )
      }
    } else {
      body.add(
        new TextRenderable(ctx.renderer, { content: "snapshots hidden (d to show)", attributes: TextAttributes.DIM })
      )
    }

    renderKeyHint(
      ctx.renderer,
      container,
      [
        ["request", "j/k"],
        ["snapshots", "d"],
        ["scroll req", "PgUp/PgDn"],
        ["system pr", "s"],
        ["back", "q"],
        ["quit app", "Q"]
      ],
      ctx.theme,
      cols
    )
  }

  function handleKey(key: KeyEvent, ctx: AppCtx): void {
    if (key.name === "down" || key.name === "j") reqSel = clampMove(reqSel, 1, steps.length)
    else if (key.name === "up" || key.name === "k") reqSel = clampMove(reqSel, -1, steps.length)
    else if (key.name === "pagedown") reqSel = clampMove(reqSel, 10, steps.length)
    else if (key.name === "pageup") reqSel = clampMove(reqSel, -10, steps.length)
    else if (key.name === "home") reqSel = clampMove(reqSel, -Number.MAX_SAFE_INTEGER, steps.length)
    else if (key.name === "end") reqSel = clampMove(reqSel, Number.MAX_SAFE_INTEGER, steps.length)
    else if (key.name === "s") {
      ctx.openSysprompt(session)
      return
    } else if (key.name === "d") showSnapshots = !showSnapshots
    else if ((key.name === "q" || key.name === "escape") && !key.ctrl && !key.shift) {
      ctx.backToDetail(session)
      return
    } else return
    ctx.rerender()
  }

  return { render, handleKey }
}

function detailLinesFor(step: RequestStep | undefined): string[] {
  if (!step) return ["(no request selected)"]
  const lines: string[] = []
  const isFirst = step.isFirst
  lines.push(
    `request #${step.index} · ctx ${fmt(step.point.contextTokens)} tokens (${isFirst ? "+" : ""}${fmt(step.tokenDelta)}) · ${step.point.contextMessages.length} messages in context`
  )
  lines.push(`+${step.added.length} added −${step.pruned.length} pruned  model ${step.point.model ?? "—"}`)
  if (step.compaction) {
    lines.push(`╒ compacted from ${fmt(step.compaction.tokensBefore)} tokens`)
    if (step.compaction.summary) lines.push(`  summary: ${step.compaction.summary.slice(0, 160)}`)
  }
  if (step.compactedAhead) lines.push("  cacheRead=0 (fresh after compaction)")
  return lines
}

function snapshotLinesFor(
  step: RequestStep | undefined,
  theme: Theme
): Array<{ text: string; color: string; dim: boolean }> {
  if (!step) return []
  const out: Array<{ text: string; color: string; dim: boolean }> = []
  for (const m of step.point.contextMessages) {
    const text = m.blocks
      .filter((b) => b.kind === "text" || b.kind === "thinking")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 180)
    if (m.role === "compactionSummary" || m.role === "branchSummary") {
      out.push({ text: `╒ summary: ${String(m.summary ?? "").slice(0, 180)}`, color: theme.warning, dim: false })
    } else if (m.role === "custom") {
      out.push({ text: `◈ custom ${m.customType ?? ""}`, color: theme.toolResult, dim: true })
    } else if (m.role === "toolResult") {
      out.push({
        text: `↩ ${m.toolName ?? "tool"}${m.isError ? " (error)" : ""}: ${text.slice(0, 140)}`,
        color: theme.toolResult,
        dim: true
      })
    } else if (m.role === "developer") {
      out.push({ text: `sys: ${text.slice(0, 140) || "(empty)"}`, color: theme.toolResult, dim: true })
    } else {
      const added = step.added.includes(m)
      out.push({ text: `${m.role}: ${text || "(empty)"}`, color: added ? theme.user : theme.fg, dim: !added })
    }
  }
  return out
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)
}
