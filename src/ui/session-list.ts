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
  opencode: "opencode",
  cursor: "Cursor",
  vscode: "VS Code"
}

function toolName(tool: string): string {
  return TOOL_NAMES[tool] ?? tool
}

export function createSessionList(tool: AgentTool, project: string | null): ScreenInstance {
  let sel = 0
  const filter = createFuzzyFilter()

  function filtered(ctx: AppCtx): SessionMeta[] {
    const sessions = (ctx.sessionsByTool[tool] ?? []).filter(
      (s) => !project || (s.project || s.cwd || "(root)") === project
    )
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

    const titleWidth = Math.max(8, Math.floor((cols - 2) * 0.45))
    const viewportRows = Math.max(1, rows - (filter.open ? 6 : 5))
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
          content: "  " + "SESSION".padEnd(titleWidth) + "  MODEL · UPDATED · TOKENS · PATH",
          fg: ctx.theme.toolResult
        })
      )
      for (const [i, s] of visible.entries()) {
        const isSel = start + i === sel
        const title = truncate(s.name?.trim() || s.id.slice(0, 12), titleWidth).padEnd(titleWidth)
        const tokens = s.tokens.input + s.tokens.cacheRead
        const tokenLabel =
          tokens >= 1_000_000
            ? `${(tokens / 1_000_000).toFixed(1)}M`
            : tokens >= 1000
              ? `${(tokens / 1000).toFixed(1)}k`
              : String(tokens)
        const metadata = `${s.model ?? "—"} · ${s.updatedAt.slice(0, 10)} · ${tokenLabel}${s.compactionCount ? ` · ⚒${s.compactionCount}` : ""} · ${tildeHome(s.cwd || s.project)}`
        const row = `${isSel ? "▶ " : "  "}${title}  ${metadata}`
        container.add(
          new TextRenderable(ctx.renderer, {
            content: truncate(row, Math.max(1, cols - 1)),
            attributes: isSel ? TextAttributes.BOLD : 0,
            fg: isSel ? ctx.theme.accent : ctx.theme.fg
          })
        )
      }
    }

    renderKeyHint(
      ctx.renderer,
      container,
      [
        [`${sessions.length ? sel + 1 : 0}/${sessions.length} move`, "j/k"],
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
