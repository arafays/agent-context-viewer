import type { KeyEvent, Renderable } from "@opentui/core"
import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core"
import type { AgentSession } from "../adapters/types.ts"
import { clearChildren, renderHeader, renderKeyHint } from "./framework.ts"
import type { AppCtx, ScreenInstance } from "./screen.ts"
import { wordWrap } from "./util.ts"

export function createSystemPromptView(session: AgentSession): ScreenInstance {
  const info = session.contextInfo

  const lines: string[] = []
  lines.push(
    `SYSTEM PROMPT (${info.reconstructed ? "reconstructed — AGENTS.md/CLAUDE.md as of today" : "exact — stored inline in the session"})`
  )
  lines.push(`tools: ${info.tools.join(", ")}`)
  lines.push(`context files: ${info.contextFiles.map((f) => f.path).join(" | ") || "(none)"}`)
  lines.push(`skills: ${info.skills.map((s) => s.name).join(", ") || "(none)"}`)
  if (info.notes.length) lines.push(`notes: ${info.notes.join("; ")}`)
  lines.push("")
  lines.push(...info.systemPrompt.split("\n"))

  let scroll = 0
  let wrapped: string[] = []
  let maxScroll = 0

  function render(container: Renderable, ctx: AppCtx): void {
    clearChildren(container)
    const cols = ctx.cols
    const rows = ctx.rows

    renderHeader(
      ctx.renderer,
      container,
      "System prompt",
      `${session.meta.id.slice(0, 8)}  ${info.reconstructed ? "reconstructed" : "exact"} · ${lines.length} lines`,
      ctx.theme,
      cols
    )

    const wrapWidth = Math.max(8, cols - 2)
    wrapped = lines.flatMap((l) => wordWrap(l, wrapWidth))
    const viewportRows = Math.max(1, rows - 5)
    maxScroll = Math.max(0, wrapped.length - viewportRows)
    const start = Math.max(0, Math.min(scroll, maxScroll))
    const visible = wrapped.slice(start, start + viewportRows)

    const body = new BoxRenderable(ctx.renderer, { flexDirection: "column", flexGrow: 1, width: cols, paddingLeft: 1 })
    for (const l of visible) {
      body.add(new TextRenderable(ctx.renderer, { content: l || " ", attributes: TextAttributes.DIM }))
    }
    container.add(body)

    renderKeyHint(
      ctx.renderer,
      container,
      [
        ["scroll", "j/k"],
        ["back", "q"],
        ["quit app", "Q"]
      ],
      ctx.theme,
      cols
    )
  }

  function handleKey(key: KeyEvent, ctx: AppCtx): void {
    if (key.name === "down" || key.name === "j") scroll = Math.min(scroll + 1, maxScroll)
    else if (key.name === "up" || key.name === "k") scroll = Math.max(0, scroll - 1)
    else if (key.name === "pagedown") scroll = Math.min(scroll + 10, maxScroll)
    else if (key.name === "pageup") scroll = Math.max(0, scroll - 10)
    else if (key.name === "home") scroll = 0
    else if (key.name === "end") scroll = maxScroll
    else if ((key.name === "q" || key.name === "escape") && !key.shift) {
      ctx.backToDetail(session)
      return
    } else return
    ctx.rerender()
  }

  return { render, handleKey }
}
