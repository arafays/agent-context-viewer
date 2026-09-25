/**
 * Best-effort static scraper for *extension* tools' prompt contributions.
 *
 * pi renders every registered tool that has a `promptSnippet` in its `<tools>`
 * section and applies each tool's `promptGuidelines` in `<rules>`. Extension
 * tools come from installed pi packages (settings.json `packages`) and from the
 * user/project extension dirs pi auto-discovers (`<agentDir>/extensions`,
 * `<cwd>/.pi/extensions` when trusted), so we scan their sources (extensions
 * ship raw TS that pi bundles) for `promptSnippet:` / `promptGuidelines:` pairs
 * and attribute them to the nearest preceding tool-name anchor (`name: "x"`,
 * `label: "x"`, `x: { …`, or a dotted name argument like
 * `queueTool(() => toolNames.grep, { … })`).
 *
 * Same-file and package-wide string/object consts are resolved; spreads of
 * helper functions that return the metadata (e.g. pi-subagents'
 * `...buildSubagentToolPromptMetadata(config)`) are resolved by indexing every
 * `function NAME` body in the scanned roots. Dynamic snippets (function calls
 * or values built at runtime, like pi-mcp-adapter's per-server tool
 * descriptions — see `loadMcpToolSnippets`) can't be recovered from source
 * alone, so uncovered tools are disclosed instead of silently lying.
 *
 * Note: built-in snippets win over extension ones for the same name — pi-fff
 * ships both an override mode (rebinds `grep`/`find`) and a mode that adds
 * `ffgrep`/`fffind`, and the default is the additive mode.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { getAgentDir } from "./index.ts"
import { isProjectTrusted } from "./resources.ts"

export interface ExtensionToolBits {
  /** name → snippet, from installed extension packages. */
  toolSnippets: Record<string, string>
  /** name → per-tool rules, from installed extension packages. */
  toolGuidelines: Record<string, string[]>
  /** Package dirs that were scanned (for notes). */
  scannedDirs: string[]
}

const MAX_FILES = 400
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** How far back (chars) a tool-name anchor may sit from the promptSnippet key. */
const ANCHOR_WINDOW = 700
/** Common JS object keys that are never tool names — keeps `options: {` from stealing a pairing. */
const NON_TOOL_KEYS = new Set([
  "options",
  "config",
  "params",
  "default",
  "exports",
  "module",
  "require",
  "schema",
  "handler",
  "deps",
  "plugins",
  "plugin",
  "settings",
  "context",
  "state",
  "meta",
  "return",
  "then",
  "catch",
  "async",
  "await",
  "function",
  "class",
  "interface",
  "type"
])

/** Installed pi package dirs from settings.json `packages` (`npm:<name>` entries). */
function packageDirs(agentDir: string): string[] {
  let settings: { packages?: unknown[] }
  try {
    settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown[] }
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of settings.packages ?? []) {
    if (typeof entry !== "string" || !entry.startsWith("npm:")) continue
    const dir = join(agentDir, "npm/node_modules", entry.slice("npm:".length))
    if (existsSync(dir)) out.push(dir)
  }
  return out
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Roots pi loads extension sources from: installed packages, the user
 * extension dir, and (when the project is trusted) the project extension dir —
 * `discoverAndLoadExtensions` in dist/core/extensions/loader.js scans
 * `<cwd>/.pi/extensions/` and `<agentDir>/extensions/` the same way.
 */
function scanRoots(agentDir: string, cwd?: string): string[] {
  const roots = packageDirs(agentDir)
  const userExt = join(agentDir, "extensions")
  if (isDir(userExt)) roots.push(userExt)
  if (cwd) {
    const projectExt = join(cwd, ".pi/extensions")
    if (isDir(projectExt) && isProjectTrusted(cwd, agentDir)) roots.push(projectExt)
  }
  return roots
}

function walkSourceFiles(root: string, out: string[], budget: { left: number }, depth = 0): void {
  if (budget.left <= 0 || depth > 8) return
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (budget.left <= 0) return
    if (name === "node_modules" || name.startsWith(".")) continue
    const full = join(root, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (name === "test" || name === "tests" || name === "__tests__" || name === "examples") continue
      walkSourceFiles(full, out, budget, depth + 1)
    } else if (isSourceFile(name) && st.size <= MAX_FILE_BYTES) {
      out.push(full)
      budget.left--
    }
  }
}

/** Extensions ship raw TS (pi bundles them), so scan both .ts and .js — minus types/tests. */
function isSourceFile(name: string): boolean {
  if (name.endsWith(".d.ts") || name.endsWith(".d.mts")) return false
  if (/\.(test|spec)\.(ts|js|mjs|cjs)$/.test(name)) return false
  return /\.(ts|js|mjs|cjs)$/.test(name)
}

/** `const NAME = "str"` / `const NAME = [ … ]` / `const NAME = { k: "v" }` (same file only). */
function extractConsts(src: string): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>()

  const strConst = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])((?:[^\\]|\\.)*?)\2/g
  for (const m of src.matchAll(strConst)) {
    const value = m[3]
    const key = m[1]
    if (value !== undefined && key !== undefined) out.set(key, value)
  }

  const arrConst = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g
  for (const m of src.matchAll(arrConst)) {
    const key = m[1]
    if (key === undefined) continue
    const end = matchBracket(src, m.index + m[0].length - 1, "[", "]")
    if (end < 0) continue
    out.set(key, extractStrings(src.slice(m.index + m[0].length - 1, end + 1)))
  }

  // object literals: `const X = { grep: "ffgrep", ... }` → `X.grep` → "ffgrep"
  const objConst = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{/g
  for (const m of src.matchAll(objConst)) {
    const objName = m[1]
    if (objName === undefined) continue
    const start = m.index + m[0].length - 1
    const end = matchBracket(src, start, "{", "}")
    if (end < 0) continue
    const body = src.slice(start + 1, end)
    const entryRe = /([A-Za-z_$][\w$]*)\s*:\s*(['"])((?:[^\\]|\\.)*?)\2/g
    for (const e of body.matchAll(entryRe)) {
      const field = e[1]
      const value = e[3]
      if (field !== undefined && value !== undefined) out.set(`${objName}.${field}`, value)
    }
  }
  return out
}

/** Index of the bracket closing the one at `start`. */
function matchBracket(src: string, start: number, open: string, close: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === "\\") i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function extractStrings(text: string): string[] {
  const out: string[] = []
  const re = /(['"])((?:[^\\]|\\.)*)\1/g
  for (const m of text.matchAll(re)) {
    const v = m[2]
    if (v !== undefined) out.push(v.replace(/\\(['"])/g, "$1"))
  }
  return out
}

interface Anchor {
  pos: number
  name: string
}

function findAnchors(src: string, consts: Map<string, string | string[]>): Anchor[] {
  const anchors: Anchor[] = []
  // `name: "x"` / `name: SOME_CONST`, `label: "x"`, and map-style `x: {`
  const re =
    /name:\s*(?:"([a-z][a-z0-9_-]*)"|([A-Za-z_$][\w$.]*))|label:\s*"([a-z][a-z0-9_-]*)"|^\s*"?([a-z][a-z0-9_-]*)"?\s*:\s*\{/gm
  for (const m of src.matchAll(re)) {
    let name: string | undefined = m[1] ?? m[3] ?? m[4]
    const ident = m[2]
    if (!name && ident) {
      const resolved = consts.get(ident)
      if (typeof resolved === "string") {
        name = resolved
      } else if (ident.includes(".")) {
        pushExpandedAnchors(anchors, consts, ident, m.index)
        continue
      }
    }
    if (!name || NON_TOOL_KEYS.has(name)) continue
    anchors.push({ pos: m.index, name })
  }

  // `queueTool(() => toolNames.grep, { …promptSnippet… })` — name passed as a dotted
  // argument instead of a `name:` field. Requires a dotted path to stay unambiguous.
  const argRe = /[\s(,]([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$.]*)\s*,\s*\{/g
  for (const m of src.matchAll(argRe)) {
    const ident = m[1]
    if (!ident) continue
    const resolved = consts.get(ident)
    if (typeof resolved === "string") {
      if (!NON_TOOL_KEYS.has(resolved)) anchors.push({ pos: m.index, name: resolved })
    } else {
      pushExpandedAnchors(anchors, consts, ident, m.index)
    }
  }
  return anchors
}

/** `toolNames.grep` → every const object field named `.grep` (mode-dependent tool names). */
function pushExpandedAnchors(
  anchors: Anchor[],
  consts: Map<string, string | string[]>,
  ident: string,
  pos: number
): void {
  const suffix = ident.slice(ident.lastIndexOf("."))
  if (!suffix || suffix === ident) return
  for (const [key, value] of consts) {
    if (key.endsWith(suffix) && typeof value === "string" && value && !NON_TOOL_KEYS.has(value)) {
      anchors.push({ pos, name: value })
    }
  }
}

/**
 * Closest anchor(s) at or before `pos` within the window. Several may tie when an
 * unresolved name expands to multiple candidate tool names — attribute to all of them.
 */
function nearestAnchors(anchors: Anchor[], pos: number): string[] {
  let bestPos = -1
  for (const a of anchors) {
    const delta = pos - a.pos
    if (delta < 0 || delta > ANCHOR_WINDOW) continue
    if (a.pos > bestPos) bestPos = a.pos
  }
  if (bestPos < 0) return []
  const names: string[] = []
  for (const a of anchors) {
    if (a.pos === bestPos && !names.includes(a.name)) names.push(a.name)
  }
  return names
}

function resolveValue(raw: string, consts: Map<string, string | string[]>): string | string[] | undefined {
  const value = raw.trim()
  const first = value.charAt(0)
  if (first === '"' || first === "'") {
    for (let i = 1; i < value.length; i++) {
      const c = value[i]
      if (c === "\\") {
        i++
        continue
      }
      if (c === first) return value.slice(1, i).replace(/\\(['"])/g, "$1")
    }
    return undefined
  }
  if (first === "[") {
    const end = matchBracket(value, 0, "[", "]")
    if (end > 0) return extractStrings(value.slice(0, end + 1))
    return undefined
  }
  const ident = value.match(/^([A-Za-z_$][\w$.]*)/)
  if (ident?.[1]) return consts.get(ident[1])
  return undefined
}

/** prompt metadata parsed out of a snippet source (a file or a helper body). */
interface PromptBits {
  snippet?: string
  guidelines?: string[]
}

/** First `promptSnippet:` / `promptGuidelines:` pair resolvable in `text`. */
function extractPromptBits(text: string, consts: Map<string, string | string[]>): PromptBits {
  const out: PromptBits = {}
  for (const m of text.matchAll(/promptSnippet:\s*/g)) {
    const value = resolveValue(text.slice(m.index + m[0].length, m.index + m[0].length + 500), consts)
    if (typeof value === "string" && value) {
      out.snippet = value
      break
    }
  }
  for (const m of text.matchAll(/promptGuidelines:\s*/g)) {
    const value = resolveValue(text.slice(m.index + m[0].length, m.index + m[0].length + 4000), consts)
    if (Array.isArray(value) && value.length > 0) {
      out.guidelines = value
      break
    }
  }
  return out
}

/** Offset of a function body's `{` after its parameter list, or -1. */
function findBodyStart(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === "{" || c === ";" || c === "=") return c === "{" ? i : -1
  }
  return -1
}

/** Helper functions whose returned object literal carries prompt metadata. */
interface FunctionDef {
  consts: Map<string, string | string[]>
  body: string
}

/**
 * Index `function NAME(…) { … }` and `const NAME = (…) => { … }` declarations
 * so a `...NAME(config)` spread next to a tool-name anchor can be resolved to
 * the metadata that helper returns (cross-file — e.g. pi-subagents spreads
 * `buildSubagentToolPromptMetadata`, defined in another module, into its tool).
 */
function indexFunctions(src: string, consts: Map<string, string | string[]>, index: Map<string, FunctionDef>): void {
  const capture = (name: string | undefined, bodyStart: number): void => {
    if (!name || index.has(name)) return
    const bodyEnd = matchBracket(src, bodyStart, "{", "}")
    if (bodyEnd < 0) return
    index.set(name, { consts, body: src.slice(bodyStart + 1, bodyEnd) })
  }
  for (const m of src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const paramsEnd = matchBracket(src, m.index + m[0].length - 1, "(", ")")
    if (paramsEnd < 0) continue
    const bodyStart = findBodyStart(src, paramsEnd + 1)
    if (bodyStart < 0) continue
    capture(m[1], bodyStart)
  }
  for (const m of src.matchAll(
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/g
  )) {
    const paramsEnd = matchBracket(src, m.index + m[0].length - 1, "(", ")")
    if (paramsEnd < 0) continue
    const arrow = src.slice(paramsEnd + 1, paramsEnd + 32).match(/^\s*=>\s*\{/)
    if (!arrow) continue
    capture(m[1], paramsEnd + arrow[0].length)
  }
}

interface ScrapeContext {
  /** Per-file consts merged over the root-wide ones (file-local wins). */
  consts: Map<string, string | string[]>
  functions: Map<string, FunctionDef>
}

/** Scrape one source file, returning prompt contributions keyed by tool name. */
function scrapeFile(
  src: string,
  ctx: ScrapeContext
): {
  snippets: Record<string, string>
  guidelines: Record<string, string[]>
} {
  const consts = ctx.consts
  const anchors = findAnchors(src, consts)
  const snippets: Record<string, string> = {}
  const guidelines: Record<string, string[]> = {}

  const snipRe = /promptSnippet:\s*/g
  for (const m of src.matchAll(snipRe)) {
    const names = nearestAnchors(anchors, m.index)
    if (names.length === 0) continue
    const value = resolveValue(src.slice(m.index + m[0].length, m.index + m[0].length + 500), consts)
    if (typeof value === "string" && value) {
      for (const name of names) if (!(name in snippets)) snippets[name] = value
    }
  }

  const glRe = /promptGuidelines:\s*/g
  for (const m of src.matchAll(glRe)) {
    const names = nearestAnchors(anchors, m.index)
    if (names.length === 0) continue
    const value = resolveValue(src.slice(m.index + m[0].length, m.index + m[0].length + 4000), consts)
    if (Array.isArray(value) && value.length > 0) {
      for (const name of names) if (!(name in guidelines)) guidelines[name] = value
    }
  }

  // `…, ...buildSubagentToolPromptMetadata(config),` — metadata coming from a
  // helper (possibly defined in another file of the same root).
  for (const m of src.matchAll(/(?:^|[^.\w$])\.\.\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const fn = m[1] ? ctx.functions.get(m[1]) : undefined
    if (!fn) continue
    const names = nearestAnchors(anchors, m.index)
    if (names.length === 0) continue
    const bits = extractPromptBits(fn.body, fn.consts)
    if (bits.snippet) {
      for (const name of names) if (!(name in snippets)) snippets[name] = bits.snippet
    }
    if (bits.guidelines) {
      for (const name of names) if (!(name in guidelines)) guidelines[name] = bits.guidelines
    }
  }
  return { snippets, guidelines }
}

/**
 * Scrape every extension source root (installed packages + user/project
 * extension dirs) for tool prompt contributions.
 */
export function collectExtensionToolBits(agentDir = getAgentDir(), cwd?: string): ExtensionToolBits {
  const bits: ExtensionToolBits = { toolSnippets: {}, toolGuidelines: {}, scannedDirs: [] }
  for (const root of scanRoots(agentDir, cwd)) {
    bits.scannedDirs.push(root)
    const files: string[] = []
    walkSourceFiles(root, files, { left: MAX_FILES })

    const entries: { src: string; consts: Map<string, string | string[]> }[] = []
    for (const file of files) {
      try {
        const src = readFileSync(file, "utf8")
        entries.push({ src, consts: extractConsts(src) })
      } catch (err) {
        // unreadable/broken file → skip
        if (process.env.ACV_DEBUG_SCRAPER) console.error("scrape failed:", file, err)
      }
    }

    // root-wide consts (file-local wins for its own file) + one function index
    const sharedConsts = new Map<string, string | string[]>()
    for (const entry of entries) {
      for (const [key, value] of entry.consts) if (!sharedConsts.has(key)) sharedConsts.set(key, value)
    }
    const sources = entries.map((entry) => ({
      src: entry.src,
      consts: new Map([...sharedConsts, ...entry.consts])
    }))
    const functions = new Map<string, FunctionDef>()
    for (const source of sources) indexFunctions(source.src, source.consts, functions)

    for (const source of sources) {
      const scraped = scrapeFile(source.src, { consts: source.consts, functions })
      for (const [name, snippet] of Object.entries(scraped.snippets)) {
        if (!(name in bits.toolSnippets)) bits.toolSnippets[name] = snippet
      }
      for (const [name, gl] of Object.entries(scraped.guidelines)) {
        if (!(name in bits.toolGuidelines)) bits.toolGuidelines[name] = gl
      }
    }
  }
  return bits
}

/** Short label for notes: which extension source roots were scanned. */
export function describeScannedPackages(bits: ExtensionToolBits, agentDir = getAgentDir()): string {
  if (bits.scannedDirs.length === 0) return "no extension sources installed"
  const pkgRoot = join(agentDir, "npm/node_modules")
  return bits.scannedDirs
    .map((dir) => {
      if (dir.startsWith(`${pkgRoot}${sep}`)) return relative(pkgRoot, dir)
      const rel = relative(agentDir, dir)
      if (!rel.startsWith("..")) return rel
      // project extension dir → "<last two segments> (project)"
      return `${dir.split(sep).slice(-2).join("/")} (project)`
    })
    .join(", ")
}

// ---------------------------------------------------------------------------
// MCP tool snippets (pi-mcp-adapter builds these at runtime from descriptions)
// ---------------------------------------------------------------------------

interface McpCache {
  version?: number
  servers?: Record<string, { tools?: { name?: string; description?: string }[] }>
}

/** pi-mcp-adapter's `sanitizeServerPrefix` (types.ts): keep word chars, hex-escape the rest. */
function sanitizeServerPrefix(serverName: string): string {
  return Array.from(serverName, (char) =>
    /^[A-Za-z0-9_-]$/.test(char) ? char : `_${(char.codePointAt(0) ?? 0).toString(16)}_`
  ).join("")
}

/** pi-mcp-adapter's `formatToolName` (types.ts) with the default "server" prefix mode. */
function mcpToolName(toolName: string, serverName: string): string {
  const prefix = sanitizeServerPrefix(serverName)
  const sanitized = toolName.replace(/\./g, "_")
  if (prefix && sanitized.startsWith(`${prefix}_`) && sanitized.length > prefix.length + 1) return sanitized
  return prefix ? `${prefix}_${sanitized}` : sanitized
}

/** pi-mcp-adapter's `truncateAtWord` (utils.ts). */
function truncateAtWord(text: string, target: number): string {
  if (!text || text.length <= target) return text
  const truncated = text.slice(0, target)
  const lastSpace = truncated.lastIndexOf(" ")
  if (lastSpace > target * 0.6) return `${truncated.slice(0, lastSpace)}...`
  return `${truncated}...`
}

/**
 * Snippets for pi-mcp-adapter's proxied MCP tools, computed exactly as the
 * adapter does at runtime: `promptSnippet: truncateAtWord(description, 100)`
 * (falling back to `MCP tool from <server>`), keyed by the prefixed tool name.
 * Both name shapes are keyed — current `formatToolName` skips the prefix when
 * the tool already starts with `<server>_`, but sessions recorded the older
 * always-prefixed form (`codegraph_codegraph_explore`), and either may be the
 * observed name. Descriptions come from the adapter's own `mcp-cache.json`
 * (7-day TTL while pi runs), so this is a reconstruction from the last time pi
 * talked to each server — disclosed by the caller in the session notes.
 */
export function loadMcpToolSnippets(agentDir = getAgentDir()): Record<string, string> {
  const out: Record<string, string> = {}
  let cache: McpCache | undefined
  try {
    cache = JSON.parse(readFileSync(join(agentDir, "mcp-cache.json"), "utf8")) as McpCache
  } catch {
    return out
  }
  if (cache?.version !== 1) return out
  for (const [serverName, server] of Object.entries(cache.servers ?? {})) {
    const prefix = sanitizeServerPrefix(serverName)
    for (const tool of server?.tools ?? []) {
      if (typeof tool?.name !== "string" || !tool.name) continue
      const description = typeof tool.description === "string" ? tool.description : ""
      const snippet = truncateAtWord(description, 100) || `MCP tool from ${serverName}`
      const sanitized = tool.name.replace(/\./g, "_")
      const names = [mcpToolName(tool.name, serverName)]
      const alwaysPrefixed = prefix ? `${prefix}_${sanitized}` : sanitized
      if (alwaysPrefixed !== names[0]) names.push(alwaysPrefixed)
      for (const name of names) if (!(name in out)) out[name] = snippet
    }
  }
  return out
}
