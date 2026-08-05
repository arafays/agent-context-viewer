import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useMemo, useState } from "react"
import { Header, KeyHint } from "./components.tsx"
import type { Theme } from "./theme.ts"
import { wordWrap } from "./util.ts"

/** Payload for the focused block reader. */
export interface ReaderContent {
  title: string
  subtitle?: string
  body: string
  /** optional language label (e.g. "json") shown next to the title */
  lang?: string
  /** base foreground color for the body */
  color?: string
}

/**
 * Full-screen focused reader for a single block's content. Word-wrapped and
 * scrollable with a visible cursor (vim-style j/k, g/G, PgUp/PgDn, Home/End).
 * Rendered as an opaque overlay by the parent.
 */
export function BlockReader({ content, theme, onBack }: { content: ReaderContent; theme: Theme; onBack: () => void }) {
  const { width: columns, height: rows } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);

  // 2 for the left gutter (cursor indicator), 1 to avoid touching the right edge.
  const wrapWidth = Math.max(10, columns - 3);

  const lines = useMemo(
    () => wordWrap(content.body, wrapWidth).map((text) => ({ text })),
    [content.body, wrapWidth],
  );

  useKeyboard((key) => {
    const max = Math.max(0, lines.length - 1);
    if (key.name === "down" || key.name === "j") setCursor((c) => Math.min(c + 1, max));
    else if (key.name === "up" || key.name === "k") setCursor((c) => Math.max(0, c - 1));
    else if (key.name === "pagedown" || (key.name === "d" && key.ctrl)) setCursor((c) => Math.min(c + Math.max(1, rows - 5), max));
    else if (key.name === "pageup" || (key.name === "u" && key.ctrl)) setCursor((c) => Math.max(0, c - Math.max(1, rows - 5)));
    else if (key.name === "home" || (key.name === "g" && !key.shift)) setCursor(0);
    else if (key.name === "end" || (key.name === "g" && key.shift)) setCursor(max);
    else if ((key.name === "q" || key.name === "escape") && !key.shift) onBack();
  });

  const viewportRows = Math.max(1, rows - 5);
  // Pager-style: keep the cursor visible. While the cursor fits in the first
  // viewport the text stays put and the cursor walks down; once it would scroll
  // off the bottom, the viewport advances to keep it on the last row.
  let start: number;
  if (lines.length <= viewportRows) {
    start = 0;
  } else if (cursor < viewportRows) {
    start = 0;
  } else {
    start = cursor - viewportRows + 1;
  }
  const visible = lines.slice(start, start + viewportRows);
  const cursorRow = cursor - start; // row within the visible window, -1 if off

  const header = content.lang ? `${content.title} · ${content.lang}` : content.title;
  const pct = lines.length > 0 ? Math.round(((cursor + 1) / lines.length) * 100) : 0;
  const subtitle = content.subtitle ?? `${cursor + 1}/${lines.length} lines · ${pct}%`;
  const maxHintWidth = Math.max(0, columns - 4);
  const hintTitle = header.length > maxHintWidth ? header.slice(0, Math.max(1, maxHintWidth - 1)) + "…" : header;

  return (
    <box flexDirection="column" width="100%" height={rows} backgroundColor={theme.defaultBg ?? (theme.dark ? "#0b0b0b" : "#ffffff")}>
      <Header title={hintTitle} subtitle={subtitle} theme={theme} />
      <box flexDirection="column" flexGrow={1} width={columns} paddingLeft={1} paddingRight={1}>
        {visible.map((l, i) => {
          const isCursor = i === cursorRow;
          const prefix = isCursor ? "▶ " : "  ";
          return (
            <text
              key={start + i}
              fg={content.color ?? theme.fg}
              attributes={(isCursor ? TextAttributes.BOLD : 0) | TextAttributes.DIM}
            >
              {prefix + (l.text || "")}
            </text>
          );
        })}
      </box>
      <KeyHint keys={[
        ["scroll", "j/k ↑↓"],
        ["page", "PgUp/PgDn"],
        ["top/bottom", "g/G / Home/End"],
        ["back", "q/Esc"],
        ["quit", "Q"],
      ]} theme={theme} />
    </box>
  );
}