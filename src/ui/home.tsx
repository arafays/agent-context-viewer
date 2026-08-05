import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useMemo } from "react"
import { Header, KeyHint, useSelection } from "./components.tsx"
import type { Theme } from "./theme.ts"
import { tildeHome } from "./util.ts"
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
  theme,
  onOpenProject,
  onOpenAll,
  onSearch,
  onQuit,
  initialTool = "pi",
}: {
  sessionsByTool: Record<AgentTool, SessionMeta[]>;
  theme: Theme;
  onOpenProject: (tool: AgentTool, project: string) => void;
  onOpenAll: (tool: AgentTool) => void;
  /** open fuzzy search scoped to the active tool. */
  onSearch: (tool: AgentTool) => void;
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

  // Border takes 2 chars (left+right). Padding takes 2 (1 each side).
  const borderPad = 4;
  const paneWidth = Math.floor(columns / 2);
  const toolPaneWidth = Math.max(20, Math.min(30, paneWidth));
  const projPaneWidth = columns - toolPaneWidth;
  const toolContentWidth = toolPaneWidth - borderPad;
  const projContentWidth = projPaneWidth - borderPad;

  const selectTool = (d: number) => {
    toolSel.move(d);
    projSel.setSelected(0);
  };

  useKeyboard((key) => {
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
      onSearch(activeTool.id);
    } else if (key.name === "q" || key.name === "escape") {
      if (!key.shift) onQuit();
    }
  });

  const safeProjSel = Math.min(projSel.selected, Math.max(0, groups.length));

  const toolRows = tools.map((t, i) => {
    const sel = i === toolSel.selected;
    const n = sessionsByTool[t.id]?.length ?? 0;
    const prefix = sel ? "▶ " : "  ";
    const label = `${t.name}${n > 0 ? ` ${n}` : " —"}`;
    const full = prefix + label;
    const truncated = full.length > toolContentWidth ? full.slice(0, toolContentWidth - 1) + "…" : full;
    return (
      <text
        key={t.id}
        attributes={sel ? TextAttributes.BOLD : TextAttributes.DIM}
        fg={sel ? theme.accent : undefined}
      >
        {truncated}
      </text>
    );
  });

  const projRows = groups.map((g, i) => {
    const sel = i === safeProjSel;
    const prefix = sel ? "▶ " : "  ";
    const tokens = g.totalTokens >= 1_000_000 ? `${(g.totalTokens / 1_000_000).toFixed(1)}M` : g.totalTokens >= 1_000 ? `${(g.totalTokens / 1_000).toFixed(1)}k` : String(g.totalTokens);
    const label = `${tildeHome(g.project)}  ${tokens} · ${g.count}s`;
    const full = prefix + label;
    const truncated = full.length > projContentWidth ? full.slice(0, projContentWidth - 1) + "…" : full;
    return (
      <text
        key={g.project}
        attributes={sel ? TextAttributes.BOLD : TextAttributes.DIM}
        fg={sel ? theme.accent : undefined}
      >
        {truncated}
      </text>
    );
  });

  return (
    <box flexDirection="column" width="100%" height={rows}>
      <Header
        title="Agent Context Viewer"
        subtitle="how agents load context — system prompts · AGENTS.md · before/after per prompt"
        theme={theme}
      />
      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" width={toolPaneWidth} borderStyle="rounded" borderColor={theme.border}>
          <text attributes={TextAttributes.BOLD} fg={theme.toolResult}> AGENTS</text>
          {toolRows}
        </box>
        <box flexDirection="column" width={projPaneWidth} borderStyle="rounded" borderColor={theme.border}>
          <text attributes={TextAttributes.BOLD} fg={theme.toolResult}> PROJECTS — {activeTool.name}</text>
          {projRows.length > 0 ? projRows : <text attributes={TextAttributes.DIM} fg={theme.toolResult}>(no sessions)</text>}
        </box>
      </box>
      <KeyHint keys={[["move", "j/k"], ["search", "/"], ["open", "Enter"], ["tool", "Tab/g/G"], ["back", "q"], ["quit app", "Q"]]} theme={theme} />
    </box>
  );
}
