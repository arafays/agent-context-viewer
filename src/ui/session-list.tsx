import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useMemo, useState } from "react"
import { Header, KeyHint, useSelection } from "./components.tsx"
import type { AgentTool, SessionMeta } from "../adapters/types.ts"

export function SessionList({
  tool,
  project,
  sessions,
  onOpen,
  onBack,
}: {
  tool: AgentTool;
  project: string | null;
  sessions: SessionMeta[];
  onOpen: (meta: SessionMeta) => void;
  onBack: () => void;
}) {
  const { width: columns, height: rows } = useTerminalDimensions();
  const [search, setSearch] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query) return sessions;
    const q = query.toLowerCase();
    return sessions.filter(
      (s) =>
        (s.model ?? "").toLowerCase().includes(q) ||
        (s.name ?? "").toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.project.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const sel = useSelection(filtered.length);

  const toolName = (tool: string) => {
    const names: Record<string, string> = {
      pi: "Pi",
      codex: "Codex",
      claude: "Claude Code",
      opencode: "opencode",
    };
    return names[tool] ?? tool;
  };

  useKeyboard((key) => {
    if (search !== null) {
      if (key.name === "escape") { setSearch(null); }
      else if (key.name === "return") { setSearch(null); }
      else if (key.name === "backspace") { setQuery((q) => q.slice(0, -1)); }
      else if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
        setQuery((q) => q + key.sequence);
      }
      return;
    }
    if (key.name === "down" || key.name === "j") sel.move(1);
    else if (key.name === "up" || key.name === "k") sel.move(-1);
    else if (key.name === "pageDown") sel.move(10);
    else if (key.name === "pageUp") sel.move(-10);
    else if (key.name === "home") sel.move(-Number.MAX_SAFE_INTEGER);
    else if (key.name === "end") sel.move(Number.MAX_SAFE_INTEGER);
    else if (key.name === "return") {
      const m = filtered[sel.selected];
      if (m) onOpen(m);
    } else if (key.name === "/") { setSearch(""); setQuery(""); }
    else if (key.name === "q" || key.name === "escape") onBack();
  });

  const subtitle = project
    ? `${project} · ${filtered.length} session${filtered.length === 1 ? "" : "s"}${query ? ` (filtered)` : ""}`
    : `all ${toolName(tool)} sessions · ${filtered.length} session${filtered.length === 1 ? "" : "s"}${query ? ` (filtered)` : ""}`;

  const half = Math.max(1, Math.floor(rows - 6) / 2);
  const start = Math.max(0, Math.min(sel.selected - half, Math.max(0, filtered.length - (rows - 6))));
  const visible = filtered.slice(start, start + rows - 6);

  return (
    <box flexDirection="column" width="100%" height={rows}>
      <Header title={project ?? `All ${toolName(tool)} sessions`} subtitle={subtitle} />
      {visible.length === 0 ? (
        <text fg="gray" attributes={TextAttributes.DIM}>  (no sessions found)</text>
      ) : (
        <box flexDirection="column">
          {visible.map((s, i) => {
            const absIdx = start + i;
            const isSel = absIdx === sel.selected;
            const date = s.updatedAt.slice(0, 10).replace(/^(\d+)-(\d+)-(\d+).*$/, "$2/$3");
            const msgs = s.messageCount;
            const inK = s.tokens.input >= 1000 ? `${(s.tokens.input / 1000).toFixed(1)}k` : String(s.tokens.input);
            const cacheK = s.tokens.cacheRead >= 1000 ? `${(s.tokens.cacheRead / 1000).toFixed(1)}k` : String(s.tokens.cacheRead);
            const comp = s.compactionCount > 0 ? ` ⚒${s.compactionCount}` : "";
            return (
              <text
                key={s.id}
                attributes={isSel ? TextAttributes.BOLD : TextAttributes.DIM}
                fg={isSel ? "cyan" : undefined}
              >
                {isSel ? "▶ " : "  "}
                {(s.model ?? "—").padEnd(24).slice(0, 24)}
                {date.padStart(7)}
                {String(msgs).padStart(5)}
                {inK.padStart(8)}
                {cacheK.padStart(9)}
                {comp}
                {"  "}{s.cwd || s.project}
              </text>
            );
          })}
        </box>
      )}
      <KeyHint keys={[["scroll", "j/k"], ["search", "/"], ["open", "Enter"], ["back", "q"]]} />
    </box>
  );
}
