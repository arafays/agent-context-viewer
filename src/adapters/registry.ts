/**
 * Agent adapter registry. Dispatches discovery + loading to the adapter
 * registered for each tool. v1 ships Pi + Codex; the rest are declared so the
 * UI can show them as "coming soon" and adapters can be added incrementally.
 */
import type { AgentSession, AgentTool, SessionMeta, ToolInfo } from "./types.ts"
import { discoverSessions as discoverPi, loadSession as loadPi } from "./pi/index.ts"
import { discoverSessions as discoverCodex, loadSession as loadCodex } from "./codex/index.ts"
import { discoverSessions as discoverClaude, loadSession as loadClaude } from "./claude/index.ts"
import { discoverSessions as discoverOpencode, loadSession as loadOpencode } from "./opencode/index.ts"
import type { MetaCache } from "../engine/meta-cache.ts"

export const TOOLS: ToolInfo[] = [
  {
    id: "pi",
    name: "Pi",
    description: "@earendil-works/pi-coding-agent — sessions, context reconstruction, compaction",
    available: true,
    storage: ["~/.pi/agent/sessions/"]
  },
  {
    id: "codex",
    name: "Codex",
    description: "openai/codex — system prompt + AGENTS.md stored inline per session (exact)",
    available: true,
    storage: ["~/.codex/sessions/"]
  },
  {
    id: "claude",
    name: "Claude Code",
    description: "~/.claude/projects/*.jsonl — exact per-request usage; system prompt not persisted",
    available: true,
    storage: ["~/.claude/projects/"]
  },
  {
    id: "opencode",
    name: "opencode",
    description: "~/.local/share/opencode/opencode.db — exact per-request tokens; system prompt reconstructed",
    available: true,
    storage: ["~/.local/share/opencode/opencode.db"]
  },
  {
    id: "cmd",
    name: "Command Code",
    description: "~/.commandcode/projects/ (adapter planned)",
    available: false,
    storage: ["~/.commandcode/projects/"]
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "state.vscdb blobs (adapter planned)",
    available: false,
    storage: ["~/.config/Cursor/"]
  },
  {
    id: "vscode",
    name: "VS Code",
    description: "github.copilot-chat session-store.db (adapter planned)",
    available: false,
    storage: ["~/.config/Code - Insiders/"]
  }
]

export function getTool(tool: AgentTool): ToolInfo | null {
  return TOOLS.find((t) => t.id === tool) ?? null
}

/** Discover sessions for a tool. `cache` (optional) is the shared sidecar
 * meta cache; when provided, discovery skips re-parsing unchanged sessions. */
export function discoverSessions(tool: AgentTool, cache?: MetaCache): SessionMeta[] {
  switch (tool) {
    case "pi":
      return discoverPi(cache)
    case "codex":
      return discoverCodex(cache)
    case "claude":
      return discoverClaude(cache)
    case "opencode":
      return discoverOpencode(cache)
    default:
      return []
  }
}

/** Load a full session for a tool. */
export function loadSession(meta: SessionMeta): AgentSession {
  switch (meta.tool) {
    case "pi":
      return loadPi(meta.path)
    case "codex":
      return loadCodex(meta.path)
    case "claude":
      return loadClaude(meta.path)
    case "opencode":
      return loadOpencode(meta)
    default:
      throw new Error(`adapter not implemented: ${meta.tool}`)
  }
}

/** Tools that have a working adapter on this machine. */
export function availableTools(): AgentTool[] {
  return TOOLS.filter((t) => t.available).map((t) => t.id)
}
