/**
 * Home screen: pick an agent tool, then a project, to browse its sessions.
 */
import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { Header, KeyHint, ListKeyBindings, ScrollList, useSelection, useTerminalSize } from "./components.tsx";
import type { AgentTool, SessionMeta } from "../adapters/types.ts";
import { TOOLS, getTool } from "../adapters/registry.ts";
import { relativeTime } from "../engine/tokens.ts";

export interface ProjectGroup {
  project: string;
  tool: AgentTool;
  sessions: SessionMeta[];
  totalTokens: number;
  lastActive: string;
}

export function groupByProject(sessions: SessionMeta[]): ProjectGroup[] {
  const map = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const list = map.get(s.project) ?? [];
    list.push(s);
    map.set(s.project, list);
  }
  const groups: ProjectGroup[] = [];
  for (const [project, list] of map) {
    const sorted = [...list].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    groups.push({
      project,
      tool: sorted[0]!.tool,
      sessions: sorted,
      totalTokens: sorted.reduce((acc, s) => acc + s.tokens.input + s.tokens.cacheRead, 0),
      lastActive: sorted[0]!.startedAt,
    });
  }
  return groups.sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
}

export function Home({
  sessionsByTool,
  onOpenProject,
  onOpenAll,
  onQuit,
}: {
  sessionsByTool: Record<AgentTool, SessionMeta[]>;
  onOpenProject: (tool: AgentTool, project: string) => void;
  onOpenAll: (tool: AgentTool) => void;
  onQuit: () => void;
}) {
  const tools = TOOLS;
  const toolSel = useSelection(tools.length);
  const activeTool = tools[toolSel.selected]!;
  const sessions = sessionsByTool[activeTool.id] ?? [];
  const groups = useMemo(() => groupByProject(sessions), [sessions]);
  const projSel = useSelection(groups.length + 1); // +1 for "all sessions"
  const { rows } = useTerminalSize();
  const [search, setSearch] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filteredGroups = useMemo(() => {
    if (!query.trim()) return groups;
    const q = query.toLowerCase();
    return groups.filter((g) => g.project.toLowerCase().includes(q));
  }, [groups, query]);

  const allIndex = filteredGroups.length; // "all sessions" is the last row
  const projCount = filteredGroups.length + 1;
  const safeProjSel = Math.min(projSel.selected, Math.max(0, projCount - 1));
  const isAll = safeProjSel === allIndex;

  const open = () => {
    const sel = Math.min(projSel.selected, Math.max(0, projCount - 1));
    if (sel === filteredGroups.length) onOpenAll(activeTool.id);
    else onOpenProject(activeTool.id, filteredGroups[sel]!.project);
  };

  const selectTool = (d: number) => {
    toolSel.move(d);
    projSel.setSelected(0);
  };

  ListKeyBindings({
    move: projSel.move,
    onOpen: open,
    extra: (input, key) => {
      if (search !== null) {
        if (key.escape) setSearch(null);
        else if (key.return) setSearch(null);
        else if (key.backspace) setQuery((q) => q.slice(0, -1));
        else if (input && input.length === 1) setQuery((q) => q + input);
        return;
      }
      if (input === "q") onQuit();
      else if (input === "g") selectTool(-1);
      else if (input === "G") selectTool(1);
      else if (input === "/") {
        setSearch("");
        setQuery("");
      }
    },
  });

  const toolPaneWidth = Math.min(34, Math.floor((process.stdout.columns ?? 80) / 3));

  return (
    <Box flexDirection="column">
      <Header
        title="Agent Context Viewer"
        subtitle="how agents load context — system prompts · AGENTS.md · before/after per prompt"
      />
      <Box>
        {/* tool pane */}
        <Box flexDirection="column" width={toolPaneWidth} borderStyle="round" borderColor="gray">
          <Text bold color="gray">
            {" "}AGENTS
          </Text>
          {tools.map((t, i) => {
            const sel = i === toolSel.selected;
            const n = sessionsByTool[t.id]?.length ?? 0;
            return (
              <Box key={t.id} paddingLeft={1}>
                <Text color={sel ? "cyan" : "dim"} bold={sel}>
                  {sel ? "▶ " : "  "}
                  {t.name.padEnd(14)}
                </Text>
                <Text color={n > 0 ? "green" : "gray"} dimColor={!sel}>
                  {n > 0 ? `${n} sessions` : "—"}
                </Text>
              </Box>
            );
          })}
        </Box>
        {/* project pane */}
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray">
          <Box paddingLeft={1}>
            <Text bold color="gray">
              {" "}PROJECTS — {activeTool.name}
            </Text>
          </Box>
          {activeTool.available ? (
            <ScrollList
              items={filteredGroups}
              selected={safeProjSel}
              onSelect={projSel.setSelected}
              topOffset={1}
              bottomOffset={1}
              renderItem={(g, i, sel) => (
                <Box paddingLeft={1} flexDirection="column">
                  <Box>
                    <Text color={sel ? "cyan" : "dim"} bold={sel}>
                      {sel ? "▶ " : "  "}
                      {g.project}
                    </Text>
                    <Text dimColor>  {g.sessions.length} sessions</Text>
                  </Box>
                  <Box paddingLeft={4}>
                    <Text dimColor>
                      {g.totalTokens.toLocaleString()} tokens · last {relativeTime(g.lastActive)}
                    </Text>
                  </Box>
                </Box>
              )}
            />
          ) : (
            <Box paddingLeft={2} paddingTop={1}>
              <Text dimColor>Adapter not implemented yet — data lives at:</Text>
            </Box>
          )}
          <Box paddingLeft={1} paddingBottom={1}>
            <Text color={isAll ? "cyan" : "dim"} bold={isAll}>
              {isAll ? "▶ " : "  "}
              <Text bold={isAll}>all {activeTool.name} sessions</Text>
              <Text dimColor>  ({sessions.length})</Text>
            </Text>
          </Box>
        </Box>
      </Box>
      {search !== null ? (
        <Box paddingLeft={1} paddingTop={1}>
          <Text bold color="green">
            /{" "}
          </Text>
          <Text>{query}</Text>
          <Text dimColor>▌</Text>
        </Box>
      ) : (
        <Box paddingLeft={1} paddingTop={1}>
          <KeyHint
            keys={[
              ["j/k", "move"],
              ["Tab/g/G", "tool"],
              ["/", "search"],
              ["Enter", "open"],
              ["q", "quit"],
            ]}
          />
        </Box>
      )}
    </Box>
  );
}
