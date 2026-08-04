import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useMemo, useState } from "react"
import { Header, KeyHint, useSelection } from "./components.tsx"
import { tildeHome, truncate } from "./util.ts"
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
    else if ((key.name === "q" || key.name === "escape") && !key.shift) onBack();
  });

  const subtitle = project
    ? `${project} · ${filtered.length} session${filtered.length === 1 ? "" : "s"}${query ? ` (filtered)` : ""}`
    : `all ${toolName(tool)} sessions · ${filtered.length} session${filtered.length === 1 ? "" : "s"}${query ? ` (filtered)` : ""}`;

  const viewportRows = Math.max(1, rows - 7);
  const half = Math.max(1, Math.floor(viewportRows / 2));
  const start = Math.max(0, Math.min(sel.selected - half, Math.max(0, filtered.length - viewportRows)));
  const visible = filtered.slice(start, start + viewportRows);

  // MODEL column width: as wide as the longest model in the list, but never
  // so wide that the PATH column loses its minimum. Truncation is a last
  // resort on very narrow terminals — PATH shrinks (left-truncated) first.
  const statsLen = 6 + 1 + 4 + 1 + 6 + 1 + 7; // DATE MSGS IN CACHE + separators
  const maxCompLen = filtered.reduce((m, s) => Math.max(m, s.compactionCount > 0 ? ` ⚒${s.compactionCount}`.length : 0), 0);
  const minPathLen = 12;
  const longestModel = filtered.reduce((m, s) => Math.max(m, (s.model ?? "—").length), 0);
  const modelWidth = Math.max(6, Math.min(longestModel, columns - (2 + 1 + statsLen + maxCompLen + 2 + minPathLen)));

  return (
    <box flexDirection="column" width="100%" height={rows}>
      <Header title={project ?? `All ${toolName(tool)} sessions`} subtitle={subtitle} />
      {visible.length === 0 ? null : (
        <text fg="gray" attributes={TextAttributes.DIM}>
          {"  " + "MODEL".padEnd(modelWidth) + " " + "DATE".padStart(6) + " " + "MSGS".padStart(4) + " " + "IN".padStart(6) + " " + "CACHE".padStart(7) + "  PATH"}
        </text>
      )}
      {visible.length === 0 ? (
        <text fg="gray" attributes={TextAttributes.DIM}>  (no sessions found)</text>
      ) : (
        <box flexDirection="column" width={columns}>
          {visible.map((s, i) => {
            const absIdx = start + i;
            const isSel = absIdx === sel.selected;
            const date = s.updatedAt.slice(0, 10).replace(/^(\d+)-(\d+)-(\d+).*$/, "$2/$3");
            const msgs = s.messageCount;
            const inK = s.tokens.input >= 1000 ? `${(s.tokens.input / 1000).toFixed(1)}k` : String(s.tokens.input);
            const cacheK = s.tokens.cacheRead >= 1000 ? `${(s.tokens.cacheRead / 1000).toFixed(1)}k` : String(s.tokens.cacheRead);
            const comp = s.compactionCount > 0 ? ` ⚒${s.compactionCount}` : "";
            // Build row content, aggressively truncate to fit terminal width
            const prefix = isSel ? "▶ " : "  ";
            const modelRaw = truncate(s.model ?? "—", modelWidth).padEnd(modelWidth);
            const statPart = `${date.padStart(6)} ${String(msgs).padStart(4)} ${inK.padStart(6)} ${cacheK.padStart(7)}${comp}`;
            const fixedLen = prefix.length + modelRaw.length + 1 + statPart.length + 2;
            const availForCwd = columns - fixedLen;
            let cwd = tildeHome(s.cwd || s.project || "");
            if (cwd.length > Math.max(0, availForCwd)) {
              cwd = "…" + cwd.slice(-Math.max(2, availForCwd - 2));
            }
            const full = `${prefix}${modelRaw} ${statPart}  ${cwd}`;
            // Final safety truncation
            const maxCol = Math.max(8, columns - 1);
            const truncated = full.length > maxCol ? full.slice(0, maxCol - 1) + "…" : full;
            return (
              <text
                key={s.id}
                attributes={isSel ? TextAttributes.BOLD : TextAttributes.DIM}
                fg={isSel ? "cyan" : undefined}
              >
                {truncated}
              </text>
            );
          })}
        </box>
      )}
      <KeyHint keys={[["scroll", "j/k"], ["search", "/"], ["open", "Enter"], ["back", "q"], ["quit app", "Q"]]} />
    </box>
  );
}
