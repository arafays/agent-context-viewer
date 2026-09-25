/**
 * Raw schema of Cursor's persisted JSON (state.vscdb blob values) + safe
 * parsing helpers.
 *
 * Everything here is defensive: Cursor's blob JSON is versioned (`_v`) and
 * evolves across releases, so every parse returns null on failure and every
 * field access is optional. Malformed rows are skipped (counted by callers),
 * never thrown.
 */

// ---------------------------------------------------------------------------
// composerHeaders table (one row per composer, `value` is a JSON head)
// ---------------------------------------------------------------------------

/** URI-ish object as stored by VS Code (`{ fsPath, external, path, scheme }`). */
export interface CursorUri {
  fsPath?: string
  external?: string
  path?: string
  scheme?: string
}

export interface HeaderValue {
  type?: string
  composerId?: string
  name?: string
  subtitle?: string
  createdAt?: number
  lastUpdatedAt?: number
  unifiedMode?: string
  workspaceIdentifier?: { uri?: CursorUri }
  agentLocation?: { environment?: { uri?: CursorUri } }
  trackedGitRepos?: Array<{ repoPath?: string }>
  contextUsagePercent?: number
  [k: string]: unknown
}

export interface HeaderRow {
  composerId: string
  workspaceId: string
  createdAt: number
  lastUpdatedAt: number
  recency: number
  isArchived: number
  isSubagent: number
  value: HeaderValue | null
}

// ---------------------------------------------------------------------------
// cursorDiskKV blobs
// ---------------------------------------------------------------------------

/** Ordered per-bubble entry inside `composerData:<id>`. */
export interface ConversationHeader {
  bubbleId: string
  type: number // 1 = user, 2 = assistant-side
  grouping?: {
    isRenderable?: boolean
    capabilityType?: number // 15 = tool, 22 = ?, 30 = thinking
    hasText?: boolean
    hasThinking?: boolean
    [k: string]: unknown
  }
  toolCallId?: string
}

export interface TokenCategory {
  id?: string
  label?: string
  estimatedTokens?: number
}

/** Last-request snapshot only (41/145 composers on this machine). */
export interface PromptTokenBreakdown {
  totalUsedTokens?: number
  maxTokens?: number
  categories?: TokenCategory[]
}

export interface UsageTreeNode {
  kind?: string
  label?: string
  id?: string
  categoryId?: string
  estimatedTokens?: number
  nodes?: UsageTreeNode[]
  children?: UsageTreeNode[]
  items?: UsageTreeNode[]
  [k: string]: unknown
}

export interface PromptContextUsageTree {
  schemaVersion?: number
  nodes?: UsageTreeNode[]
}

export interface ModelConfig {
  modelName?: string
  selectedModels?: Array<{ modelId?: string }>
  [k: string]: unknown
}

/** `cursorDiskKV` value under `composerData:<composerId>`. */
export interface ComposerData {
  _v?: number
  composerId?: string
  name?: string
  subtitle?: string
  createdAt?: number
  lastUpdatedAt?: number
  unifiedMode?: string
  status?: string
  modelConfig?: ModelConfig
  workspaceIdentifier?: { uri?: CursorUri }
  fullConversationHeadersOnly?: ConversationHeader[]
  promptTokenBreakdown?: PromptTokenBreakdown
  promptContextUsageTree?: PromptContextUsageTree
  contextUsagePercent?: number
  [k: string]: unknown
}

/** `toolFormerData` on a type-2 bubble (combined tool call + result). */
export interface ToolFormerData {
  toolCallId?: string
  modelCallId?: string
  toolIndex?: number
  status?: string // "completed" | "error" | ...
  name?: string
  tool?: number
  rawArgs?: string
  params?: string
  result?: unknown
  [k: string]: unknown
}

/** A `bubbleId:<composerId>:<bubbleId>` blob (`_v: 3` observed). */
export interface Bubble {
  _v?: number
  bubbleId?: string
  type?: number // 1 = user, 2 = assistant-side
  createdAt?: string // ISO timestamp
  text?: string
  richText?: string // double-encoded Lexical/ProseMirror JSON
  thinking?: { text?: string }
  toolFormerData?: ToolFormerData
  modelInfo?: { modelName?: string }
  tokenCount?: { inputTokens?: number; outputTokens?: number }
  capabilityType?: number
  grouping?: {
    capabilityType?: number
    isRenderable?: boolean
    hasText?: boolean
    hasThinking?: boolean
    [k: string]: unknown
  }
  unifiedMode?: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** SQLite BLOB (Buffer/Uint8Array) or TEXT → utf8 string. */
export function blobText(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8")
  return ""
}

/** JSON.parse that never throws; returns null for non-objects. */
export function parseJson<T>(raw: unknown): T | null {
  const text = typeof raw === "string" ? raw : blobText(raw)
  if (!text.trim()) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === "object") return parsed as T
  } catch {
    /* malformed row → caller skips */
  }
  return null
}

/** `rawArgs`/`params`/similar: JSON string → object, otherwise passthrough. */
export function parseToolField(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return raw ?? undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return parsed
  } catch {
    /* not JSON → keep the raw string */
  }
  return raw
}

/**
 * Extract plain text from a richText payload (double-encoded JSON; Lexical and
 * ProseMirror shapes both seen in the wild). Text nodes carry `type:"text"` +
 * `text` in both formats.
 */
export function richTextToText(raw: unknown): string {
  const doc = parseJson<unknown>(raw)
  if (!doc) return ""
  const out: string[] = []
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || !node || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    const o = node as Record<string, unknown>
    if (o.type === "text" && typeof o.text === "string") out.push(o.text)
    if (o.type === "linebreak") out.push("\n")
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") walk(v, depth + 1)
    }
  }
  walk(doc, 0)
  return out.join("")
}

/** User prompt text: `text` first, Lexical/ProseMirror extraction as fallback. */
export function promptTextOf(bubble: Bubble): string {
  if (typeof bubble.text === "string" && bubble.text.trim()) return bubble.text
  const fromRich = richTextToText(bubble.richText).trim()
  return fromRich
}

/** ISO-8601 bubble timestamp → epoch ms (fallback when missing/malformed). */
export function isoToEpoch(raw: unknown, fallback: number): number {
  if (typeof raw === "string" && raw) {
    const t = Date.parse(raw)
    if (!Number.isNaN(t)) return t
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  return fallback
}

/** Flatten promptContextUsageTree into a flat node list (kind/label access). */
export function flattenTree(tree: PromptContextUsageTree | undefined): UsageTreeNode[] {
  const out: UsageTreeNode[] = []
  const walk = (node: UsageTreeNode | undefined, depth: number): void => {
    if (!node || depth > 32) return
    out.push(node)
    for (const key of ["nodes", "children", "items"] as const) {
      const kids = node[key]
      if (Array.isArray(kids)) for (const kid of kids) walk(kid as UsageTreeNode, depth + 1)
    }
  }
  for (const node of tree?.nodes ?? []) walk(node, 0)
  return out
}

/** Number of `summary_message` markers in the last request's usage tree. */
export function summaryNodeCount(tree: PromptContextUsageTree | undefined): number {
  let n = 0
  for (const node of flattenTree(tree)) if (node.kind === "summary_message") n++
  return n
}

/** Bubble → normalized display role/classification. */
export function bubbleKind(bubble: Bubble): "user" | "tool" | "thinking" | "text" | "empty" {
  if (bubble.type === 1) return "user"
  if (bubble.toolFormerData?.name || bubble.toolFormerData?.toolCallId) return "tool"
  if (typeof bubble.thinking?.text === "string" && bubble.thinking.text.trim()) return "thinking"
  if (typeof bubble.text === "string" && bubble.text.trim()) return "text"
  return "empty"
}

/** Non-zero token counts are surfaced as usage; all-zero means "not recorded". */
export function bubbleUsage(bubble: Bubble): { input: number; output: number } | null {
  const tc = bubble.tokenCount
  if (!tc) return null
  const input = typeof tc.inputTokens === "number" ? tc.inputTokens : 0
  const output = typeof tc.outputTokens === "number" ? tc.outputTokens : 0
  if (input === 0 && output === 0) return null
  return { input, output }
}
