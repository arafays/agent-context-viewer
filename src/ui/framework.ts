/**
 * Imperative OpenTUI core helpers shared by every screen.
 *
 * The app is rendered imperatively: each screen rebuilds its subtree into a
 * plain `BoxRenderable` container on every state change (no React reconciler).
 * This module provides the low-level primitives — line rendering, clearing,
 * header/key-hint chrome, selection math, and the inline fuzzy-filter state.
 */

import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core"
import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core"
import type { Theme } from "./theme.ts"

/** One rendered text row. `cursor` rows get a "▶ " prefix, others "  ". */
export interface Line {
  text: string
  /** resolved foreground color (hex). */
  color?: string
  bold?: boolean
  dim?: boolean
  cursor?: boolean
}

/** Bitflag attributes for a line's bold/dim styling. */
export function lineAttrs(l: { bold?: boolean; dim?: boolean }): number {
  return (l.bold ? TextAttributes.BOLD : 0) | (l.dim ? TextAttributes.DIM : 0)
}

/** Remove and destroy every child of a container (safe to re-add). */
export function clearChildren(container: Renderable): void {
  for (const child of container.getChildren()) {
    container.remove(child)
    child.destroyRecursively()
  }
}

/** Replace a container's children with one `TextRenderable` per line. */
export function renderLines(renderer: CliRenderer, container: Renderable, lines: Line[]): void {
  clearChildren(container)
  for (const l of lines) {
    const prefix = l.cursor ? "▶ " : "  "
    container.add(
      new TextRenderable(renderer, {
        content: prefix + l.text,
        fg: l.color,
        attributes: lineAttrs(l)
      })
    )
  }
}

/**
 * Two-row header: "◆ " (accent, bold) + title (bold) + subtitle (dim),
 * followed by a dim rule. Mirrors the React `Header` component.
 */
export function renderHeader(
  renderer: CliRenderer,
  container: Renderable,
  title: string,
  subtitle: string | undefined,
  theme: Theme,
  cols: number
): void {
  const avail = Math.max(0, cols - 4 - title.length - 2)
  let sub = subtitle ?? ""
  if (sub.length > avail) sub = sub.slice(0, Math.max(0, avail - 1)) + "…"

  const header = new BoxRenderable(renderer, { flexDirection: "column", width: cols })
  const row = new BoxRenderable(renderer, { flexDirection: "row", width: cols })
  row.add(new TextRenderable(renderer, { content: "◆ ", fg: theme.accent, attributes: TextAttributes.BOLD }))
  row.add(new TextRenderable(renderer, { content: title, attributes: TextAttributes.BOLD }))
  if (sub) row.add(new TextRenderable(renderer, { content: "  " + sub, attributes: TextAttributes.DIM }))
  header.add(row)
  header.add(new TextRenderable(renderer, { content: "─".repeat(Math.max(cols, 10)), attributes: TextAttributes.DIM }))
  container.add(header)
}

/** Single dim keybinding hint row, truncated to the terminal width. */
export function renderKeyHint(
  renderer: CliRenderer,
  container: Renderable,
  keys: Array<[string, string]>,
  theme: Theme,
  cols: number
): void {
  const items = keys.map(([label, k]) => `${label} ${k}`).join("  ")
  const maxLen = cols - 2
  const truncated = items.length > maxLen ? items.slice(0, Math.max(0, maxLen - 1)) + "…" : items
  container.add(new TextRenderable(renderer, { content: truncated, attributes: TextAttributes.DIM }))
}

/** Clamp an index to [0, count-1] (0 when count is 0). */
export function clamp(i: number, count: number): number {
  return Math.min(Math.max(0, i), Math.max(0, count - 1))
}

/** Move a selection by `delta`, clamped to [0, count-1]. */
export function clampMove(cur: number, delta: number, count: number): number {
  return clamp(cur + delta, count)
}

/**
 * Start index for a half-centered window of `viewport` rows over `count`
 * items, keeping the cursor visible.
 */
export function windowStart(cur: number, count: number, viewport: number): number {
  const half = Math.max(1, Math.floor(viewport / 2))
  return Math.max(0, Math.min(cur - half, Math.max(0, count - viewport)))
}

/** Inline fuzzy-filter state (open flag + query), shared by list screens. */
export interface FuzzyFilter {
  readonly open: boolean
  readonly query: string
  /** true when open with a non-blank query. */
  readonly active: boolean
  toggle(): void
  clear(): void
  /** Consume a key (escape/backspace/printable); returns true when handled. */
  handleKey(key: KeyEvent): boolean
}

export function createFuzzyFilter(): FuzzyFilter {
  let open = false
  let query = ""
  return {
    get open() {
      return open
    },
    get query() {
      return query
    },
    get active() {
      return open && query.trim().length > 0
    },
    toggle() {
      if (open) {
        open = false
        query = ""
      } else {
        open = true
      }
    },
    clear() {
      open = false
      query = ""
    },
    handleKey(key) {
      if (!open) return false
      if (key.name === "escape") {
        open = false
        query = ""
        return true
      }
      if (key.name === "backspace") {
        query = query.slice(0, -1)
        return true
      }
      if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
        query += key.sequence
        return true
      }
      return false
    }
  }
}
