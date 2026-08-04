import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useMemo, useState } from "react"
import { Header, KeyHint, useSelection } from "./components.tsx"
import { buildRequestSteps, sessionCurve, type RequestStep } from "../engine/context-diff.ts"
import type { AgentSession, NormalizedMessage } from "../adapters/types.ts"

export function ContextView({
  session,
  onBack,
}: {
  session: AgentSession;
  onBack: () => void;
}) {
  const { width: columns, height: rows } = useTerminalDimensions();
  const [showSnapshots, setShowSnapshots] = useState(true);
  const [snapshotOffset, setSnapshotOffset] = useState(0);

  const { steps, curve, info } = useMemo(() => {
    const compactions = session.turns.flatMap((t) =>
      t.events
        .filter((e) => e.kind === "compaction")
        .map((e) => ({
          entryIndex: (e as { entryIndex?: number }).entryIndex ?? t.entryEnd,
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

  const reqSel = useSelection(steps.length);
  const step = steps[reqSel.selected];
  const maxCtx = curve.reduce((m, b) => Math.max(m, b.contextTokens), 0) || 1;

  useKeyboard((key) => {
    if (key.name === "down" || key.name === "j") reqSel.move(1);
    else if (key.name === "up" || key.name === "k") reqSel.move(-1);
    else if (key.name === "pageDown") reqSel.move(10);
    else if (key.name === "pageUp") reqSel.move(-10);
    else if (key.name === "home") reqSel.move(-Number.MAX_SAFE_INTEGER);
    else if (key.name === "end") reqSel.move(Number.MAX_SAFE_INTEGER);
    else if (key.name === "s") { /* system prompt navigation handled by App */ }
    else if (key.name === "d") setShowSnapshots((s) => !s);
    else if ((key.name === "q" || key.name === "escape") && !key.shift) onBack();
  });

  // Build curve bar text — truncate to fit terminal width
  const curveLines = useMemo(() => {
    const maxCtx = curve.reduce((m, b) => Math.max(m, b.contextTokens), 0) || 1;
    const maxLineWidth = columns - 4;
    const barWidth = Math.min(Math.max(columns - 40, 8), 26);
    return curve.map((bar) => {
      const pct = bar.contextTokens / maxCtx;
      const filled = Math.round(pct * barWidth);
      const empty = barWidth - filled;
      const barStr = "█".repeat(filled) + "░".repeat(Math.max(0, empty));
      const compacted = bar.compacted ? " ⚒" : "";
      const raw = `#${String(bar.requestIndex).padStart(3)} ${barStr}  ${fmt(bar.contextTokens)}  in ${fmt(bar.input)}  cache ${fmt(bar.cacheRead)}${compacted}`;
      const text = raw.length > maxLineWidth ? raw.slice(0, maxLineWidth - 1) + "…" : raw;
      return {
        text,
        compacted: bar.compacted,
        requestIndex: bar.requestIndex,
      };
    });
  }, [curve, columns]);

  // Selected step detail
  const detailLines = useMemo(() => {
    if (!step) return ["(no request selected)"];
    const lines: string[] = [];
    const isFirst = step.isFirst;
    lines.push(`request #${step.index} · ctx ${fmt(step.point.contextTokens)} tokens (${isFirst ? "+" : ""}${fmt(step.tokenDelta)}) · ${step.point.contextMessages.length} messages in context`);
    lines.push(`+${step.added.length} added −${step.pruned.length} pruned  model ${step.point.model ?? "—"}`);
    if (step.compaction) {
      lines.push(`╒ compacted from ${fmt(step.compaction.tokensBefore)} tokens`);
      if (step.compaction.summary) lines.push(`  summary: ${step.compaction.summary.slice(0, 160)}`);
    }
    if (step.compactedAhead) lines.push("  cacheRead=0 (fresh after compaction)");
    return lines;
  }, [step]);

  // Snapshot messages
  const snapshotLines = useMemo(() => {
    if (!step) return [];
    const out: Array<{ text: string; color: string; dim: boolean; added: boolean }> = [];
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
        out.push({ text: `╒ summary: ${String(m.summary ?? "").slice(0, 180)}`, color: "yellow", dim: false, added });
      } else if (m.role === "custom") {
        out.push({ text: `◈ custom ${m.customType ?? ""}`, color: "gray", dim: true, added });
      } else if (m.role === "toolResult") {
        out.push({ text: `↩ ${m.toolName ?? "tool"}${m.isError ? " (error)" : ""}: ${text.slice(0, 140)}`, color: "gray", dim: true, added });
      } else if (m.role === "developer") {
        out.push({ text: `sys: ${text.slice(0, 140) || "(empty)"}`, color: "gray", dim: true, added });
      } else {
        out.push({ text: `${m.role}: ${text || "(empty)"}`, color: added ? "green" : "white", dim: !added, added });
      }
    }
    return out;
  }, [step]);

  const viewportRows = Math.max(1, rows - 10);
  const halfCurve = Math.max(1, Math.floor(viewportRows / 2));
  const curveStart = Math.max(0, Math.min(reqSel.selected - halfCurve, Math.max(0, curveLines.length - viewportRows)));
  const visibleCurve = curveLines.slice(curveStart, curveStart + viewportRows);

  const maxLineWidth = columns - 4;

  return (
    <box flexDirection="column" width="100%" height={rows}>
      <Header title={`Context — ${session.meta.id.slice(0, 8)}`} subtitle={`${session.meta.cwd || session.meta.project} · ${steps.length} LLM requests`} />
      <box flexDirection="column" flexGrow={1} width={columns}>
        {/* Curve */}
        <box flexDirection="column" width={columns}>
          <text attributes={TextAttributes.BOLD} fg="gray">TOKENS PER REQUEST (input+cacheRead) — max {fmt(maxCtx)}</text>
          {visibleCurve.map((c) => (
            <text key={c.requestIndex} fg={c.compacted ? "yellow" : undefined} attributes={c.requestIndex === reqSel.selected ? TextAttributes.BOLD : TextAttributes.DIM}>
              {c.requestIndex === reqSel.selected ? ">" : " "} {c.text}
            </text>
          ))}
        </box>
        {/* Detail pane */}
        <box flexDirection="column" borderStyle="rounded" borderColor="gray" padding={1} width={columns}>
          {detailLines.map((l, i) => {
            const truncated = l.length > maxLineWidth ? l.slice(0, maxLineWidth - 1) + "…" : l;
            return (
              <text key={i} fg={l.startsWith("╒") ? "yellow" : l.startsWith("  cacheRead") ? "yellow" : undefined} attributes={l.startsWith("+") ? TextAttributes.BOLD : TextAttributes.DIM}>
                {truncated}
              </text>
            );
          })}
        </box>
        {/* Snapshot */}
        {showSnapshots ? (
          <box flexDirection="column" flexGrow={1} width={columns}>
            {snapshotLines.slice(snapshotOffset, snapshotOffset + Math.max(2, viewportRows)).map((m, i) => {
              const truncated = m.text.length > maxLineWidth ? m.text.slice(0, maxLineWidth - 1) + "…" : m.text;
              return (
                <text key={i} fg={m.color} attributes={m.dim ? TextAttributes.DIM : TextAttributes.BOLD}>
                  {truncated}
                </text>
              );
            })}
          </box>
        ) : (
          <text attributes={TextAttributes.DIM}>snapshots hidden (d to show)</text>
        )}
      </box>
      <KeyHint keys={[
        ["request", "j/k"],
        ["snapshots", "d"],
        ["scroll req", "PgUp/PgDn"],
        ["system pr", "s"],
        ["back", "q"],
        ["quit app", "Q"],
      ]} />
    </box>
  );
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}
