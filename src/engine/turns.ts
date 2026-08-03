/**
 * Turn-level aggregation and token math over the normalized session model.
 * Turn boundaries are computed by the adapters; this module summarizes them.
 */
import type { SessionMeta, Turn } from "../adapters/types.ts";
import { contextTokens } from "./tokens.ts";

export interface TurnSummary {
  index: number;
  timestamp: number;
  /** first user text (truncated for lists) */
  userText: string;
  requests: number;
  toolCalls: number;
  contextTokens: number; // last request's context size in this turn
  maxContextTokens: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compaction: boolean;
  model: string | null;
}

export function userTextOf(turn: Turn, maxLen = 140): string {
  const blocks = turn.userMessage?.blocks ?? [];
  const text = blocks
    .filter((b) => b.kind === "text" && b.text)
    .map((b) => b.text!.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
  if (!text) return "(no text)";
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

export function summarizeTurn(turn: Turn): TurnSummary {
  const requests = turn.assistantCalls.length;
  const last = turn.assistantCalls[turn.assistantCalls.length - 1];
  const maxContextTokens = Math.max(
    0,
    ...turn.assistantCalls.map((c) => contextTokens(c.usage?.input ?? 0, c.usage?.cacheRead ?? 0)),
  );
  const toolCalls = turn.toolResults.length;
  return {
    index: turn.index,
    timestamp: turn.timestamp,
    userText: userTextOf(turn),
    requests,
    toolCalls,
    contextTokens: last ? contextTokens(last.usage?.input ?? 0, last.usage?.cacheRead ?? 0) : 0,
    maxContextTokens,
    tokens: { ...turn.usage },
    compaction: turn.events.some((e) => e.kind === "compaction"),
    model: turn.model,
  };
}

export function sessionTokenTotals(turns: Turn[]): SessionMeta["tokens"] {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const t of turns) {
    totals.input += t.usage.input;
    totals.output += t.usage.output;
    totals.cacheRead += t.usage.cacheRead;
    totals.cacheWrite += t.usage.cacheWrite;
  }
  return totals;
}
