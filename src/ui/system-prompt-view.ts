import type { KeyEvent, Renderable } from "@opentui/core"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import type { AgentSession } from "../adapters/types.ts"
import { copyText } from "./clipboard.ts"
import { clearChildren, renderHeader, renderKeyHint } from "./framework.ts"
import type { AppCtx, ScreenInstance } from "./screen.ts"
import { wordWrap } from "./util.ts"

export function createSystemPromptView(session: AgentSession): ScreenInstance {
  const info = session.contextInfo

  const source =
    info.systemPromptSource ?? (info.systemPrompt ? (info.reconstructed ? "reconstructed" : "stored") : "unavailable")
  const labels = {
    stored: "exact — stored in the session",
    reconstructed: "reconstructed — see notes for per-section provenance",
    fragments: "persisted context fragments — full system prompt unavailable",
    unavailable: "unavailable — not persisted by this agent"
  }
  const meta = session.meta
  const lines: string[] = [
    `SYSTEM PROMPT (${labels[source]})`,
    `agent: ${meta.tool} · session: ${meta.id}`,
    `name: ${session.name ?? meta.name ?? "(unnamed)"}`,
    `directory: ${meta.cwd || "(unknown)"}`,
    `source: ${meta.path}`,
    `started: ${meta.startedAt} · updated: ${meta.updatedAt}`,
    `model: ${meta.model ?? "(unknown)"} · thinking: ${meta.thinkingLevel ?? "(unknown)"}`,
    `turns: ${session.turns.length} · requests: ${session.contextPoints.length} · compactions: ${meta.compactionCount}`
  ]
  lines.push(`tools: ${info.tools.join(", ") || "(none)"}`)
  lines.push(`context files: ${info.contextFiles.map((f) => f.path).join(" | ") || "(none)"}`)
  lines.push(`skills: ${info.skills.map((s) => s.name).join(", ") || "(none)"}`)
  if (info.notes.length) lines.push(`notes: ${info.notes.join("; ")}`)
  lines.push("")
  lines.push(...(info.systemPrompt || "No system prompt text is available for this session.").split("\n"))

  let copyStatus = ""
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
      copyStatus || `${session.meta.id.slice(0, 8)} · ${source}`,
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
      body.add(new TextRenderable(ctx.renderer, { content: l || " ", fg: ctx.theme.fg }))
    }
    container.add(body)

    renderKeyHint(
      ctx.renderer,
      container,
      [
        ["copy prompt", "y"],
        [`${Math.min(scroll, maxScroll) + 1}/${wrapped.length} lines`, "j/k"],
        ["page", "PgUp/PgDn"],
        ["back", "q"],
        ["quit app", "Q"]
      ],
      ctx.theme,
      cols
    )
  }

  function handleKey(key: KeyEvent, ctx: AppCtx): void {
    if (key.name === "y" && !key.ctrl && !key.meta) {
      copyStatus = copyText(ctx.renderer, info.systemPrompt)
      ctx.rerender()
      return
    }
    copyStatus = ""
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
