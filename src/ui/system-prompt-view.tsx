/**
 * System Prompt view — the reconstructed system prompt for a session,
 * with the AGENTS.md/CLAUDE.md files and skills that were injected.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { Header, KeyHint, ListKeyBindings, Spinner, useSelection, useTerminalSize } from "./components.tsx";
import type { PiSession } from "../adapters/pi/index.ts";
import { buildSessionContextInfo } from "../adapters/pi/context.ts";

export function SystemPromptView({ session, onBack }: { session: PiSession; onBack: () => void }) {
  const info = useMemo(() => buildSessionContextInfo(session.entries, session.meta.cwd), [session]);

  const lines = useMemo(() => {
    const l: string[] = [];
    l.push(`SYSTEM PROMPT (reconstructed from pi@0.83.0 — AGENTS.md as of today)`);
    l.push(`tools: ${info.tools.join(", ")}`);
    l.push(`context files: ${info.contextFiles.map((f) => f.path).join(" | ") || "(none)"}`);
    l.push(`skills: ${info.skills.map((s) => s.name).join(", ") || "(none)"}`);
    if (info.notes.length) l.push(`notes: ${info.notes.join("; ")}`);
    l.push("");
    l.push(...info.systemPrompt.split("\n"));
    return l;
  }, [info]);

  const sel = useSelection(lines.length);
  const { rows } = useTerminalSize();
  ListKeyBindings({ move: sel.move, onOpen: () => {}, extra: (input, key) => (input === "q" || key.escape) && onBack() });

  return (
    <Box flexDirection="column">
      <Header
        title={`System prompt — ${session.meta.id.slice(0, 8)}`}
        subtitle={`${session.meta.cwd} · reconstructed`}
      />
      <ScrollableText lines={lines} selected={sel.selected} topOffset={3} bottomOffset={1} />
      <Box paddingLeft={1} paddingTop={1}>
        <KeyHint keys={[["j/k", "scroll"], ["q", "back"]]} />
      </Box>
    </Box>
  );
}

/** Simple virtualized text scroller. */
export function ScrollableText({
  lines,
  selected,
  topOffset,
  bottomOffset,
}: {
  lines: string[];
  selected: number;
  topOffset: number;
  bottomOffset: number;
}) {
  const { rows } = useTerminalSize();
  const viewport = Math.max(1, rows - topOffset - bottomOffset - 1);
  const count = lines.length;
  const safe = Math.min(Math.max(0, selected), Math.max(0, count - 1));
  const start = Math.max(0, Math.min(safe - Math.floor(viewport / 2), Math.max(0, count - viewport)));
  const visible = lines.slice(start, start + viewport);
  return (
    <Box flexDirection="column">
      {visible.map((l, i) => (
        <Text key={start + i} wrap="truncate-end">
          {start + i === safe ? "▶ " : "  "}
          {l}
        </Text>
      ))}
    </Box>
  );
}
