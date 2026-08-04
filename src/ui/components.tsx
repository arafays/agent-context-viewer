import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useState } from "react"

/** Cyan diamond + bold title + dim subtitle, single-line (truncates). */
export function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  const { width: columns } = useTerminalDimensions();
  let sub = subtitle ?? "";
  const avail = Math.max(0, columns - 4 - title.length);
  if (sub.length > avail) sub = sub.slice(0, Math.max(0, avail - 1)) + "…";
  return (
    <box flexDirection="column">
      <box>
        <text fg="cyan" attributes={TextAttributes.BOLD}>◆ </text>
        <text attributes={TextAttributes.BOLD}>{title}</text>
        {sub ? <text attributes={TextAttributes.DIM}>  {sub}</text> : null}
      </box>
      <text attributes={TextAttributes.DIM}>{"─".repeat(Math.max(columns, 10))}</text>
    </box>
  );
}

/** Keybinding hint bar — truncated to terminal width. */
export function KeyHint({ keys }: { keys: Array<[string, string]> }) {
  const { width: columns } = useTerminalDimensions();
  const items = keys.map(([label, k]) => `${label} ${k}`).join("  ");
  const truncated = items.length > columns - 2 ? items.slice(0, columns - 5) + "…" : items;
  return <text attributes={TextAttributes.DIM}>{truncated}</text>;
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
 * Selection hook — clamps to [0, count-1].
 */
export function useSelection(count: number, initial = 0) {
  const [selected, setSelected] = useState(initial);
  const select = (n: number) => setSelected(Math.min(Math.max(0, n), Math.max(0, count - 1)));
  const move = (delta: number) => select(selected + delta);
  return { selected, setSelected: select, move };
}
