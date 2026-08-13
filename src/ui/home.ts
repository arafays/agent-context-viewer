import type { KeyEvent, Renderable } from "@opentui/core"
import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core"
import { TOOLS } from "../adapters/registry.ts"
import type { AgentTool, SessionMeta, ToolInfo } from "../adapters/types.ts"
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
import { tildeHome } from "./util.ts"

export function groupByProject(sessions: SessionMeta[]): Array<{
  project: string
  count: number
  totalTokens: number
  lastActive: string
  sessions: SessionMeta[]
}> {
  const map = new Map<string, SessionMeta[]>()
  for (const s of sessions) {
    const key = s.project || s.cwd || "(root)"
    const arr = map.get(key) ?? []
    arr.push(s)
    map.set(key, arr)
  }
  return [...map.entries()]
    .map(([project, ss]) => ({
      project,
      count: ss.length,
      totalTokens: ss.reduce((a, b) => a + b.tokens.input + b.tokens.cacheRead, 0),
      lastActive: ss.reduce((latest, s) => (s.updatedAt > latest ? s.updatedAt : latest), ""),
      sessions: ss
    }))
    .sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1))
}

export function createHome(initialTool: AgentTool = "pi"): ScreenInstance {
  const tools = TOOLS
  let toolIdx = Math.max(
    0,
    tools.findIndex((t) => t.id === initialTool)
  )
  let projSel = 0
  const filter = createFuzzyFilter()

  function visibleGroups(ctx: AppCtx, tool: ToolInfo) {
    const sessions = ctx.sessionsByTool[tool.id] ?? []
    const groups = groupByProject(sessions)
    const index = ctx.searchIndex
    if (!filter.active || !index?.ready) return groups
    const ids = new Set(index.search(filter.query, tool.id).map((h) => h.meta.id))
    return groups.filter((g) => g.sessions.some((s) => ids.has(s.id)))
  }

  function openSelection(ctx: AppCtx): void {
    const tool = tools[toolIdx]
    if (!tool) return
    const groups = visibleGroups(ctx, tool)
    const s = projSel
    if (s === groups.length) ctx.openAll(tool.id)
    else {
      const g = groups[s]
      if (g) ctx.openProject(tool.id, g.project)
    }
  }

  function selectTool(d: number): void {
    toolIdx = (toolIdx + d + tools.length) % tools.length
    projSel = 0
  }

  function render(container: Renderable, ctx: AppCtx): void {
    clearChildren(container)
    const tool = tools[toolIdx]
    if (!tool) return
    const cols = ctx.cols
    const rows = ctx.rows
    const groups = visibleGroups(ctx, tool)
    const projCount = groups.length
    const totalRows = projCount + 1
    projSel = clamp(projSel, totalRows)

    renderHeader(
      ctx.renderer,
      container,
      "Agent Context Viewer",
      "how agents load context — system prompts · AGENTS.md · before/after per prompt",
      ctx.theme,
      cols
    )

    const borderPad = 4
    const paneWidth = Math.floor(cols / 2)
    const toolPaneWidth = Math.max(20, Math.min(30, paneWidth))
    const projPaneWidth = cols - toolPaneWidth
    const toolContentWidth = toolPaneWidth - borderPad
    const projContentWidth = projPaneWidth - borderPad
    const toolPaneInnerRows = Math.max(1, rows - 3 - 2 - 1)
    const projPaneInnerRows = Math.max(1, rows - 3 - 2 - 1)

    const mid = new BoxRenderable(ctx.renderer, { flexDirection: "row", flexGrow: 1, width: cols })
    container.add(mid)

    // Tool pane.
    const toolPane = new BoxRenderable(ctx.renderer, {
      flexDirection: "column",
      width: toolPaneWidth,
      borderStyle: "rounded",
      borderColor: ctx.theme.border
    })
    toolPane.add(
      new TextRenderable(ctx.renderer, { content: " TOOLS", attributes: TextAttributes.BOLD, fg: ctx.theme.toolResult })
    )
    const totalTools = tools.length
    let toolStart = 0
    if (totalTools > toolPaneInnerRows) {
      toolStart = Math.max(0, Math.min(toolIdx - Math.floor(toolPaneInnerRows / 2), totalTools - toolPaneInnerRows))
    }
    const visibleTools = tools.slice(toolStart, toolStart + toolPaneInnerRows)
    for (const [i, t] of visibleTools.entries()) {
      const sel = toolStart + i === toolIdx
      const n = ctx.sessionsByTool[t.id]?.length ?? 0
      const status = ctx.discovery[t.id] ?? "pending"
      const err = status === "error"
      const busy = !err && t.available && (status === "pending" || status === "loading")
      const countLabel = busy ? " …" : err ? " !" : n > 0 ? ` ${n}` : " —"
      const label = `${t.name}${countLabel}`
      const full = (sel ? "▶ " : "  ") + label
      const truncated = full.length > toolContentWidth ? full.slice(0, toolContentWidth - 1) + "…" : full
      toolPane.add(
        new TextRenderable(ctx.renderer, {
          content: busy ? `⠋ ${truncated}` : truncated,
          attributes: sel ? TextAttributes.BOLD : TextAttributes.DIM,
          fg: sel ? ctx.theme.accent : undefined
        })
      )
    }
    mid.add(toolPane)

    // Project pane.
    const projPane = new BoxRenderable(ctx.renderer, {
      flexDirection: "column",
      width: projPaneWidth,
      borderStyle: "rounded",
      borderColor: ctx.theme.border
    })
    projPane.add(
      new TextRenderable(ctx.renderer, {
        content: ` PROJECTS — ${tool.name} · ${projCount}${projCount === 1 ? " project" : " projects"}`,
        attributes: TextAttributes.BOLD,
        fg: ctx.theme.toolResult
      })
    )

    const projViewport = Math.max(1, projPaneInnerRows - (filter.open ? 1 : 0))
    const projStart = windowStart(projSel, totalRows, projViewport)

    if (filter.open) {
      const frow = new BoxRenderable(ctx.renderer, { flexDirection: "row", paddingLeft: 1, paddingRight: 1 })
      frow.add(
        new TextRenderable(ctx.renderer, { content: "/ ", fg: ctx.theme.accent, attributes: TextAttributes.BOLD })
      )
      frow.add(new TextRenderable(ctx.renderer, { content: filter.query || " " }))
      frow.add(new TextRenderable(ctx.renderer, { content: "▏", attributes: TextAttributes.DIM, fg: ctx.theme.border }))
      projPane.add(frow)
    }

    const projEnd = Math.min(projStart + projViewport, totalRows)
    for (let i = projStart; i < projEnd; i++) {
      if (i < projCount) {
        const g = groups[i]
        if (!g) continue
        const sel = i === projSel
        const tokens =
          g.totalTokens >= 1_000_000
            ? `${(g.totalTokens / 1_000_000).toFixed(1)}M`
            : g.totalTokens >= 1_000
              ? `${(g.totalTokens / 1_000).toFixed(1)}k`
              : String(g.totalTokens)
        const label = `${tildeHome(g.project)}  ${tokens} · ${g.count}s`
        const full = (sel ? "▶ " : "  ") + label
        const truncated = full.length > projContentWidth ? full.slice(0, projContentWidth - 1) + "…" : full
        projPane.add(
          new TextRenderable(ctx.renderer, {
            content: truncated,
            attributes: sel ? TextAttributes.BOLD : TextAttributes.DIM,
            fg: sel ? ctx.theme.accent : undefined
          })
        )
      } else {
        const sel = projSel === projCount
        const label = `${sel ? "▶ " : "  "}all ${tool.name} sessions`
        const truncated = label.length > projContentWidth ? label.slice(0, projContentWidth - 1) + "…" : label
        projPane.add(
          new TextRenderable(ctx.renderer, {
            content: truncated,
            attributes: sel ? TextAttributes.BOLD : TextAttributes.DIM,
            fg: sel ? ctx.theme.accent : undefined
          })
        )
      }
    }
    mid.add(projPane)

    renderKeyHint(
      ctx.renderer,
      container,
      [
        ["move", "j/k"],
        ["search", "/"],
        ["open", "Enter"],
        ["tool", "Tab/g/G"],
        ["quit", "q"],
        ["help", "?"],
        ["quit app", "Q"]
      ],
      ctx.theme,
      cols
    )
  }

  function handleKey(key: KeyEvent, ctx: AppCtx): void {
    if (filter.open && (key.name === "return" || key.name === "enter")) {
      openSelection(ctx)
      return
    }
    if (filter.handleKey(key)) {
      ctx.rerender()
      return
    }
    const tool = tools[toolIdx]
    if (!tool) return
    const totalRows = visibleGroups(ctx, tool).length + 1
    if (key.name === "down" || key.name === "j") {
      projSel = clampMove(projSel, 1, totalRows)
    } else if (key.name === "up" || key.name === "k") {
      projSel = clampMove(projSel, -1, totalRows)
    } else if (key.name === "return") {
      openSelection(ctx)
    } else if (key.name === "tab") {
      selectTool(1)
    } else if (key.name === "g" && !key.shift && !key.ctrl) {
      selectTool(-1)
    } else if (key.name === "g" && key.shift && !key.ctrl) {
      selectTool(1)
    } else if (key.name === "/") {
      filter.toggle()
    } else if ((key.name === "q" || key.name === "escape") && !key.ctrl) {
      if (filter.open) filter.toggle()
      else if (!key.shift) ctx.quit()
    } else {
      return
    }
    ctx.rerender()
  }

  return { render, handleKey }
}
