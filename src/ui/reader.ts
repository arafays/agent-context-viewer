/**
 * Imperative focused block reader (port of reader.tsx).
 *
 * Full-screen, word-wrapped, vim-style pager with a visible cursor. Rendered
 * directly into the screen container as an opaque overlay by its parent.
 */
import { BoxRenderable } from "@opentui/core"
import { type Line, renderHeader, renderKeyHint, renderLines } from "./framework.ts"
import type { AppCtx, ScreenInstance } from "./screen.ts"
import { wordWrap } from "./util.ts"

/** Payload for the focused block reader. */
export interface ReaderContent {
  title: string
  subtitle?: string
  body: string
  /** optional language label (e.g. "json") shown next to the title */
  lang?: string
  /** base foreground color for the body */
  color?: string
}

/**
 * Full-screen focused reader for a single block's content. Word-wrapped and
 * scrollable with a visible cursor (vim-style j/k, g/G, PgUp/PgDn, Home/End).
 * `onBack` is invoked on q/Esc.
 */
export function createReader(content: ReaderContent, onBack: () => void): ScreenInstance {
  let cursor = 0

  // 2 for the left gutter (cursor indicator), 1 to avoid touching the right edge.
  function wrappedLines(cols: number): string[] {
    return wordWrap(content.body, Math.max(10, cols - 3))
  }

  return {
    render(container, ctx) {
      const renderer = ctx.renderer
      const theme = ctx.theme
      const cols = ctx.cols
      const rows = ctx.rows
      const lines = wrappedLines(cols)

      const viewportRows = Math.max(1, rows - 5)
      // Pager-style: keep the cursor visible. While the cursor fits in the first
      // viewport the text stays put and the cursor walks down; once it would scroll
      // off the bottom, the viewport advances to keep it on the last row.
      let start: number
      if (lines.length <= viewportRows) {
        start = 0
      } else if (cursor < viewportRows) {
        start = 0
      } else {
        start = cursor - viewportRows + 1
      }
      const visible = lines.slice(start, start + viewportRows)
      const cursorRow = cursor - start // row within the visible window, -1 if off

      const header = content.lang ? `${content.title} · ${content.lang}` : content.title
      const pct = lines.length > 0 ? Math.round(((cursor + 1) / lines.length) * 100) : 0
      const subtitle = content.subtitle ?? `${cursor + 1}/${lines.length} lines · ${pct}%`
      const maxHintWidth = Math.max(0, cols - 4)
      const hintTitle = header.length > maxHintWidth ? header.slice(0, Math.max(1, maxHintWidth - 1)) + "…" : header

      renderHeader(renderer, container, hintTitle, subtitle, theme, cols)

      const bodyBox = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, width: cols })
      const bodyLines: Line[] = visible.map((text, i) => {
        const isCursor = i === cursorRow
        return { text: text || "", color: content.color ?? theme.fg, dim: true, bold: isCursor, cursor: isCursor }
      })
      renderLines(renderer, bodyBox, bodyLines)
      container.add(bodyBox)

      renderKeyHint(
        renderer,
        container,
        [
          ["scroll", "j/k ↑↓"],
          ["page", "PgUp/PgDn"],
          ["top/bottom", "g/G / Home/End"],
          ["back", "q/Esc"],
          ["quit", "Q"]
        ],
        theme,
        cols
      )
    },

    handleKey(key, ctx) {
      const lines = wrappedLines(ctx.cols)
      const max = Math.max(0, lines.length - 1)
      const page = Math.max(1, ctx.rows - 5)
      if (key.name === "down" || key.name === "j") cursor = Math.min(cursor + 1, max)
      else if (key.name === "up" || key.name === "k") cursor = Math.max(0, cursor - 1)
      else if (key.name === "pagedown" || (key.name === "d" && key.ctrl)) cursor = Math.min(cursor + page, max)
      else if (key.name === "pageup" || (key.name === "u" && key.ctrl)) cursor = Math.max(0, cursor - page)
      else if (key.name === "home" || (key.name === "g" && !key.shift)) cursor = 0
      else if (key.name === "end" || (key.name === "g" && key.shift)) cursor = max
      else if ((key.name === "q" || key.name === "escape") && !key.ctrl && !key.shift) {
        onBack()
        return
      } else return
      ctx.rerender()
    }
  }
}
