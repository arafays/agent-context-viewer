/**
 * Normalized session model shared by all agent adapters.
 * Each adapter maps its tool's raw storage into these types.
 */

export type AgentTool = "pi" | "opencode" | "claude" | "codex" | "cmd" | "cursor" | "vscode";

export interface ToolInfo {
  id: AgentTool;
  name: string;
  description: string;
  /** true when session data was actually found on this machine */
  available: boolean;
  storage: string[];
}

/** Lightweight session metadata shown in lists (discovery pass). */
export interface SessionMeta {
  tool: AgentTool;
  id: string;
  path: string;
  cwd: string;
  /** decoded project directory label for display (e.g. last path segment) */
  project: string;
  startedAt: string;
  updatedAt: string;
  sizeBytes: number;
  name?: string;
  model?: string;
  thinkingLevel?: string;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compactionCount: number;
  customTypes: Array<{ type: string; count: number }>;
  /**
   * Cheaply-extracted searchable text for the fuzzy content index, populated
   * at discovery time by adapters that can (opencode: SQL; others piggyback
   * on their discovery parse). May be empty for sessions that weren't
   * materialized during discovery.
   */
  searchText?: string;
}

/** A content block inside a message (tool-agnostic). */
export interface ContentBlockView {
  kind:
    | "text"
    | "thinking"
    | "reasoning"
    | "tool_use"
    | "tool_result"
    | "image"
    | "input_text"
    | "output_text"
    | "unknown";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  isError?: boolean;
  language?: string;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** A single message (user prompt, assistant reply, tool result, compaction…). */
export interface NormalizedMessage {
  role:
    | "user"
    | "assistant"
    | "toolResult"
    | "custom"
    | "compactionSummary"
    | "branchSummary"
    | "developer";
  timestamp: number; // epoch ms
  blocks: ContentBlockView[];
  provider?: string;
  model?: string;
  usage?: UsageTotals;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  customType?: string;
  summary?: string;
  tokensBefore?: number;
  /** index of the raw entry this message came from */
  entryIndex: number;
}

/**
 * One user turn: from a user message up to (not including) the next user message.
 * Contains every LLM request (assistantCalls) and tool result in that span.
 */
export interface Turn {
  index: number;
  timestamp: number;
  userMessage: NormalizedMessage | null;
  assistantCalls: NormalizedMessage[];
  toolResults: NormalizedMessage[];
  events: SessionEventView[];
  /** total usage across assistantCalls */
  usage: UsageTotals;
  model: string | null;
  thinkingLevel: string | null;
  entryStart: number;
  entryEnd: number;
}

/** Notable non-message events (model changes, compaction, custom events). */
export interface SessionEventView {
  kind: "model_change" | "thinking_level_change" | "compaction" | "custom" | "label" | "branch_summary";
  timestamp: number;
  detail: string;
  [k: string]: unknown;
}

/** One LLM request point: context size + reconstructed context snapshot. */
export interface ContextPoint {
  /** index into the session's assistantCalls (0-based) */
  requestIndex: number;
  turnIndex: number;
  timestamp: number;
  model: string | null;
  thinkingLevel: string | null;
  usage: UsageTotals;
  /** total context tokens = input + cacheRead */
  contextTokens: number;
  /** system prompt that was sent with this request (reconstructed) */
  systemPrompt?: string;
  /** the exact context messages sent with this request (reconstructed) */
  contextMessages: NormalizedMessage[];
}

export interface ContextFile {
  path: string;
  content: string;
  /** true when this is the global ~/.pi/agent/AGENTS.md */
  global?: boolean;
}

export interface SessionContextInfo {
  systemPrompt: string;
  contextFiles: ContextFile[];
  skills: Array<{ name: string; description: string; filePath: string }>;
  tools: string[];
  /** reconstructed: true → system prompt/context files rebuilt from current files */
  reconstructed: boolean;
  notes: string[];
}

/**
 * A fully loaded session, as produced by any adapter's loadSession().
 * `contextInfo` + `contextPoints` are precomputed at load time so the UI is
 * adapter-agnostic: every adapter must fill them (reconstructed or exact).
 */
export interface AgentSession {
  meta: SessionMeta;
  turns: Turn[];
  events: SessionEventView[];
  /** every LLM request in order (each has usage) */
  assistantCalls: NormalizedMessage[];
  contextInfo: SessionContextInfo;
  /** one point per LLM request: context size + exact/reconstructed snapshot */
  contextPoints: ContextPoint[];
  name?: string;
  /** adapter-specific raw data (pi: session entries) */
  raw?: unknown;
}
