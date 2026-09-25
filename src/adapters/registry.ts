/**
 * Agent adapter registry. Dispatches discovery + loading to the adapter
 * registered for each tool. All six tools ship an adapter; `available` reflects
 * whether the tool's store exists on this machine.
 */

import { existsSync } from "node:fs"
import type { MetaCache } from "../engine/meta-cache.ts"
import { discoverSessions as discoverClaude, loadSession as loadClaude } from "./claude/index.ts"
import { discoverSessions as discoverCodex, loadSession as loadCodex } from "./codex/index.ts"
import { globalStoragePath as cursorGlobalStoragePath } from "./cursor/db.ts"
import { discoverSessions as discoverCursor, loadSession as loadCursor } from "./cursor/index.ts"
import { discoverSessions as discoverOpencode, loadSession as loadOpencode } from "./opencode/index.ts"
import { discoverSessions as discoverPi, loadSession as loadPi } from "./pi/index.ts"
import type { AgentSession, AgentTool, SessionMeta, ToolInfo } from "./types.ts"
import {
  discoverSessions as discoverVscode,
  loadSession as loadVscode,
  isAvailable as vscodeAvailable
} from "./vscode/index.ts"

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
    description:
      "~/.claude/projects/*.jsonl — exact per-request usage; exact prompt when prompt_snapshot exists, else labeled fallback",
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
    id: "cursor",
    name: "Cursor",
    description:
      "state.vscdb composer blobs — exact transcripts; no per-request tokens or system prompt persisted (see notes)",
    available: existsSync(cursorGlobalStoragePath()),
    storage: ["~/.config/Cursor/User/globalStorage/"]
  },
  {
    id: "vscode",
    name: "VS Code",
    description:
      "Copilot Chat workspaceStorage chatSessions/*.jsonl (mutation-log replay) + session-store.db enrichment — context points only where usage is persisted",
    available: vscodeAvailable(),
    storage: ["~/.config/Code - Insiders/User/workspaceStorage/", "~/.config/Code/User/workspaceStorage/"]
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
    case "cursor":
      return discoverCursor(cache)
    case "vscode":
      return discoverVscode(cache)
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
    case "cursor":
      return loadCursor(meta)
    case "vscode":
      return loadVscode(meta)
    default:
      throw new Error(`adapter not implemented: ${meta.tool}`)
  }
}

/** Tools that have a working adapter on this machine. */
export function availableTools(): AgentTool[] {
  return TOOLS.filter((t) => t.available).map((t) => t.id)
}
