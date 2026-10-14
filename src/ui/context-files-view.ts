import type { KeyEvent, Renderable } from "@opentui/core"
import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core"
import type { AgentSession } from "../adapters/types.ts"
import { clamp, clampMove, clearChildren, renderHeader, renderKeyHint, windowStart } from "./framework.ts"
import type { AppCtx, ScreenInstance } from "./screen.ts"
import { tildeHome, wordWrap } from "./util.ts"

export function createContextFilesView(session: AgentSession): ScreenInstance {
  const info = session.contextInfo
  const files = info.contextFiles

  let fileSel = 0
  let contentScroll = 0
  let contentLen = 0

  function render(container: Renderable, ctx: AppCtx): void {
    clearChildren(container)
    const cols = ctx.cols
    const rows = ctx.rows
    fileSel = clamp(fileSel, files.length)
    const selectedFile = files[fileSel]

    renderHeader(
      ctx.renderer,
      container,
      "Context files",
      `${session.meta.id.slice(0, 8)}  ${files.length} file${files.length === 1 ? "" : "s"}`,
      ctx.theme,
      cols
    )

    const borderPad = 4
    const filePaneWidth = Math.floor(cols / 3)
    const contentPaneWidth = cols - filePaneWidth
    const fileContentWidth = filePaneWidth - borderPad
    const contentContentWidth = contentPaneWidth - borderPad

    const fileLines = files.map((f, i) => {
      const prefix = i === fileSel ? "▶ " : "  "
      const raw = `${f.global ? "[global]" : "       "} ${truncPath(tildeHome(f.path), fileContentWidth - 12)}`
      const full = prefix + raw
      const truncated = full.length > fileContentWidth ? full.slice(0, fileContentWidth - 1) + "…" : full
      return { path: f.path, text: truncated, sel: i === fileSel }
    })

    const fileViewportRows = Math.max(1, rows - 8)
    const fStart = windowStart(fileSel, fileLines.length, fileViewportRows)
    const visibleFiles = fileLines.slice(fStart, fStart + fileViewportRows)

    const content = selectedFile?.content ?? ""
    const maxContentWidth = contentContentWidth - 2
    const wrappedContent = selectedFile ? wordWrap(content, Math.max(8, maxContentWidth)) : []
    contentLen = wrappedContent.length
    const viewportRows = Math.max(1, rows - 8)
    const safeContentScroll = clamp(contentScroll, wrappedContent.length)
    const cStart = windowStart(safeContentScroll, wrappedContent.length, viewportRows)
    const visibleContent = wrappedContent.slice(cStart, cStart + viewportRows)

    const mid = new BoxRenderable(ctx.renderer, { flexDirection: "row", flexGrow: 1, width: cols })
    container.add(mid)

    const left = new BoxRenderable(ctx.renderer, {
      flexDirection: "column",
      width: filePaneWidth,
      borderStyle: "rounded",
      borderColor: ctx.theme.border,
      padding: 1
    })
    left.add(
      new TextRenderable(ctx.renderer, { content: " FILES", attributes: TextAttributes.BOLD, fg: ctx.theme.toolResult })
    )
    for (const f of visibleFiles) {
      left.add(
        new TextRenderable(ctx.renderer, {
          content: f.text,
          attributes: f.sel ? TextAttributes.BOLD : 0,
          fg: f.sel ? ctx.theme.accent : undefined
        })
      )
    }
    mid.add(left)

    const right = new BoxRenderable(ctx.renderer, {
      flexDirection: "column",
      width: contentPaneWidth,
      borderStyle: "rounded",
      borderColor: ctx.theme.border,
      padding: 1
    })
    right.add(
      new TextRenderable(ctx.renderer, {
        content: ` ${truncPath(tildeHome(selectedFile?.path ?? "(select a file)"), Math.max(1, contentContentWidth))}`,
        attributes: TextAttributes.BOLD,
        fg: ctx.theme.toolResult
      })
    )
    if (selectedFile) {
      for (const l of visibleContent) {
        right.add(new TextRenderable(ctx.renderer, { content: l || " ", fg: ctx.theme.fg }))
      }
    } else {
      right.add(
        new TextRenderable(ctx.renderer, {
          content: "select a file to view its content",
          fg: ctx.theme.toolResult,
          attributes: TextAttributes.DIM
        })
      )
    }
    mid.add(right)

    renderKeyHint(
      ctx.renderer,
      container,
      [
        [`${files.length ? fileSel + 1 : 0}/${files.length} files`, "j/k"],
        ["content", "PgUp/PgDn"],
        ["top/end", "Home/End"],
        ["back", "q"],
        ["quit app", "Q"]
      ],
      ctx.theme,
      cols
    )
  }

  function handleKey(key: KeyEvent, ctx: AppCtx): void {
    if (key.name === "down" || key.name === "j") {
      const next = clampMove(fileSel, 1, files.length)
      if (next !== fileSel) contentScroll = 0
      fileSel = next
    } else if (key.name === "up" || key.name === "k") {
      const next = clampMove(fileSel, -1, files.length)
      if (next !== fileSel) contentScroll = 0
      fileSel = next
    } else if (key.name === "pagedown")
      contentScroll = Math.min(Math.max(0, contentLen - 1), contentScroll + Math.max(1, ctx.rows - 8))
    else if (key.name === "pageup") contentScroll = Math.max(0, contentScroll - Math.max(1, ctx.rows - 8))
    else if (key.name === "home") contentScroll = 0
    else if (key.name === "end") contentScroll = contentLen
    else if ((key.name === "q" || key.name === "escape") && !key.ctrl && !key.shift) {
      ctx.backToDetail(session)
      return
    } else return
    ctx.rerender()
  }

  return { render, handleKey }
}

function truncPath(path: string, max: number): string {
  max = Math.max(1, max)
  if (path.length <= max) return path
  return max === 1 ? "…" : "…" + path.slice(-(max - 1))
}
