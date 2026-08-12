/**
 * Minimal structural types for vendored Pi session/context code.
 * Mirrors the shapes from @earendil-works/pi-coding-agent 0.83.0 dist (MIT).
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

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction"
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  details?: unknown
  usage?: Usage
  fromHook?: boolean
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary"
  fromId: string
  summary?: string
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom"
  customType: string
  data: unknown
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message"
  customType: string
  content?: ContentBlock[] | string
  display?: boolean
  details?: unknown
}

export interface LabelEntry extends SessionEntryBase {
  type: "label"
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info"
  name?: string
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry

export type FileEntry = SessionHeader | SessionEntry

export interface SessionContext {
  messages: AgentMessage[]
  thinkingLevel: string
  model: { provider: string; modelId: string } | null
}
