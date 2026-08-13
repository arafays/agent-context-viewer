import type { KeyEvent, Renderable } from "@opentui/core"
import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core"
import type { AgentTool, SessionMeta } from "../adapters/types.ts"
import {
  clamp,
  clampMove,
  clearChildren,
  createFuzzyFilter,
  renderHeader,
  renderKeyHint,
  windowStart
} from "./framework.ts"
import type { AppCtx, ScreenInstance } from "./screen.ts"
import { tildeHome, truncate } from "./util.ts"

const TOOL_NAMES: Record<string, string> = {
  pi: "Pi",
  codex: "Codex",
  claude: "Claude Code",
  opencode: "opencode"
}

function toolName(tool: string): string {
  return TOOL_NAMES[tool] ?? tool
}

export function createSessionList(tool: AgentTool, project: string | null): ScreenInstance {
  let sel = 0
  const filter = createFuzzyFilter()

  function filtered(ctx: AppCtx): SessionMeta[] {
    const sessions = ctx.sessionsByTool[tool] ?? []
    const index = ctx.searchIndex
    if (!filter.active || !index?.ready) return sessions
    const ids = new Set(index.search(filter.query, tool).map((h) => h.meta.id))
    return sessions.filter((s) => ids.has(s.id))
  }

  function render(container: Renderable, ctx: AppCtx): void {
    clearChildren(container)
    const cols = ctx.cols
    const rows = ctx.rows
    const sessions = filtered(ctx)
    const status = ctx.discovery[tool] ?? "pending"
    sel = clamp(sel, sessions.length)

    const subtitle = project
      ? `${project} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`
      : `all ${toolName(tool)} sessions · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`

    renderHeader(ctx.renderer, container, project ?? `All ${toolName(tool)} sessions`, subtitle, ctx.theme, cols)

    if (filter.open) {
      const frow = new BoxRenderable(ctx.renderer, { flexDirection: "row", paddingLeft: 1, paddingRight: 1 })
      frow.add(
        new TextRenderable(ctx.renderer, { content: "/ ", fg: ctx.theme.accent, attributes: TextAttributes.BOLD })
      )
      frow.add(new TextRenderable(ctx.renderer, { content: filter.query || " " }))
      frow.add(new TextRenderable(ctx.renderer, { content: "▏", attributes: TextAttributes.DIM, fg: ctx.theme.border }))
      container.add(frow)
    }

    const statsLen = 6 + 1 + 4 + 1 + 6 + 1 + 7
    const maxCompLen = sessions.reduce(
      (m, s) => Math.max(m, s.compactionCount > 0 ? ` ⚒${s.compactionCount}`.length : 0),
      0
    )
    const minPathLen = 12
    const longestModel = sessions.reduce((m, s) => Math.max(m, (s.model ?? "—").length), 0)
    const modelWidth = Math.max(6, Math.min(longestModel, cols - (2 + 1 + statsLen + maxCompLen + 2 + minPathLen)))

    const viewportRows = Math.max(1, rows - 7)
    const start = windowStart(sel, sessions.length, viewportRows)
    const visible = sessions.slice(start, start + viewportRows)

    if (visible.length === 0) {
      if (status === "pending" || status === "loading") {
        container.add(
          new TextRenderable(ctx.renderer, {
            content: "  ⠋ …",
            fg: ctx.theme.toolResult,
            attributes: TextAttributes.DIM
          })
        )
      } else if (status === "error") {
        container.add(
          new TextRenderable(ctx.renderer, {
            content: "  (discovery failed)",
            fg: ctx.theme.warning,
            attributes: TextAttributes.DIM
          })
        )
      } else {
        container.add(
          new TextRenderable(ctx.renderer, {
            content: "  (no sessions found)",
            fg: ctx.theme.toolResult,
            attributes: TextAttributes.DIM
          })
        )
      }
    } else {
      container.add(
        new TextRenderable(ctx.renderer, {
          content:
            "  " +
            "MODEL".padEnd(modelWidth) +
            " " +
            "DATE".padStart(6) +
            " " +
            "MSGS".padStart(4) +
            " " +
            "IN".padStart(6) +
            " " +
            "CACHE".padStart(7) +
            "  PATH",
          fg: ctx.theme.toolResult,
          attributes: TextAttributes.DIM
        })
      )
      for (const [i, s] of visible.entries()) {
        const absIdx = start + i
        const isSel = absIdx === sel
        const date = s.updatedAt.slice(0, 10).replace(/^(\d+)-(\d+)-(\d+).*$/, "$2/$3")
        const msgs = s.messageCount
        const inK = s.tokens.input >= 1000 ? `${(s.tokens.input / 1000).toFixed(1)}k` : String(s.tokens.input)
        const cacheK =
          s.tokens.cacheRead >= 1000 ? `${(s.tokens.cacheRead / 1000).toFixed(1)}k` : String(s.tokens.cacheRead)
        const comp = s.compactionCount > 0 ? ` ⚒${s.compactionCount}` : ""
        const prefix = isSel ? "▶ " : "  "
        const modelRaw = truncate(s.model ?? "—", modelWidth).padEnd(modelWidth)
        const statPart = `${date.padStart(6)} ${String(msgs).padStart(4)} ${inK.padStart(6)} ${cacheK.padStart(7)}${comp}`
        const fixedLen = prefix.length + modelRaw.length + 1 + statPart.length + 2
        const availForCwd = cols - fixedLen
        let cwd = tildeHome(s.cwd || s.project || "")
        if (cwd.length > Math.max(0, availForCwd)) {
          cwd = "…" + cwd.slice(-Math.max(2, availForCwd - 2))
        }
        const full = `${prefix}${modelRaw} ${statPart}  ${cwd}`
        const maxCol = Math.max(8, cols - 1)
        const truncated = full.length > maxCol ? full.slice(0, maxCol - 1) + "…" : full
        container.add(
          new TextRenderable(ctx.renderer, {
            content: truncated,
            attributes: isSel ? TextAttributes.BOLD : TextAttributes.DIM,
            fg: isSel ? ctx.theme.accent : undefined
          })
        )
      }
    }

    renderKeyHint(
      ctx.renderer,
      container,
      [
        ["scroll", "j/k"],
        ["search", "/"],
        ["open", "Enter"],
        ["back", "q"],
        ["quit app", "Q"]
      ],
      ctx.theme,
      cols
    )
  }

  function handleKey(key: KeyEvent, ctx: AppCtx): void {
    if (filter.open && (key.name === "return" || key.name === "enter")) {
      const m = filtered(ctx)[sel]
      if (m) ctx.openSession(m, undefined, project)
      return
    }
    if (filter.handleKey(key)) {
      ctx.rerender()
      return
    }
    const sessions = filtered(ctx)
    if (key.name === "down" || key.name === "j") sel = clampMove(sel, 1, sessions.length)
    else if (key.name === "up" || key.name === "k") sel = clampMove(sel, -1, sessions.length)
    else if (key.name === "pagedown") sel = clampMove(sel, 10, sessions.length)
    else if (key.name === "pageup") sel = clampMove(sel, -10, sessions.length)
    else if (key.name === "home") sel = clampMove(sel, -Number.MAX_SAFE_INTEGER, sessions.length)
    else if (key.name === "end") sel = clampMove(sel, Number.MAX_SAFE_INTEGER, sessions.length)
    else if (key.name === "return") {
      const m = sessions[sel]
      if (m) ctx.openSession(m, undefined, project)
    } else if (key.name === "/") {
      filter.toggle()
    } else if ((key.name === "q" || key.name === "escape") && !key.ctrl && !key.shift) {
      if (filter.open) filter.toggle()
      else ctx.goHome()
    } else {
      return
    }
    ctx.rerender()
  }

  return { render, handleKey }
}
