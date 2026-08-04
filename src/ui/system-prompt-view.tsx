import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useMemo, useState } from "react"
import { Header, KeyHint } from "./components.tsx"
import { wordWrap } from "./util.ts"
import type { AgentSession } from "../adapters/types.ts"

export function SystemPromptView({
  session,
  onBack,
}: {
  session: AgentSession;
  onBack: () => void;
}) {
  const { width: columns, height: rows } = useTerminalDimensions();
  const [scroll, setScroll] = useState(0);
  const info = session.contextInfo;

  const lines = useMemo(() => {
    const l: string[] = [];
    l.push(`SYSTEM PROMPT (${info.reconstructed ? "reconstructed — AGENTS.md/CLAUDE.md as of today" : "exact — stored inline in the session"})`);
    l.push(`tools: ${info.tools.join(", ")}`);
    l.push(`context files: ${info.contextFiles.map((f) => f.path).join(" | ") || "(none)"}`);
    l.push(`skills: ${info.skills.map((s) => s.name).join(", ") || "(none)"}`);
    if (info.notes.length) l.push(`notes: ${info.notes.join("; ")}`);
    l.push("");
    l.push(...info.systemPrompt.split("\n"));
    return l;
  }, [info]);

  useKeyboard((key) => {
    if (key.name === "down" || key.name === "j") setScroll((s) => Math.min(s + 1, Math.max(0, lines.length - 1)));
    else if (key.name === "up" || key.name === "k") setScroll((s) => Math.max(0, s - 1));
    else if (key.name === "pagedown") setScroll((s) => Math.min(s + 10, Math.max(0, lines.length - 1)));
    else if (key.name === "pageup") setScroll((s) => Math.max(0, s - 10));
    else if (key.name === "home") setScroll(0);
    else if (key.name === "end") setScroll(Math.max(0, lines.length - 1));
    else if ((key.name === "q" || key.name === "escape") && !key.shift) onBack();
  });

  const wrapWidth = Math.max(8, columns - 2);
  const wrapped = useMemo(() => lines.flatMap((l) => wordWrap(l, wrapWidth)), [lines, wrapWidth]);
  const viewportRows = Math.max(1, rows - 5);
  const half = Math.max(1, Math.floor(viewportRows / 2));
  const start = Math.max(0, Math.min(scroll - half, Math.max(0, wrapped.length - viewportRows)));
  const visible = wrapped.slice(start, start + viewportRows);

  return (
    <box flexDirection="column" width="100%" height={rows}>
      <Header title="System prompt" subtitle={`${session.meta.id.slice(0, 8)}  ${info.reconstructed ? "reconstructed" : "exact"} · ${lines.length} lines`} />
      <box flexDirection="column" flexGrow={1} width={columns} paddingLeft={1}>
        {visible.map((l, i) => (
          <text key={start + i} attributes={TextAttributes.DIM}>{l || " "}</text>
        ))}
      </box>
      <KeyHint keys={[["scroll", "j/k"], ["back", "q"], ["quit app", "Q"]]} />
    </box>
  );
}
