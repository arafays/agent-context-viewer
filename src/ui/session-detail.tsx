/**
 * Session detail: full transcript (user prompts, thinking, tool calls + results,
 * assistant replies, compaction events) with line-based scrolling.
 */
import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { Header, KeyHint, ListKeyBindings, Spinner, useSelection, useTerminalSize } from "./components.tsx";
import type { SessionMeta, Turn } from "../adapters/types.ts";
import { loadSession, type PiSession } from "../adapters/pi/index.ts";
import { summarizeTurn, userTextOf } from "../engine/turns.ts";
import { formatTokens } from "../engine/tokens.ts";

type LineColor = "green" | "white" | "cyan" | "gray" | "yellow" | "magenta";

export interface Line {
  text: string;
  color?: LineColor;
  bold?: boolean;
  dim?: boolean;
  turn?: number;
}

const MAX_TOOL_RESULT_LINES = 4;
const MAX_BLOCK_LINES = 400;

function truncate(text: string, maxLines: number): string[] {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`];
}

function blockText(block: { kind: string; text?: string; input?: unknown; toolName?: string; isError?: boolean }): string {
  if (block.kind === "tool_use") {
    const input =
      typeof block.input === "string"
        ? block.input
        : block.input
          ? JSON.stringify(block.input)
          : "";
    return `▸ ${block.toolName ?? "tool"}${input ? "  " + truncate(input, 1)[0] : ""}`;
  }
  if (block.kind === "tool_result") {
    const prefix = block.isError ? "✗ " : "";
    return prefix + (block.text ?? "");
  }
  return block.text ?? "";
}

function buildLines(session: PiSession, showThinking: boolean): Line[] {
  const lines: Line[] = [];
  const push = (l: Line) => lines.push(l);
  for (const turn of session.turns) {
    push({ text: "", turn: turn.index });
    const sum = summarizeTurn(turn);
    const metaBits = [
      turn.model ?? "",
      turn.thinkingLevel ? `think:${turn.thinkingLevel}` : "",
      turn.assistantCalls.length > 0
        ? `${turn.assistantCalls.length} req · ctx ${formatTokens(sum.contextTokens)}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (turn.userMessage) {
      push({ text: `┌─ turn ${turn.index + 1}  ${metaBits}`, color: "gray", dim: true });
      for (const block of turn.userMessage.blocks) {
        const text = blockText(block);
        if (text.trim()) {
          for (const l of truncate(text, MAX_BLOCK_LINES)) push({ text: `│ ${l}`, color: "green", turn: turn.index });
        }
      }
    } else {
      push({ text: `┌─ turn ${turn.index + 1}  ${metaBits}`, color: "gray", dim: true });
    }
    for (const ev of turn.events) {
      if (ev.kind === "compaction") {
        push({
          text: `│ ⚒ COMPACTION: ${(ev as { tokensBefore?: number }).tokensBefore?.toLocaleString() ?? "?"} tokens compacted → summary`,
          color: "yellow",
          bold: true,
          turn: turn.index,
        });
        push({ text: `│   ${String(ev.summary ?? "").replace(/\n/g, " ").slice(0, 220)}`, color: "yellow", dim: true, turn: turn.index });
      } else if (ev.kind === "model_change") {
        push({ text: `│ ⚙ model → ${ev.detail}`, color: "magenta", dim: true, turn: turn.index });
      } else if (ev.kind === "thinking_level_change") {
        push({ text: `│ 🧠 thinking → ${ev.detail}`, color: "magenta", dim: true, turn: turn.index });
      } else if (ev.kind === "custom") {
        push({ text: `│ ◈ ${ev.detail}`, color: "gray", dim: true, turn: turn.index });
      }
    }
    for (const call of turn.assistantCalls) {
      const u = call.usage;
      const usage =
        u && (u.input > 0 || u.output > 0)
          ? `[in ${formatTokens(u.input)} · cache ${formatTokens(u.cacheRead)} · out ${formatTokens(u.output)}]`
          : "";
      push({ text: `│   ${usage}`, color: "gray", dim: true, turn: turn.index });
      for (const block of call.blocks) {
        if (block.kind === "thinking") {
          if (showThinking) {
            for (const l of truncate(block.text ?? "", 200)) push({ text: `│     ${l}`, color: "gray", dim: true, turn: turn.index });
          } else {
            push({ text: "│     [thinking …]", color: "gray", dim: true, turn: turn.index });
          }
        } else if (block.kind === "tool_use") {
          push({ text: `│     ${blockText(block)}`, color: "cyan", turn: turn.index });
        } else if (block.kind === "text" && block.text?.trim()) {
          for (const l of truncate(block.text, MAX_BLOCK_LINES)) push({ text: `│   ${l}`, color: "white", turn: turn.index });
        }
      }
    }
    for (const tr of turn.toolResults) {
      const text = tr.blocks.map((b) => blockText(b)).filter(Boolean).join("\n");
      if (!text.trim()) continue;
      const first = text.split("\n")[0] ?? "";
      push({ text: `│   ↩ ${tr.toolName ?? "tool"}${tr.isError ? " (error)" : ""}`, color: "cyan", dim: true, turn: turn.index });
      for (const l of truncate(text, MAX_TOOL_RESULT_LINES)) push({ text: `│     ${l}`, color: "gray", dim: true, turn: turn.index });
    }
    push({ text: `└─`, color: "gray", dim: true, turn: turn.index });
  }
  return lines;
}

export function SessionDetail({
  session,
  pi,
  onOpenContext,
  onOpenSystemPrompt,
  onOpenFiles,
  onBack,
}: {
  session: SessionMeta;
  pi?: PiSession;
  onOpenContext: (session: PiSession) => void;
  onOpenSystemPrompt: (session: PiSession) => void;
  onOpenFiles: (session: PiSession) => void;
  onBack: () => void;
}) {
  const [showThinking, setShowThinking] = useState(false);

  // Session parsing is synchronous; use the cached PiSession from the App when
  // available (large sessions parsed once), otherwise parse here.
  const loaded = useMemo(() => pi ?? loadSession(session.path), [pi, session.path]);
  const lines = useMemo(() => (loaded ? buildLines(loaded, showThinking) : []), [loaded, showThinking]);
  const sel = useSelection(lines.length);
  const { rows } = useTerminalSize();

  ListKeyBindings({
    move: sel.move,
    onOpen: () => loaded && onOpenContext(loaded),
    extra: (input, key) => {
      if (input === "q" || key.escape) onBack();
      else if (input === "s") loaded && onOpenSystemPrompt(loaded);
      else if (input === "f") loaded && onOpenFiles(loaded);
      else if (input === "c" || input === "v") loaded && onOpenContext(loaded);
      else if (input === "t") setShowThinking((v) => !v);
    },
  });

  return (
    <Box flexDirection="column">
      <Header
        title={session.name ?? session.id.slice(0, 8)}
        subtitle={`${session.cwd} · ${session.startedAt} · ${session.messageCount} msgs`}
      />
      <ScrollableLines lines={lines} selected={sel.selected} topOffset={3} bottomOffset={1} />
      <Box paddingLeft={1} paddingTop={1}>
        <KeyHint
          keys={[
            ["j/k", "scroll"],
            ["c", "context"],
            ["s", "system prompt"],
            ["f", "files"],
            ["t", showThinking ? "hide thinking" : "show thinking"],
            ["q", "back"],
          ]}
        />
      </Box>
    </Box>
  );
}

/** Virtualized line renderer with a selection cursor. */
function ScrollableLines({ lines, selected, topOffset, bottomOffset }: { lines: Line[]; selected: number; topOffset: number; bottomOffset: number }) {
  const { rows } = useTerminalSize();
  const viewport = Math.max(1, rows - topOffset - bottomOffset - 1);
  const count = lines.length;
  const safe = Math.min(Math.max(0, selected), Math.max(0, count - 1));
  const start = Math.max(0, Math.min(safe - Math.floor(viewport / 2), Math.max(0, count - viewport)));
  const visible = lines.slice(start, start + viewport);
  return (
    <Box flexDirection="column">
      {visible.map((l, i) => (
        <Text key={start + i} color={l.color ?? "white"} bold={l.bold} dimColor={l.dim} wrap="truncate-end">
          {start + i === safe ? "▶ " : "  "}
          {l.text}
        </Text>
      ))}
    </Box>
  );
}
