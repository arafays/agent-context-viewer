/**
 * Context View — the headline screen.
 * Token curve across every LLM request + per-request before/after diff:
 * what was added, what was pruned (compaction), and the context snapshot.
 */
import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { Header, KeyHint, ListKeyBindings, useSelection, useTerminalSize } from "./components.tsx";
import type { AgentSession } from "../adapters/types.ts";
import { buildRequestSteps, sessionCurve, type RequestStep } from "../engine/context-diff.ts";
import { formatTokens, tokenBar } from "../engine/tokens.ts";

export function ContextView({
  session,
  onOpenSystemPrompt,
  onBack,
}: {
  session: AgentSession;
  onOpenSystemPrompt: (s: AgentSession) => void;
  onBack: () => void;
}) {
  const { rows } = useTerminalSize();
  const [showSnapshots, setShowSnapshots] = useState(true);
  const [snapshotOffset, setSnapshotOffset] = useState(0);

  // All reconstruction is synchronous (vendored pi functions + file reads);
  // compute once per session.
  const { steps, curve, info } = useMemo(() => {
    const compactions = session.turns.flatMap((t) =>
      t.events
        .filter((e) => e.kind === "compaction")
        .map((e) => ({
          entryIndex: t.entryEnd,
          tokensBefore: (e as { tokensBefore?: number }).tokensBefore ?? 0,
          summary: String(e.summary ?? ""),
          readFiles: [] as string[],
          modifiedFiles: [] as string[],
        })),
    );
    return {
      steps: buildRequestSteps(session.contextPoints, compactions),
      curve: sessionCurve(session.contextPoints, compactions),
      info: session.contextInfo,
    };
  }, [session]);

  const sel = useSelection(steps.length);
  const step = steps[sel.selected];

  // window layout: header 2 + curve area + detail
  const curveHeight = Math.max(6, Math.floor(rows * 0.35));
  const detailHeight = rows - curveHeight - 6;

  ListKeyBindings({
    move: (d) => {
      sel.move(d);
      setSnapshotOffset(0);
    },
    onOpen: () => setShowSnapshots((v) => !v),
    extra: (input, key) => {
      if (input === "q" || key.escape) onBack();
      else if (input === "s") session && onOpenSystemPrompt(session);
      else if (input === "d" || input === "v") setShowSnapshots((v) => !v);
      else if (key.pageDown) setSnapshotOffset((o) => o + 12);
      else if (key.pageUp) setSnapshotOffset((o) => Math.max(0, o - 12));
    },
  });

  return (
    <Box flexDirection="column">
      <Header
        title={`Context — ${session.meta.id.slice(0, 8)}`}
        subtitle={`${session.meta.cwd} · ${session.assistantCalls.length} LLM requests`}
      />
      <CurvePane steps={steps} curve={curve} selected={sel.selected} height={curveHeight} onJump={sel.setSelected} />
      {step ? (
        <DetailPane step={step} height={detailHeight} showSnapshots={showSnapshots} snapshotOffset={snapshotOffset} />
      ) : (
        <Text dimColor>no requests</Text>
      )}
      <Box paddingLeft={1} paddingTop={1}>
        <KeyHint
          keys={[
            ["j/k", "request"],
            ["d", showSnapshots ? "snapshots" : "snapshots"],
            ["s", "system prompt"],
            ["PgUp/PgDn", "scroll"],
            ["q", "back"],
          ]}
        />
      </Box>
    </Box>
  );
}

function CurvePane({
  steps,
  curve,
  selected,
  height,
  onJump,
}: {
  steps: RequestStep[];
  curve: ReturnType<typeof sessionCurve>;
  selected: number;
  height: number;
  onJump: (i: number) => void;
}) {
  const max = Math.max(1, ...curve.map((c) => c.contextTokens));
  const window = Math.min(curve.length, height - 1);
  const start = Math.max(0, Math.min(selected - Math.floor(window / 2), Math.max(0, curve.length - window)));
  const visible = curve.slice(start, start + window);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" height={height}>
      <Text bold color="gray">
        {" "}CONTEXT TOKENS PER REQUEST (input+cacheRead) — max {formatTokens(max)}
      </Text>
      {visible.map((b, i) => {
        const idx = start + i;
        const sel = idx === selected;
        const bar = tokenBar(b.contextTokens, max, 26);
        const comp = b.compacted ? " ⚒" : "";
        const line = `${sel ? ">" : " "} #${String(b.requestIndex).padStart(3)} ${bar} ${formatTokens(b.contextTokens).padStart(6)}  in ${formatTokens(b.input).padStart(6)}  cache ${formatTokens(b.cacheRead).padStart(6)}${comp}`;
        return (
          <Box key={idx} paddingLeft={1}>
            <Text color={sel ? "cyan" : "dim"} bold={sel} wrap="truncate-end">
              {line}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function DetailPane({
  step,
  height,
  showSnapshots,
  snapshotOffset,
}: {
  step: RequestStep;
  height: number;
  showSnapshots: boolean;
  snapshotOffset: number;
}) {
  const p = step.point;
  const addedN = step.added.length;
  const prunedN = step.pruned.length;
  const delta =
    step.tokenDelta >= 0 ? `+${formatTokens(step.tokenDelta)}` : `−${formatTokens(-step.tokenDelta)}`;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" height={height} paddingLeft={1} paddingRight={1}>
      <Box>
        <Text bold color="cyan">
          request #{p.requestIndex}
        </Text>
        <Text dimColor>
          {" "}· ctx {formatTokens(p.contextTokens)} tokens
        </Text>
        <Text color={step.tokenDelta >= 0 ? "green" : "red"} bold>
          {" "}({delta})
        </Text>
        <Text dimColor>
          {" "}· {p.contextMessages.length} messages in context
        </Text>
        {step.compaction ? (
          <Text color="yellow" bold>
            {" "}· ⚒ compacted from {(step.compaction as { tokensBefore: number }).tokensBefore.toLocaleString()}
          </Text>
        ) : null}
      </Box>
      <Box>
        <Text color="green" bold>
          +{addedN} added
        </Text>
        <Text color="red" bold>
          {"  "}−{prunedN} pruned
        </Text>
        <Text dimColor>
          {"  "}model {p.model ?? "?"}
        </Text>
      </Box>
      {step.compaction ? (
        <Box flexDirection="column">
          <Text color="yellow" dimColor wrap="truncate-end">
            ⚒ {String((step.compaction as { summary: string }).summary).slice(0, 160)}
          </Text>
        </Box>
      ) : null}
      {showSnapshots ? (
        <SnapshotList step={step} offset={snapshotOffset} height={Math.max(2, height - 7)} />
      ) : (
        <Text dimColor>snapshots hidden (d to show)</Text>
      )}
    </Box>
  );
}

function SnapshotList({ step, offset, height }: { step: RequestStep; offset: number; height: number }) {
  // render "after" context (what the request saw), with added highlighted
  const rows: Array<{ text: string; color: "green" | "white" | "gray" | "yellow"; dim?: boolean }> = [];
  for (const m of step.point.contextMessages) {
    const text = m.blocks
      .filter((b) => b.kind === "text" || b.kind === "thinking")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 180);
    const added = step.added.includes(m);
    if (m.role === "compactionSummary" || m.role === "branchSummary") {
      rows.push({ text: `⚒ summary: ${String(m.summary ?? "").slice(0, 180)}`, color: "yellow" });
    } else if (m.role === "custom") {
      rows.push({ text: `◈ custom ${m.customType ?? ""}`, color: "gray", dim: true });
    } else if (m.role === "toolResult") {
      rows.push({
        text: `↩ ${m.toolName ?? "tool"}${m.isError ? " (error)" : ""}: ${text.slice(0, 140)}`,
        color: "gray",
        dim: true,
      });
    } else if (m.role === "developer") {
      // codex embeds permissions / AGENTS.md / skills as developer-role messages
      rows.push({ text: `sys: ${text.slice(0, 140) || "(empty)"}`, color: "gray", dim: true });
    } else {
      rows.push({ text: `${m.role}: ${text || "(empty)"}`, color: added ? "green" : "white", dim: !added });
    }
  }
  if (rows.length === 0) rows.push({ text: "(empty context)", color: "gray", dim: true });
  const view = rows.slice(offset, offset + height);
  return (
    <Box flexDirection="column">
      {view.map((r, i) => (
        <Text key={offset + i} color={r.color} dimColor={r.dim} wrap="truncate-end">
          {r.text}
        </Text>
      ))}
    </Box>
  );
}
