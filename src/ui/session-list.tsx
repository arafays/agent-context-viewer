/**
 * Session list screen: searchable, metadata (model, tokens, compaction badge).
 */
import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { Header, KeyHint, ListKeyBindings, ScrollList, useSelection } from "./components.tsx";
import type { SessionMeta } from "../adapters/types.ts";
import { getTool } from "../adapters/registry.ts";
import { formatTokens, relativeTime, shortDateTime } from "../engine/tokens.ts";

export function SessionList({
  tool,
  project,
  sessions,
  onOpen,
  onBack,
}: {
  tool: SessionMeta["tool"];
  project: string | null;
  sessions: SessionMeta[];
  onOpen: (session: SessionMeta) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        (s.model ?? "").toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.name ?? "").toLowerCase().includes(q) ||
        s.path.toLowerCase().includes(q),
    );
  }, [sessions, query]);
  const sel = useSelection(filtered.length);

  ListKeyBindings({
    move: sel.move,
    onOpen: () => filtered[sel.selected] && onOpen(filtered[sel.selected]!),
    extra: (input, key) => {
      if (searching) {
        if (key.escape) setSearching(false);
        else if (key.return) setSearching(false);
        else if (key.backspace) setQuery((q) => q.slice(0, -1));
        else if (input && input.length === 1) setQuery((q) => q + input);
        return;
      }
      if (input === "q" || key.escape) onBack();
      else if (input === "/") {
        setSearching(true);
        setQuery("");
      }
    },
  });

  const toolName = getTool(tool).name;
  const title = project ? `${toolName} — ${project}` : `All ${toolName} sessions`;

  return (
    <Box flexDirection="column">
      <Header title={title} subtitle={`${sessions.length} sessions`} />
      <Box paddingLeft={1}>
        <Text dimColor>{"model".padEnd(34)}started        msgs   in        cache      cmp</Text>
      </Box>
      <ScrollList
        items={filtered}
        selected={sel.selected}
        onSelect={sel.setSelected}
        topOffset={3}
        bottomOffset={1}
        renderItem={(s, _i, isSel) => {
          const model = (s.model ?? "—").padEnd(30);
          const date = shortDateTime(s.startedAt).padEnd(18);
          const msgs = String(s.messageCount).padStart(4).padEnd(6);
          const input = formatTokens(s.tokens.input).padStart(6).padEnd(8);
          const cache = formatTokens(s.tokens.cacheRead).padStart(8).padEnd(10);
          const comp = s.compactionCount > 0 ? `⚒ ${s.compactionCount}` : "·";
          const line = `${model} ${date} ${msgs} ${input} ${cache} ${comp}  ${s.cwd || s.path}`;
          return (
            <Box paddingLeft={1} flexDirection="column">
              <Text color={isSel ? "cyan" : "dim"} bold={isSel} wrap="truncate-end">
                {isSel ? "▶ " : "  "}
                {line}
              </Text>
            </Box>
          );
        }}
      />
      <Box paddingLeft={1} paddingTop={1}>
        {searching ? (
          <Text bold color="green">
            / <Text>{query}</Text>
            <Text dimColor>▌</Text>
          </Text>
        ) : (
          <KeyHint
            keys={[
              ["j/k", "scroll"],
              ["/", "search"],
              ["Enter", "open"],
              ["q", "back"],
            ]}
          />
        )}
      </Box>
    </Box>
  );
}
