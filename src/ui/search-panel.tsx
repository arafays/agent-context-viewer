import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useState } from "react"
import { Header, KeyHint, useSelection } from "./components.tsx"
import type { Theme } from "./theme.ts"
import { tildeHome } from "./util.ts"
import type { AgentTool, SessionMeta } from "../adapters/types.ts"
import type { SearchHit, SearchIndex } from "../engine/search-index.ts"

/**
 * Full-screen fuzzy search over session content, backed by the fff index.
 * Live-updates as you type; Enter opens the session jumped to the matched turn.
 */
export function SearchPanel({
  index,
  tool,
  sessionsByTool,
  theme,
  onPick,
  onClose,
}: {
  index: SearchIndex | null;
  tool: AgentTool | null;
  sessionsByTool: Record<AgentTool, SessionMeta[]>;
  theme: Theme;
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const { width: columns, height: rows } = useTerminalDimensions();
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);

  // fff index may still be building; poll until ready.
  useEffect(() => {
    if (index?.ready) { setReady(true); return; }
    const id = setInterval(() => {
      if (index?.ready) { setReady(true); clearInterval(id); }
    }, 200);
    return () => clearInterval(id);
  }, [index]);

  const hits = useMemo(() => {
    if (!ready || !index || !query.trim()) return [];
    return index.search(query, tool ?? undefined);
  }, [ready, index, query, tool]);

  const sel = useSelection(hits.length);

  useKeyboard((key) => {
    if (key.name === "escape" || (key.name === "q" && !key.shift)) { onClose(); return; }
    if (key.name === "backspace") { setQuery((q) => q.slice(0, -1)); return; }
    if (key.name === "down" || key.name === "j") { sel.move(1); return; }
    if (key.name === "up" || key.name === "k") { sel.move(-1); return; }
    if (key.name === "pagedown") { sel.move(10); return; }
    if (key.name === "pageup") { sel.move(-10); return; }
    if (key.name === "home") { sel.setSelected(0); return; }
    if (key.name === "end") { sel.setSelected(hits.length - 1); return; }
    if (key.name === "return" || key.name === "enter") {
      const h = hits[sel.selected];
      if (h) onPick(h);
      return;
    }
    if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
      setQuery((q) => q + key.sequence);
      return;
    }
  });

  const viewportRows = Math.max(1, rows - 7);
  const half = Math.max(1, Math.floor(viewportRows / 2));
  const start = Math.max(0, Math.min(sel.selected - half, Math.max(0, hits.length - viewportRows)));
  const visible = hits.slice(start, start + viewportRows);

  const status = !index
    ? "index building…"
    : !ready
      ? "waiting for index…"
      : query.trim()
        ? `${hits.length} session${hits.length === 1 ? "" : "s"}`
        : "type to fuzzy-search session content";

  return (
    <box position="absolute" width="100%" height={rows} top={0} left={0} backgroundColor={theme.defaultBg ?? (theme.dark ? "#0b0b0b" : "#ffffff")} flexDirection="column">
      <Header title="Fuzzy search" subtitle={status} theme={theme} />
      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>/ </text>
        <text>{query || " "}</text>
        <text attributes={TextAttributes.DIM} fg={theme.border}>▏</text>
      </box>
      <box flexDirection="column" flexGrow={1} width={columns} paddingLeft={1} paddingRight={1}>
        {visible.length === 0 ? (
          <text attributes={TextAttributes.DIM} fg={theme.toolResult}>  (no matches)</text>
        ) : (
          visible.map((h, i) => {
            const absIdx = start + i;
            const isSel = absIdx === sel.selected;
            const prefix = isSel ? "▶ " : "  ";
            const label = `${h.meta.project || "?"} · ${h.meta.tool}${h.meta.name ? ` · ${h.meta.name}` : ""}${h.turn > 0 ? ` · turn ${h.turn}` : ""}`;
            const line = h.line.replace(/\s+/g, " ").trim();
            const row = `${prefix}${label} — ${line}`;
            const maxCol = Math.max(8, columns - 1);
            const truncated = row.length > maxCol ? row.slice(0, maxCol - 1) + "…" : row;
            return (
              <text
                key={`${h.meta.tool}:${h.meta.id}:${h.lineNo}`}
                attributes={isSel ? TextAttributes.BOLD : TextAttributes.DIM}
                fg={isSel ? theme.accent : undefined}
              >
                {truncated}
              </text>
            );
          })
        )}
      </box>
      <KeyHint keys={[["select", "j/k"], ["open (jump)", "Enter"], ["close", "q/Esc"]]} theme={theme} />
    </box>
  );
}
