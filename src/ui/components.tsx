import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useState } from "react"
import type { Theme } from "./theme.ts"
import type { AgentTool } from "../adapters/types.ts"
import type { SearchIndex } from "../engine/search-index.ts"

/** Accent diamond + bold title + dim subtitle, single-line (truncates). */
export function Header({ title, subtitle, theme }: { title: string; subtitle?: string; theme: Theme }) {
  const { width: columns } = useTerminalDimensions();
  const avail = Math.max(0, columns - 4 - title.length - 2);
  let sub = subtitle ?? "";
  if (sub.length > avail) sub = sub.slice(0, Math.max(0, avail - 1)) + "…";
  return (
    <box flexDirection="column" width={columns}>
      <box flexDirection="row" width={columns}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>◆ </text>
        <text attributes={TextAttributes.BOLD}>{title}</text>
        {sub ? <text attributes={TextAttributes.DIM}>  {sub}</text> : null}
      </box>
      <text attributes={TextAttributes.DIM}>{"─".repeat(Math.max(columns, 10))}</text>
    </box>
  );
}

/** Keybinding hint bar — truncated to terminal width. */
export function KeyHint({ keys, theme }: { keys: Array<[string, string]>; theme: Theme }) {
  const { width: columns } = useTerminalDimensions();
  const items = keys.map(([label, k]) => `${label} ${k}`).join("  ");
  const maxLen = columns - 2;
  const truncated = items.length > maxLen ? items.slice(0, maxLen - 1) + "…" : items;
  return <box width={columns}><text attributes={TextAttributes.DIM}>{truncated}</text></box>;
}

/** Braille spinner. */
export function Spinner({ label }: { label: string }) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % frames.length), 100);
    return () => clearInterval(id);
  }, []);
  return <text>{frames[idx]} {label}</text>;
}

/** Reactive terminal size. */
export { useTerminalDimensions as useTerminalSize };

/**
 * Inline fuzzy-filter state for lists, backed by the fff SearchIndex.
 * `/` opens the filter; typing narrows; Esc/empty restores the full list.
 */
export function useFuzzyFilter(
  index: SearchIndex | null,
  tool?: AgentTool,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const active = open && query.trim().length > 0;

  const toggle = () => {
    if (open) {
      setOpen(false);
      setQuery("");
    } else {
      setOpen(true);
    }
  };

  const handleKey = (key: { name: string; shift?: boolean; sequence?: string }): boolean => {
    if (!open) return false;
    if (key.name === "escape") {
      setOpen(false);
      setQuery("");
      return true;
    }
    if (key.name === "backspace") {
      setQuery((q) => q.slice(0, -1));
      return true;
    }
    if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
      setQuery((q) => q + key.sequence);
      return true;
    }
    return false;
  };

  return { open, query, active, toggle, handleKey, setQuery };
}

/**
 * Selection hook — clamps to [0, count-1].
 */
export function useSelection(count: number, initial = 0) {
  const [selected, setSelected] = useState(initial);
  const select = (n: number) => setSelected(Math.min(Math.max(0, n), Math.max(0, count - 1)));
  const move = (delta: number) => select(selected + delta);
  const clamp = () => setSelected((c: number) => Math.min(Math.max(0, c), Math.max(0, count - 1)));
  return { selected, setSelected: select, move, clamp };
}
