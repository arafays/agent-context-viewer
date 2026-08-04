import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useMemo, useState } from "react"
import { Header, KeyHint, useSelection } from "./components.tsx"
import { TOOLS } from "../adapters/registry.ts"
import type { AgentTool, SessionMeta } from "../adapters/types.ts"

export function groupByProject(sessions: SessionMeta[]): Array<{ project: string; count: number; totalTokens: number; lastActive: string; sessions: SessionMeta[] }> {
  const map = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const key = s.project || s.cwd || "(root)";
    const arr = map.get(key) ?? [];
    arr.push(s);
    map.set(key, arr);
  }
  return [...map.entries()]
    .map(([project, ss]) => ({
      project,
      count: ss.length,
      totalTokens: ss.reduce((a, b) => a + b.tokens.input + b.tokens.cacheRead, 0),
      lastActive: ss.reduce((latest, s) => (s.updatedAt > latest ? s.updatedAt : latest), ""),
      sessions: ss,
    }))
    .sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
}

export function Home({
  sessionsByTool,
  onOpenProject,
  onOpenAll,
  onQuit,
  initialTool = "pi",
}: {
  sessionsByTool: Record<AgentTool, SessionMeta[]>;
  onOpenProject: (tool: AgentTool, project: string) => void;
  onOpenAll: (tool: AgentTool) => void;
  onQuit: () => void;
  initialTool?: AgentTool;
}) {
  const tools = TOOLS;
  const initialIdx = Math.max(0, tools.findIndex((t) => t.id === initialTool));
  const toolSel = useSelection(tools.length, initialIdx);
  const activeTool = tools[toolSel.selected];
  if (!activeTool) return <text>No tool selected</text>;
  const sessions = sessionsByTool[activeTool.id] ?? [];
  const groups = useMemo(() => groupByProject(sessions), [sessions]);
  const projSel = useSelection(groups.length + 1); // +1 for "all"
  const { width: columns, height: rows } = useTerminalDimensions();
  const [search, setSearch] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const paneWidth = Math.floor((columns - 4) / 2);
  const toolPaneWidth = Math.max(20, Math.min(30, paneWidth));
  const projPaneWidth = columns - toolPaneWidth - 4;
  const toolContentWidth = toolPaneWidth - 4; // account for border + padding
  const projContentWidth = projPaneWidth - 4;

  const selectTool = (d: number) => {
    toolSel.move(d);
    projSel.setSelected(0);
  };

  useKeyboard((key) => {
    if (search !== null) {
      if (key.name === "escape") { setSearch(null); }
      else if (key.name === "return") { setSearch(null); }
      else if (key.name === "backspace") { setQuery((q) => q.slice(0, -1)); }
      else if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
        setQuery((q) => q + key.sequence);
      }
      return;
    }
    if (key.name === "down" || key.name === "j") {
      // project pane scroll
      projSel.move(1);
    } else if (key.name === "up" || key.name === "k") {
      projSel.move(-1);
    } else if (key.name === "return") {
      const s = projSel.selected;
      if (s === groups.length) {
        onOpenAll(activeTool.id);
      } else {
        const g = groups[s];
        if (g) onOpenProject(activeTool.id, g.project);
      }
    } else if (key.name === "tab") {
      selectTool(1);
    } else if (key.name === "g" && !key.shift) {
      selectTool(-1);
    } else if (key.name === "g" && key.shift) {
      selectTool(1);
    } else if (key.name === "/") {
      setSearch("");
      setQuery("");
    } else if (key.name === "q" || key.name === "escape") {
      onQuit();
    }
  });

  const safeProjSel = Math.min(projSel.selected, Math.max(0, groups.length));

  const toolRows = tools.map((t, i) => {
    const sel = i === toolSel.selected;
    const n = sessionsByTool[t.id]?.length ?? 0;
    const label = `${t.name}${n > 0 ? ` ${n}` : " —"}`;
    return (
      <text
        key={t.id}
        attributes={sel ? TextAttributes.BOLD : TextAttributes.DIM}
        fg={sel ? "cyan" : undefined}
      >
        {sel ? "▶ " : "  "}{label.length > toolContentWidth ? label.slice(0, toolContentWidth - 1) + "…" : label}
      </text>
    );
  });

  const projRows = groups.map((g, i) => {
    const sel = i === safeProjSel;
    const label = `${g.project}  ${(g.totalTokens >= 1_000_000 ? `${(g.totalTokens / 1_000_000).toFixed(1)}M` : g.totalTokens >= 1_000 ? `${(g.totalTokens / 1_000).toFixed(1)}k` : g.totalTokens)} tokens · ${g.count} sessions`;
    const truncated = label.length > projPaneWidth - 8 ? label.slice(0, projPaneWidth - 11) + "…" : label;
    return (
      <text
        key={g.project}
        attributes={sel ? TextAttributes.BOLD : TextAttributes.DIM}
        fg={sel ? "cyan" : undefined}
      >
        {sel ? "▶ " : "  "}{truncated.length > projContentWidth ? truncated.slice(0, projContentWidth - 1) + "…" : truncated}
      </text>
    );
  });

  return (
    <box flexDirection="column" width="100%" height={rows}>
      <Header
        title="Agent Context Viewer"
        subtitle="how agents load context — system prompts · AGENTS.md · before/after per prompt"
      />
      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" width={toolPaneWidth} borderStyle="rounded" borderColor="gray">
          <text attributes={TextAttributes.BOLD} fg="gray"> AGENTS</text>
          {toolRows}
        </box>
        <box flexDirection="column" width={projPaneWidth} borderStyle="rounded" borderColor="gray">
          <text attributes={TextAttributes.BOLD} fg="gray"> PROJECTS — {activeTool.name}</text>
          {projRows.length > 0 ? projRows : <text attributes={TextAttributes.DIM} fg="gray">(no sessions)</text>}
        </box>
      </box>
      <KeyHint keys={[["move", "j/k"], ["search", "/"], ["open", "Enter"], ["tool", "Tab/g/G"], ["quit", "q"]]} />
    </box>
  );
}
