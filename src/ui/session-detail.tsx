import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useMemo, useState } from "react"
import { Header, KeyHint, useSelection } from "./components.tsx"
import type { AgentSession, ContentBlockView, NormalizedMessage, SessionEventView, SessionMeta, Turn } from "../adapters/types.ts"

/** Max lines of tool-result body to show. */
const MAX_TOOL_RESULT_LINES = 4;
/** Max blocks rendered per message (overflow = "…N more lines"). */
const MAX_BLOCK_LINES = 400;

interface Line {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  indent?: number;
  /** The block this line came from (for cursor navigation). */
  blockIndex: number;
  /** The turn this line belongs to. */
  turnIndex: number;
  /** Message index within turn. */
  msgIndex: number;
  /** Line type for keybinding routing. */
  kind: "header" | "user" | "assistant" | "thinking" | "toolCall" | "toolResult" | "event" | "cursor";
}

export function SessionDetail({
  session,
  meta,
  onOpenContext,
  onOpenSysPrompt,
  onOpenFiles,
  onBack,
}: {
  session: AgentSession;
  meta: SessionMeta;
  onOpenContext: () => void;
  onOpenSysPrompt: () => void;
  onOpenFiles: () => void;
  onBack: () => void;
}) {
  const { width: columns, height: rows } = useTerminalDimensions();
  const [showThinking, setShowThinking] = useState(false);
  // selected line index in lines[]
  const [cursor, setCursor] = useState(0);

  const lines: Line[] = useMemo(() => {
    const result: Line[] = [];
    let blockIdx = 0;
    for (const turn of session.turns) {
      // turn header
      buildTurnHeader(result, turn, blockIdx);
      blockIdx++;

      // user message
      if (turn.userMessage) {
        appendMessageLines(result, turn.userMessage, blockIdx, turn.index, -1, "header");
        blockIdx++;
      }

      // assistant calls + events
      for (let ai = 0; ai < turn.assistantCalls.length; ai++) {
        const call = turn.assistantCalls[ai];
        if (!call) continue;

        // usage line
        const input = call.usage?.input ?? 0;
        const output = call.usage?.output ?? 0;
        const cache = call.usage?.cacheRead ?? 0;
        const cacheW = call.usage?.cacheWrite ?? 0;
        const usageLine = cacheW > 0
          ? `  [in ${fmt(input)} · cache ${fmt(cache)} · cacheW ${fmt(cacheW)} · out ${fmt(output)}]`
          : `  [in ${fmt(input)} · cache ${fmt(cache)} · out ${fmt(output)}]`;
        result.push({ text: usageLine, color: "gray", dim: true, blockIndex: blockIdx, turnIndex: turn.index, msgIndex: ai, kind: "header" });
        blockIdx++;

        // blocking: reasoning (thinking)
        for (const b of call.blocks) {
          if (b.kind === "thinking" || b.kind === "reasoning") {
            const txt = (b.text ?? "").slice(0, MAX_BLOCK_LINES);
            const thinker = showThinking ? txt : `  [thinking ${txt.slice(0, 60)}${txt.length > 60 ? "…" : ""}]`;
            result.push({ text: thinker, color: "yellow", dim: !showThinking, blockIndex: blockIdx, turnIndex: turn.index, msgIndex: ai, kind: "thinking" });
            blockIdx++;
          }
        }

        // text reply
        for (const b of call.blocks) {
          if (b.kind === "text") {
            const txt = (b.text ?? "").slice(0, MAX_BLOCK_LINES);
            for (const line of txt.split("\n")) {
              result.push({ text: line, color: "white", blockIndex: blockIdx, turnIndex: turn.index, msgIndex: ai, kind: "assistant" });
              blockIdx++;
            }
          }
        }

        // tool calls in the assistant blocks
        for (const b of call.blocks) {
          if (b.kind === "tool_use") {
            const inputPreview = b.input ? JSON.stringify(b.input).slice(0, 120) : "";
            result.push({ text: `  ⛭ ${b.toolName ?? "tool"}(${inputPreview})`, color: "cyan", dim: true, blockIndex: blockIdx, turnIndex: turn.index, msgIndex: ai, kind: "toolCall" });
            blockIdx++;
          }
        }
      }

      // tool results
      for (const tr of turn.toolResults) {
        const txt = tr.blocks.map((b) => b.text ?? "").join("\n").slice(0, MAX_TOOL_RESULT_LINES * 80);
        const lines = txt.split("\n").slice(0, MAX_TOOL_RESULT_LINES);
        for (const l of lines) {
          result.push({ text: `  ↩ ${tr.toolName ?? "tool"}: ${l.slice(0, 120)}`, color: "gray", dim: true, blockIndex: blockIdx, turnIndex: turn.index, msgIndex: -1, kind: "toolResult" });
          blockIdx++;
        }
        if (txt.split("\n").length > MAX_TOOL_RESULT_LINES) {
          result.push({ text: `  … (${txt.split("\n").length - MAX_TOOL_RESULT_LINES} more lines)`, color: "gray", dim: true, blockIndex: blockIdx, turnIndex: turn.index, msgIndex: -1, kind: "toolResult" });
          blockIdx++;
        }
      }

      // events
      for (const e of turn.events) {
        buildEventLine(result, e, blockIdx, turn.index);
        blockIdx++;
      }

      // closing line
      result.push({ text: "  └─", color: "gray", dim: true, blockIndex: blockIdx, turnIndex: turn.index, msgIndex: -1, kind: "event" });
      blockIdx++;
    }
    return result;
  }, [session, showThinking]);

  // clamp cursor
  const safeCursor = Math.min(cursor, Math.max(0, lines.length - 1));
  const cursorLine = lines[safeCursor];

  useKeyboard((key) => {
    if (key.name === "down" || key.name === "j") setCursor((c) => Math.min(c + 1, Math.max(0, lines.length - 1)));
    else if (key.name === "up" || key.name === "k") setCursor((c) => Math.max(0, c - 1));
    else if (key.name === "pageDown") setCursor((c) => Math.min(c + 10, Math.max(0, lines.length - 1)));
    else if (key.name === "pageUp") setCursor((c) => Math.max(0, c - 10));
    else if (key.name === "home") setCursor(0);
    else if (key.name === "end") setCursor(Math.max(0, lines.length - 1));
    else if (key.name === "t") setShowThinking((s) => !s);
    else if (key.name === "c") onOpenContext();
    else if (key.name === "s") onOpenSysPrompt();
    else if (key.name === "f") onOpenFiles();
    else if (key.name === "q" || key.name === "escape") onBack();
  });

  // window into lines
  const half = Math.max(1, Math.floor((rows - 5) / 2));
  const start = Math.max(0, Math.min(safeCursor - half, Math.max(0, lines.length - (rows - 5))));
  const visible = lines.slice(start, start + rows - 5);
  const subtitle = `${meta.name ?? meta.id.slice(0, 8)}  ${meta.cwd || meta.project} · ${session.turns.length} turns · ${session.assistantCalls.length} LLM requests · ${lines.length} lines`;

  return (
    <box flexDirection="column" width="100%" height={rows}>
      <Header title={meta.name ?? meta.id.slice(0, 8)} subtitle={subtitle} />
      <box flexDirection="column" flexGrow={1}>
        {visible.map((line, i) => {
          const absIdx = start + i;
          const isCursor = absIdx === safeCursor;
          return (
            <text
              key={absIdx}
              fg={line.color}
              attributes={
                ((line.bold || isCursor) ? TextAttributes.BOLD : 0) |
                (line.dim ? TextAttributes.DIM : 0)
              }
            >
              {isCursor ? "▶ " : "  "}{line.text}
            </text>
          );
        })}
      </box>
      <KeyHint keys={[
        ["scroll", "j/k"],
        ["context", "c"],
        ["system prompt", "s"],
        ["files", "f"],
        ["show thinking", "t"],
        ["back", "q"],
      ]} />
    </box>
  );
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}

function buildTurnHeader(out: Line[], turn: Turn, blockIndex: number) {
  const model = turn.model ?? "—";
  const mode = turn.thinkingLevel ? `· think:${turn.thinkingLevel}` : "";
  const reqs = turn.assistantCalls.length;
  const ctx = turn.usage.input + turn.usage.cacheRead;
  const line = `┌─ turn ${turn.index} ${model} ${mode} · ${reqs} req${reqs !== 1 ? "s" : ""} · ctx ${fmt(ctx)}`;
  out.push({ text: line, color: "cyan", bold: true, blockIndex, turnIndex: turn.index, msgIndex: -1, kind: "header" });
}

function appendMessageLines(out: Line[], msg: NormalizedMessage, blockIndex: number, turnIdx: number, msgIdx: number, kind: Line["kind"]) {
  const txt = msg.blocks
    .filter((b) => b.kind === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  const lines = txt.split("\n").slice(0, MAX_BLOCK_LINES);
  for (const l of lines) {
    out.push({
      text: l.slice(0, 600),
      color: msg.role === "user" ? "green" : "white",
      dim: msg.role !== "user",
      blockIndex,
      turnIndex: turnIdx,
      msgIndex: msgIdx,
      kind,
    });
  }
}

function buildEventLine(out: Line[], e: SessionEventView, blockIndex: number, turnIndex: number) {
  const prefix = e.kind === "compaction" ? "╒" : "◈";
  const color = e.kind === "compaction" ? "yellow" : "gray";
  const t = e.kind === "compaction" ? `╒ COMPACTION: ${e.detail?.slice(0, 160) ?? ""}` : `◈ ${e.detail?.slice(0, 160) ?? ""}`;
  out.push({ text: t, color, dim: true, blockIndex, turnIndex, msgIndex: -1, kind: "event" });
}
