import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef } from "react";
import { Header, KeyHint, useSelection, useFuzzyFilter } from "./components.tsx";
import { overlayOpen } from "./overlay.ts";
import type { Theme } from "./theme.ts";
import { tildeHome } from "./util.ts";
import { TOOLS } from "../adapters/registry.ts";
import type { AgentTool, SessionMeta } from "../adapters/types.ts";
import type { SearchIndex } from "../engine/search-index.ts";
import type { ScrollBoxRenderable } from "@opentui/core";

export function groupByProject(sessions: SessionMeta[]): Array<{
  project: string;
  count: number;
  totalTokens: number;
  lastActive: string;
  sessions: SessionMeta[];
}> {
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

/** Stable scrollbox child id for a project row (0..N-1) or the "all" row (N). */
function projRowId(index: number): string {
  return `proj-row-${index}`;
}

export function Home({
  sessionsByTool,
  discovery,
  index,
  theme,
  onOpenProject,
  onOpenAll,
  onQuit,
  initialTool = "pi",
}: {
  sessionsByTool: Record<AgentTool, SessionMeta[]>;
  discovery: Record<AgentTool, "pending" | "loading" | "done" | "error">;
  index: SearchIndex | null;
  theme: Theme;
  onOpenProject: (tool: AgentTool, project: string) => void;
  onOpenAll: (tool: AgentTool) => void;
  onQuit: () => void;
  initialTool?: AgentTool;
}) {
  const tools = TOOLS;
  const initialIdx = Math.max(
    0,
    tools.findIndex((t) => t.id === initialTool),
  );
  const toolSel = useSelection(tools.length, initialIdx);
  const projScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const activeTool = tools[toolSel.selected]!;
  const sessions = sessionsByTool[activeTool.id] ?? [];
  const groups = useMemo(() => groupByProject(sessions), [sessions]);
  const filter = useFuzzyFilter(index, activeTool.id);

  // fff-backed fuzzy filter: a project stays visible when any of its sessions match.
  const visibleGroups = useMemo(() => {
    if (!filter.active || !index?.ready) return groups;
    const ids = new Set(index.search(filter.query, activeTool.id).map((h) => h.meta.id));
    return groups.filter((g) => g.sessions.some((s) => ids.has(s.id)));
  }, [groups, index, filter.active, filter.query, activeTool.id]);

  const projSel = useSelection(visibleGroups.length + 1); // +1 for "all"
  // Keep the selection valid when filtering shrinks the project list.
  useEffect(() => {
    projSel.clamp();
  }, [visibleGroups.length]);
  const { width: columns, height: rows } = useTerminalDimensions();

  // Border takes 2 chars (left+right). Padding takes 2 (1 each side).
  const borderPad = 4;
  const paneWidth = Math.floor(columns / 2);
  const toolPaneWidth = Math.max(20, Math.min(30, paneWidth));
  const projPaneWidth = columns - toolPaneWidth;
  const toolContentWidth = toolPaneWidth - borderPad;
  const projContentWidth = projPaneWidth - borderPad;

  // Projects pane height: root rows − header(2) − keyhint(1) − border(2) −
  // pinned title row(1). The scrollbox gets this exact height so its viewport
  // is bounded (Yoga would otherwise let the content grow and never clip).
  const projPaneInnerRows = Math.max(1, rows - 3 - 2 - 1);

  // Tool pane rows: rows − header(2) − keyhint(1) − border(2) − title(1).
  // Window around the selected tool so it stays visible on short terminals.
  const toolPaneInnerRows = Math.max(1, rows - 3 - 2 - 1);
  const totalTools = tools.length;
  let toolStart = 0;
  if (totalTools > toolPaneInnerRows) {
    toolStart = Math.max(
      0,
      Math.min(
        toolSel.selected - Math.floor(toolPaneInnerRows / 2),
        totalTools - toolPaneInnerRows,
      ),
    );
  }
  const visibleTools = tools.slice(toolStart, toolStart + toolPaneInnerRows);

  // Keep the selected project row in view. scrollChildIntoView uses DOM-style
  // "nearest" behavior: no-op if visible, otherwise scrolls the minimum amount
  // to reveal it — robust to any viewport height.
  useEffect(() => {
    const sc = projScrollRef.current;
    if (!sc) return;
    const id = projRowId(projSel.selected);
    sc.scrollChildIntoView(id);
  }, [projSel.selected, visibleGroups.length]);

  const selectTool = (d: number) => {
    const next = (toolSel.selected + d + tools.length) % tools.length;
    toolSel.setSelected(next);
    projSel.setSelected(0);
  };

  useKeyboard((key) => {
    if (overlayOpen.current) return;
    // while the inline filter is open, keys drive the query (except Enter opens)
    if (filter.open) {
      if (key.name === "return" || key.name === "enter") {
        const s = projSel.selected;
        if (s === visibleGroups.length) {
          onOpenAll(activeTool.id);
        } else {
          const g = visibleGroups[s];
          if (g) onOpenProject(activeTool.id, g.project);
        }
        return;
      }
      if (filter.handleKey(key)) return;
    }
    if (key.name === "down" || key.name === "j") {
      // project pane scroll
      projSel.move(1);
    } else if (key.name === "up" || key.name === "k") {
      projSel.move(-1);
    } else if (key.name === "return") {
      const s = projSel.selected;
      if (s === visibleGroups.length) {
        onOpenAll(activeTool.id);
      } else {
        const g = visibleGroups[s];
        if (g) onOpenProject(activeTool.id, g.project);
      }
    } else if (key.name === "tab") {
      selectTool(1);
    } else if (key.name === "g" && !key.shift && !key.ctrl) {
      selectTool(-1);
    } else if (key.name === "g" && key.shift && !key.ctrl) {
      selectTool(1);
    } else if (key.name === "/") {
      filter.toggle();
    } else if ((key.name === "q" || key.name === "escape") && !key.ctrl) {
      if (filter.open) filter.toggle();
      else if (!key.shift) onQuit();
    }
  });

  const toolRows = visibleTools.map((t, i) => {
    const sel = toolStart + i === toolSel.selected;
    const n = sessionsByTool[t.id]?.length ?? 0;
    const status = discovery[t.id] ?? "pending";
    const prefix = sel ? "▶ " : "  ";
    // unavailable tools never get a discovery status — show a dash, not a spinner
    const err = status === "error";
    const busy = !err && t.available && (status === "pending" || status === "loading");
    const countLabel = busy ? " …" : err ? " !" : n > 0 ? ` ${n}` : " —";
    const label = `${t.name}${countLabel}`;
    const full = prefix + label;
    const truncated =
      full.length > toolContentWidth ? full.slice(0, toolContentWidth - 1) + "…" : full;
    return (
      <text
        key={t.id}
        attributes={sel ? TextAttributes.BOLD : TextAttributes.DIM}
        fg={sel ? theme.accent : undefined}
      >
        {busy ? `⠋ ${truncated}` : truncated}
      </text>
    );
  });

  // Project rows + the trailing "all sessions" row. Each row has a stable id so
  // the scrollbox can scrollChildIntoView() the selection.
  const projRows = [
    ...visibleGroups.map((g, i) => {
      const sel = i === projSel.selected;
      const prefix = sel ? "▶ " : "  ";
      const tokens =
        g.totalTokens >= 1_000_000
          ? `${(g.totalTokens / 1_000_000).toFixed(1)}M`
          : g.totalTokens >= 1_000
            ? `${(g.totalTokens / 1_000).toFixed(1)}k`
            : String(g.totalTokens);
      const label = `${tildeHome(g.project)}  ${tokens} · ${g.count}s`;
      const full = prefix + label;
      const truncated =
        full.length > projContentWidth ? full.slice(0, projContentWidth - 1) + "…" : full;
      return (
        <text
          key={g.project}
          id={projRowId(i)}
          attributes={sel ? TextAttributes.BOLD : TextAttributes.DIM}
          fg={sel ? theme.accent : undefined}
        >
          {truncated}
        </text>
      );
    }),
    // "all sessions" row (last selection index)
    (() => {
      const allIdx = visibleGroups.length;
      const sel = allIdx === projSel.selected;
      const prefix = sel ? "▶ " : "  ";
      const label = `${prefix}all ${activeTool.name} sessions`;
      const truncated =
        label.length > projContentWidth ? label.slice(0, projContentWidth - 1) + "…" : label;
      return (
        <text
          key="__all__"
          id={projRowId(allIdx)}
          attributes={sel ? TextAttributes.BOLD : TextAttributes.DIM}
          fg={sel ? theme.accent : undefined}
        >
          {truncated}
        </text>
      );
    })(),
  ];

  const projCount = visibleGroups.length;

  return (
    <box flexDirection="column" width="100%" height={rows}>
      <Header
        title="Agent Context Viewer"
        subtitle="how agents load context — system prompts · AGENTS.md · before/after per prompt"
        theme={theme}
      />
      <box flexDirection="row" flexGrow={1}>
        <box
          flexDirection="column"
          width={toolPaneWidth}
          borderStyle="rounded"
          borderColor={theme.border}
        >
          <text attributes={TextAttributes.BOLD} fg={theme.toolResult}>
            {" "}
            TOOLS
          </text>
          {toolRows}
        </box>
        <box
          flexDirection="column"
          width={projPaneWidth}
          borderStyle="rounded"
          borderColor={theme.border}
        >
          <box>
            <text attributes={TextAttributes.BOLD} fg={theme.toolResult}>
              {" PROJECTS — "}
              {activeTool.name}
              {" · "}
              {projCount}
              {projCount === 1 ? " project" : " projects"}
            </text>
          </box>
          <box flexGrow={1}>
            <scrollbox
              ref={projScrollRef}
              height={projPaneInnerRows}
              flexGrow={1}
              scrollX={false}
              scrollY={true}
              stickyScroll={false}
              viewportCulling={true}
            >
              {filter.open ? (
                <box flexDirection="row" paddingLeft={1} paddingRight={1}>
                  <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                    /{" "}
                  </text>
                  <text>{filter.query || " "}</text>
                  <text attributes={TextAttributes.DIM} fg={theme.border}>
                    ▏
                  </text>
                </box>
              ) : null}
              {projRows.length > 0 ? (
                projRows
              ) : (
                <text attributes={TextAttributes.DIM} fg={theme.toolResult}>
                  (no sessions)
                </text>
              )}
            </scrollbox>
          </box>
        </box>
      </box>
      <KeyHint
        keys={[
          ["move", "j/k"],
          ["search", "/"],
          ["open", "Enter"],
          ["tool", "Tab/g/G"],
          ["quit", "q"],
          ["help", "?"],
          ["quit app", "Q"],
        ]}
        theme={theme}
      />
    </box>
  );
}
