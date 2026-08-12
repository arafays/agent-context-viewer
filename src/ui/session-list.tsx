import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo } from "react"
import { Header, KeyHint, useSelection, useFuzzyFilter } from "./components.tsx"
import { overlayOpen } from "./overlay.ts"
import type { Theme } from "./theme.ts"
import { tildeHome, truncate } from "./util.ts"
import type { AgentTool, SessionMeta } from "../adapters/types.ts"
import type { SearchIndex } from "../engine/search-index.ts"

export function SessionList({
  tool,
  project,
  sessions,
  index,
  theme,
  status,
  onOpen,
  onBack,
}: {
  tool: AgentTool;
  project: string | null;
  sessions: SessionMeta[];
  index: SearchIndex | null;
  theme: Theme;
  status?: "pending" | "loading" | "done" | "error";
  onOpen: (meta: SessionMeta) => void;
  onBack: () => void;
}) {
  const { width: columns, height: rows } = useTerminalDimensions();
  const filter = useFuzzyFilter(index, tool);

  // fff-backed fuzzy filter: when active, keep only sessions that matched.
  const filtered = useMemo(() => {
    if (!filter.active || !index?.ready) return sessions;
    const hits = index.search(filter.query, tool);
    const ids = new Set(hits.map((h) => h.meta.id));
    return sessions.filter((s) => ids.has(s.id));
  }, [sessions, index, filter.active, filter.query, tool]);

  const sel = useSelection(filtered.length);

  // Keep the selection valid when filtering shrinks the session list.
  useEffect(() => {
    sel.clamp();
  }, [filtered.length]);

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
    // while an overlay (help / global search) is open, don't respond to keys
    if (overlayOpen.current) return;
    // while the inline filter is open, keys drive the query (except Enter opens)
    if (filter.open) {
      if (key.name === "return" || key.name === "enter") {
        const m = filtered[sel.selected];
        if (m) onOpen(m);
        return;
      }
      if (filter.handleKey(key)) return;
    }
    if (key.name === "down" || key.name === "j") sel.move(1);
    else if (key.name === "up" || key.name === "k") sel.move(-1);
    else if (key.name === "pagedown") sel.move(10);
    else if (key.name === "pageup") sel.move(-10);
    else if (key.name === "home") sel.move(-Number.MAX_SAFE_INTEGER);
    else if (key.name === "end") sel.move(Number.MAX_SAFE_INTEGER);
    else if (key.name === "return") {
      const m = filtered[sel.selected];
      if (m) onOpen(m);
    } else if (key.name === "/") { filter.toggle(); }
    else if ((key.name === "q" || key.name === "escape") && !key.ctrl && !key.shift) {
      if (filter.open) filter.toggle();
      else onBack();
    }
  });

  const subtitle = project
    ? `${project} · ${filtered.length} session${filtered.length === 1 ? "" : "s"}`
    : `all ${toolName(tool)} sessions · ${filtered.length} session${filtered.length === 1 ? "" : "s"}`;

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
      <Header title={project ?? `All ${toolName(tool)} sessions`} subtitle={subtitle} theme={theme} />
      {filter.open ? (
        <box flexDirection="row" paddingLeft={1} paddingRight={1}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>/ </text>
          <text>{filter.query || " "}</text>
          <text attributes={TextAttributes.DIM} fg={theme.border}>▏</text>
        </box>
      ) : null}
      {visible.length === 0 ? null : (
        <text fg={theme.toolResult} attributes={TextAttributes.DIM}>
          {"  " + "MODEL".padEnd(modelWidth) + " " + "DATE".padStart(6) + " " + "MSGS".padStart(4) + " " + "IN".padStart(6) + " " + "CACHE".padStart(7) + "  PATH"}
        </text>
      )}
      {visible.length === 0 ? (
        status === "pending" || status === "loading" ? (
          <text fg={theme.toolResult} attributes={TextAttributes.DIM}>  ⠋ …</text>
        ) : status === "error" ? (
          <text fg={theme.warning} attributes={TextAttributes.DIM}>  (discovery failed)</text>
        ) : (
          <text fg={theme.toolResult} attributes={TextAttributes.DIM}>  (no sessions found)</text>
        )
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
                fg={isSel ? theme.accent : undefined}
              >
                {truncated}
              </text>
            );
          })}
        </box>
      )}
      <KeyHint keys={[["scroll", "j/k"], ["search", "/"], ["open", "Enter"], ["back", "q"], ["quit app", "Q"]]} theme={theme} />
    </box>
  );
}
