import type { CliRenderer, TerminalColors } from "@opentui/core"

/**
 * Theme resolution from the terminal's actual color palette.
 *
 * OpenTUI resolves named colors like "blue" to fixed sRGB hex (#0000FF), which
 * is unreadable on many dark themes. Instead we ask the renderer for the real
 * ANSI palette (via OSC queries) and derive a readable set of semantic colors
 * that adapts to whether the background is light or dark.
 *
 * Each semantic role prefers the brighter ANSI variant of its hue (standard
 * practice on dark backgrounds), but only when it clears a minimum WCAG
 * contrast ratio against the detected background. Colors that are genuinely
 * too close to the background — the classic #0000FF-on-black case — fall back
 * to the terminal's default foreground so text is always readable.
 */

export interface Theme {
  /** main readable foreground (falls back to terminal default fg) */
  fg: string
  /** dim/muted text — readable but quieter than fg */
  dim: string
  /** faintest emphasis — section headers, cursors, key hints */
  muted: string
  /** accent used for selection / active item */
  accent: string
  /** borders and secondary chrome */
  border: string
  user: string
  assistant: string
  thinking: string
  system: string
  toolUse: string
  toolResult: string
  toolError: string
  compaction: string
  custom: string
  warning: string
  /** explicit default fg/bg (hex) if the terminal reported them */
  defaultFg: string | null
  defaultBg: string | null
  /** true when we're showing a light-on-dark scheme */
  dark: boolean
  /** all 16 detected ANSI colors (may contain nulls) */
  ansi: (string | null)[]
}

/** ANSI index → our semantic hue. */
const IDX = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  brightRed: 9,
  brightGreen: 10,
  brightYellow: 11,
  brightBlue: 12,
  brightMagenta: 13,
  brightCyan: 14,
  brightWhite: 15
} as const

/** Fallback ANSI colors when the terminal can't answer the OSC query. */
const FALLBACK_DARK: Record<number, [number, number, number]> = {
  0: [30, 30, 30],
  1: [230, 80, 80],
  2: [90, 200, 120],
  3: [220, 190, 70],
  4: [90, 160, 220],
  5: [210, 140, 220],
  6: [80, 200, 220],
  7: [235, 235, 235],
  8: [120, 120, 120],
  9: [255, 110, 110],
  10: [140, 230, 160],
  11: [240, 210, 110],
  12: [130, 190, 255],
  13: [240, 170, 250],
  14: [120, 220, 240],
  15: [255, 255, 255]
}
const FALLBACK_LIGHT: Record<number, [number, number, number]> = {
  0: [60, 60, 60],
  1: [190, 30, 30],
  2: [0, 130, 60],
  3: [150, 110, 0],
  4: [20, 90, 190],
  5: [140, 40, 140],
  6: [0, 120, 140],
  7: [240, 240, 240],
  8: [110, 110, 110],
  9: [220, 60, 60],
  10: [40, 160, 80],
  11: [180, 140, 0],
  12: [40, 110, 220],
  13: [170, 60, 170],
  14: [0, 150, 170],
  15: [250, 250, 250]
}

const DEFAULT_DARK_FG = "#e6e6e6"
const DEFAULT_LIGHT_FG = "#1a1a1a"

type RGB = [number, number, number]

function parseHex(hex: string | null): RGB | null {
  if (!hex) return null
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return null
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}

function toHex(rgb: RGB): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`
}

/** WCAG-ish relative luminance, 0..1. */
function luminance(rgb: RGB): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

/** WCAG contrast ratio, 1..21. */
function contrast(a: RGB, b: RGB): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Pick the candidate (normal vs bright ANSI variant) with the best contrast
 * against the background, but only if it clears `min` — otherwise return the
 * default foreground, which is readable by definition.
 */
function pick(candidates: (RGB | null)[], bg: RGB, fg: string, min: number): string {
  let best: RGB | null = null
  let bestC = 0
  for (const c of candidates) {
    if (!c) continue
    const cr = contrast(c, bg)
    if (cr > bestC) {
      best = c
      bestC = cr
    }
  }
  return best && bestC >= min ? toHex(best) : fg
}

/** Main/emphasis roles need solid contrast. */
const MIN_ROLE = 3.0
/** Quiet roles (borders, muted) can sit slightly closer to the background. */
const MIN_QUIET = 2.2

/**
 * Build a readable semantic theme from the terminal's detected palette.
 * `terminalColors` may be a partial/empty detection — we fall back gracefully.
 */
export function buildTheme(colors: TerminalColors | null | undefined): Theme {
  const ansi = colors?.palette ?? []
  const raw = (idx: number): RGB | null => parseHex(ansi[idx] ?? null)
  const defaultFg = colors?.defaultForeground ?? null
  const defaultBg = colors?.defaultBackground ?? null
  const bgRgb = parseHex(defaultBg)

  // Assume dark unless the terminal told us it's light.
  const dark = bgRgb ? luminance(bgRgb) < 0.4 : true
  const bg: RGB = bgRgb ?? (dark ? [15, 15, 15] : [245, 245, 245])
  const fallback = dark ? FALLBACK_DARK : FALLBACK_LIGHT

  const fg = defaultFg ?? (dark ? DEFAULT_DARK_FG : DEFAULT_LIGHT_FG)

  // Hue role: prefer the brighter ANSI variant, fall back to fg if unreadable.
  const hue = (normalIdx: number, brightIdx: number, min = MIN_ROLE): string =>
    pick([raw(normalIdx) ?? fallback[normalIdx]!, raw(brightIdx) ?? fallback[brightIdx]!], bg, fg, min)

  const user = hue(IDX.green, IDX.brightGreen)
  const thinking = hue(IDX.yellow, IDX.brightYellow)
  const warning = thinking
  const system = hue(IDX.cyan, IDX.brightCyan)
  const toolUse = system
  const toolError = hue(IDX.red, IDX.brightRed)
  const compaction = hue(IDX.magenta, IDX.brightMagenta)
  const custom = compaction
  const accent = toolUse

  // Neutral roles: prefer the terminal's gray, still gated on contrast.
  const gray = (min: number): string =>
    pick([raw(IDX.brightBlack) ?? fallback[IDX.brightBlack]!, raw(IDX.black) ?? fallback[IDX.black]!], bg, fg, min)

  const toolResult = gray(MIN_ROLE)
  const dim = gray(MIN_ROLE)
  const muted = gray(MIN_QUIET)
  const border = gray(MIN_QUIET)

  return {
    fg,
    dim,
    muted,
    accent,
    border,
    user,
    assistant: fg,
    thinking,
    system,
    toolUse,
    toolResult,
    toolError,
    compaction,
    custom,
    warning,
    defaultFg: defaultFg ?? null,
    defaultBg: defaultBg ?? null,
    dark,
    ansi: ansi.slice(0, 16)
  }
}

/** Default theme before the terminal answers the OSC query. */
export function defaultTheme(): Theme {
  return buildTheme(null)
}

/**
 * Subscribe to the renderer's terminal palette (one-shot detection via
 * `getPalette` plus live updates via the "palette" event). Calls `onTheme`
 * immediately with a sensible default, then again once real colors arrive.
 * Returns an unsubscribe function.
 */
export function watchTheme(renderer: CliRenderer, onTheme: (t: Theme) => void): () => void {
  let disposed = false
  onTheme(defaultTheme())

  const handle = (colors: TerminalColors) => {
    if (disposed) return
    onTheme(buildTheme(colors))
  }

  renderer.on("palette", handle)

  renderer.getPalette({ size: 16 }).then(
    (colors) => handle(colors),
    () => {
      /* OSC not supported — keep the default theme */
    }
  )

  return () => {
    disposed = true
    renderer.off("palette", handle)
  }
}
