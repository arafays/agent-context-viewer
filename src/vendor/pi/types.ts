/**
 * Minimal structural types for vendored Pi session/context code.
 * Mirrors the shapes from @earendil-works/pi-coding-agent 0.87.1 dist (MIT),
 * verified against `dist/core/session-manager.d.ts` and `dist/core/messages.d.ts`.
 * Types are intentionally loose where the runtime data is polymorphic.
 */

export type TextContent = { type: "text"; text: string }
export type ImageContent = {
  type: "image"
  source?: { type: "base64" | "url"; media_type?: string; data?: string; url?: string }
  mediaType?: string
  data?: string
  url?: string
}
export type ContentBlock = TextContent | ImageContent | { type: string; [k: string]: unknown }

export interface Usage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  totalTokens?: number
  cost?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

/** A message as stored in session entries (AgentMessage subset we render). */
export interface AgentMessage {
  role:
    | "user"
    | "assistant"
    | "toolResult"
    | "system"
    | "custom"
    | "compactionSummary"
    | "branchSummary"
    | "bashExecution"
    | "hookMessage"
  content?: ContentBlock[] | string | null
  /** provider/model are present on assistant messages */
  provider?: string
  model?: string
  modelId?: string
  excludeFromContext?: boolean
  [k: string]: unknown
}

/** Session file header (first line). */
export interface SessionHeader {
  type: "session"
  version?: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
  [k: string]: unknown
}

export interface SessionEntryBase {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  [k: string]: unknown
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message"
  message: AgentMessage
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change"
  thinkingLevel: string
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change"
  provider: string
  modelId: string
}

export interface UsageEntry extends SessionEntryBase {
  type: "usage"
  /** Arbitrary usage category, such as "cache_warm". */
  kind: string
  provider: string
  model: string
  usage: Usage
  /** Optional human-readable qualifier for usage notices. */
  note?: string
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction"
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  details?: unknown
  usage?: Usage
  fromHook?: boolean
  /** Complete prompt and tool state at this compaction boundary (0.87.1+). */
  systemMessage?: AgentMessage
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary"
  fromId: string
  summary: string
  details?: unknown
  usage?: Usage
  fromHook?: boolean
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom"
  customType: string
  data?: unknown
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message"
  customType: string
  content: ContentBlock[] | string
  display: boolean
  details?: unknown
}

/** Content that an append-only context edit may replace without changing message metadata. */
export type ContextEditableContent = ContentBlock[] | string

/** Append-only change to one earlier entry's contribution to model context (0.87.1+). */
export interface ContextEditEntry extends SessionEntryBase {
  type: "context_edit"
  targetId: string
  /** Null omits the target from model context. A value replaces only its content. */
  replacement: { content: ContextEditableContent } | null
}

export interface LabelEntry extends SessionEntryBase {
  type: "label"
  targetId: string
  label: string | undefined
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info"
  name?: string
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | UsageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | ContextEditEntry
  | LabelEntry
  | SessionInfoEntry

export type FileEntry = SessionHeader | SessionEntry

/** One append-only entry's projection: its raw source plus model-visible messages. */
export interface ProjectedSessionEntry {
  /** Raw append-only entry that owns this projected contribution. */
  sourceEntry: SessionEntry
  /** Model-visible messages after context edits. Empty for state-only entries and omissions. */
  messages: AgentMessage[]
}

/** Provenance-preserving, compaction-aware model context. */
export interface SessionProjection {
  entries: ProjectedSessionEntry[]
  messages: AgentMessage[]
  thinkingLevel: string
  model: { provider: string; modelId: string } | null
}

export interface SessionContext {
  messages: AgentMessage[]
  thinkingLevel: string
  model: { provider: string; modelId: string } | null
}
