/**
 * Agent adapter registry. v1 ships only the Pi adapter; the rest are declared
 * so the UI can show them as "coming soon" and adapters can be added incrementally.
 */
import type { AgentTool, SessionMeta, ToolInfo } from "./types.ts";
import { discoverSessions as discoverPi } from "./pi/index.ts";

export const TOOLS: ToolInfo[] = [
  {
    id: "pi",
    name: "Pi",
    description: "@earendil-works/pi-coding-agent — sessions, context reconstruction, compaction",
    available: true,
    storage: ["~/.pi/agent/sessions/"],
  },
  {
    id: "claude",
    name: "Claude Code",
    description: "~/.claude/projects/*.jsonl (adapter planned)",
    available: false,
    storage: ["~/.claude/projects/"],
  },
  {
    id: "opencode",
    name: "opencode",
    description: "~/.local/share/opencode/opencode.db (adapter planned)",
    available: false,
    storage: ["~/.local/share/opencode/"],
  },
  {
    id: "codex",
    name: "Codex",
    description: "~/.codex/sessions/ (adapter planned)",
    available: false,
    storage: ["~/.codex/sessions/"],
  },
  {
    id: "cmd",
    name: "Command Code",
    description: "~/.commandcode/projects/ (adapter planned)",
    available: false,
    storage: ["~/.commandcode/projects/"],
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "state.vscdb blobs (adapter planned)",
    available: false,
    storage: ["~/.config/Cursor/"],
  },
  {
    id: "vscode",
    name: "VS Code",
    description: "github.copilot-chat session-store.db (adapter planned)",
    available: false,
    storage: ["~/.config/Code - Insiders/"],
  },
];

export function getTool(tool: AgentTool): ToolInfo {
  return TOOLS.find((t) => t.id === tool)!;
}

/** Discover sessions for a tool. Only Pi is wired in v1. */
export function discoverSessions(tool: AgentTool): SessionMeta[] {
  switch (tool) {
    case "pi":
      return discoverPi();
    default:
      return [];
  }
}
