import type { KeyEvent, Renderable } from "@opentui/core"
import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core"
import type { SearchHit, SearchIndex } from "../engine/search-index.ts"
import { clamp, clampMove, clearChildren, renderHeader, renderKeyHint, windowStart } from "./framework.ts"
import type { AppCtx, ScreenInstance } from "./screen.ts"

export function createSearchPanel(): ScreenInstance {
  let query = ""
  let sel = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let lastCtx: AppCtx | null = null
  let pollingDone = false

  function computeHits(index: SearchIndex | null): SearchHit[] {
    if (!index || !index.ready || !query.trim()) return []
    return index.search(query)
  }

  function render(container: Renderable, ctx: AppCtx): void {
    clearChildren(container)
    lastCtx = ctx

    if (timer === null && !pollingDone) {
      timer = setInterval(() => {
        if (lastCtx?.searchIndex?.ready || lastCtx?.searchIndex?.error) {
          pollingDone = true
          if (timer) {
            clearInterval(timer)
            timer = null
          }
        }
        lastCtx?.rerender()
      }, 200)
    }

    const cols = ctx.cols
    const rows = ctx.rows
    const index = ctx.searchIndex
    const ready = index?.ready ?? false
    const hits = computeHits(index)
    sel = clamp(sel, hits.length)

    const status = !index
      ? "index building…"
      : index.error
        ? `index error: ${index.error}`
        : !ready
          ? "waiting for index…"
          : query.trim()
            ? `${hits.length} session${hits.length === 1 ? "" : "s"}`
            : "type to fuzzy-search session content"

    renderHeader(ctx.renderer, container, "Fuzzy search", status, ctx.theme, cols)

    const frow = new BoxRenderable(ctx.renderer, { flexDirection: "row", paddingLeft: 1, paddingRight: 1 })
    frow.add(new TextRenderable(ctx.renderer, { content: "/ ", fg: ctx.theme.accent, attributes: TextAttributes.BOLD }))
    frow.add(new TextRenderable(ctx.renderer, { content: query || " " }))
    frow.add(new TextRenderable(ctx.renderer, { content: "▏", attributes: TextAttributes.DIM, fg: ctx.theme.border }))
    container.add(frow)

    const viewportRows = Math.max(1, rows - 7)
    const start = windowStart(sel, hits.length, viewportRows)
    const visible = hits.slice(start, start + viewportRows)

    const list = new BoxRenderable(ctx.renderer, {
      flexDirection: "column",
      flexGrow: 1,
      width: cols,
      paddingLeft: 1,
      paddingRight: 1
    })
    if (visible.length === 0) {
      list.add(
        new TextRenderable(ctx.renderer, {
          content: "  (no matches)",
          attributes: TextAttributes.DIM,
          fg: ctx.theme.toolResult
        })
      )
    } else {
      for (const [i, h] of visible.entries()) {
        const absIdx = start + i
        const isSel = absIdx === sel
        const prefix = isSel ? "▶ " : "  "
        const label = `${h.meta.project || "?"} · ${h.meta.tool}${h.meta.name ? ` · ${h.meta.name}` : ""}${h.turn > 0 ? ` · turn ${h.turn}` : ""}`
        const line = h.line.replace(/\s+/g, " ").trim()
        const row = `${prefix}${label} — ${line}`
        const maxCol = Math.max(8, cols - 1)
        const truncated = row.length > maxCol ? row.slice(0, maxCol - 1) + "…" : row
        list.add(
          new TextRenderable(ctx.renderer, {
            content: truncated,
            attributes: isSel ? TextAttributes.BOLD : TextAttributes.DIM,
            fg: isSel ? ctx.theme.accent : undefined
          })
        )
      }
    }
    container.add(list)

    renderKeyHint(
      ctx.renderer,
      container,
      [
        ["select", "j/k"],
        ["open (jump)", "Enter"],
        ["close", "q/Esc"]
      ],
      ctx.theme,
      cols
    )
  }

  function handleKey(key: KeyEvent, ctx: AppCtx): void {
    lastCtx = ctx
    const index = ctx.searchIndex
    const hits = computeHits(index)

    if (key.name === "escape" || (key.name === "q" && !key.shift)) {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      ctx.closeSearch()
      return
    }
    if (key.name === "backspace") {
      query = query.slice(0, -1)
      ctx.rerender()
      return
    }
    if (key.name === "down" || key.name === "j") {
      sel = clampMove(sel, 1, hits.length)
      ctx.rerender()
      return
    }
    if (key.name === "up" || key.name === "k") {
      sel = clampMove(sel, -1, hits.length)
      ctx.rerender()
      return
    }
    if (key.name === "pagedown") {
      sel = clampMove(sel, 10, hits.length)
      ctx.rerender()
      return
    }
    if (key.name === "pageup") {
      sel = clampMove(sel, -10, hits.length)
      ctx.rerender()
      return
    }
    if (key.name === "home") {
      sel = 0
      ctx.rerender()
      return
    }
    if (key.name === "end") {
      sel = clamp(hits.length - 1, hits.length)
      ctx.rerender()
      return
    }
    if (key.name === "return" || key.name === "enter") {
      const h = hits[sel]
      if (h) {
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        ctx.openSession(h.meta, { turn: h.turn })
        ctx.closeSearch()
      }
      return
    }
    if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
      query = query + key.sequence
      ctx.rerender()
      return
    }
  }

  return { render, handleKey }
}
