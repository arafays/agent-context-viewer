/**
 * Shared Ink primitives: header, footer/key hints, generic scrollable list.
 */
import React, { useState } from "react";
import { Box, Text, useInput, useStdout, type Key } from "ink";

export function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  const { columns } = useTerminalSize();
  // single-line header: truncate the subtitle so long cwd/date labels never wrap
  let sub = subtitle ?? "";
  const avail = Math.max(0, columns - 4 - title.length);
  if (sub.length > avail) sub = sub.slice(0, Math.max(0, avail - 1)) + "…";
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text bold color="cyan">
          {"◆ "}
        </Text>
        <Text bold>{title}</Text>
        {sub ? <Text dimColor wrap="truncate-end">  {sub}</Text> : null}
      </Box>
      <Text dimColor>{"─".repeat(columns)}</Text>
    </Box>
  );
}

export function KeyHint({ keys }: { keys: Array<[string, string]> }) {
  return (
    <Box>
      {keys.map(([k, label], i) => (
        <Text key={k} dimColor>
          {i > 0 ? "  " : ""}
          {label} <Text bold color="yellow">
            {k}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

export function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  return { rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 };
}

/** Dim spacer row used to pad short content. */
export function Pad({ height = 1 }: { height?: number }) {
  return (
    <Box flexDirection="column">
      {Array.from({ length: height }, (_, i) => (
        <Text key={i}> </Text>
      ))}
    </Box>
  );
}

export interface ScrollListProps<T> {
  items: T[];
  renderItem: (item: T, index: number, selected: boolean) => React.ReactNode;
  selected: number;
  onSelect: (index: number) => void;
  /** extra rows reserved for chrome above the list (header, search bar…) */
  topOffset?: number;
  /** extra rows reserved below (footer/help) */
  bottomOffset?: number;
}

/**
 * Keyboard-scrollable list with j/k/arrows + Home/End + PgUp/PgDn.
 * Renders only the visible window (virtualized).
 */
export function ScrollList<T>({ items, renderItem, selected, onSelect, topOffset = 0, bottomOffset = 0 }: ScrollListProps<T>) {
  const { rows } = useTerminalSize();
  const viewport = Math.max(1, rows - topOffset - bottomOffset - 1);
  const count = items.length;
  const safe = Math.min(Math.max(0, selected), Math.max(0, count - 1));
  const start = Math.max(0, Math.min(safe - Math.floor(viewport / 2), Math.max(0, count - viewport)));
  const visible = items.slice(start, start + viewport);
  const content = visible.map((item, i) => (
    <React.Fragment key={i}>{renderItem(item, start + i, start + i === safe)}</React.Fragment>
  ));
  // fill remaining rows so the selection stays put and layout is stable
  const fill = viewport - visible.length;
  return (
    <Box flexDirection="column">
      {content}
      {fill > 0 ? (
        <Box flexDirection="column">
          {Array.from({ length: fill }, (_, i) => (
            <Text key={i}> </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/** Manages selection + scroll state; call from a useInput handler. */
export function useSelection(count: number, initial = 0) {
  const [selected, setSelected] = useState(initial);
  const select = (n: number) => setSelected(Math.min(Math.max(0, n), Math.max(0, count - 1)));
  const move = (delta: number) => select(selected + delta);
  return { selected, setSelected: select, move };
}

export function ListKeyBindings({
  move,
  onOpen,
  extra,
}: {
  move: (d: number) => void;
  onOpen: () => void;
  extra?: (input: string, key: Key) => boolean | void;
}) {
  useInput((input, key) => {
    if (key.downArrow || input === "j") move(1);
    else if (key.upArrow || input === "k") move(-1);
    else if (key.pageDown) move(10);
    else if (key.pageUp) move(-10);
    else if (key.home) move(-Number.MAX_SAFE_INTEGER);
    else if (key.end) move(Number.MAX_SAFE_INTEGER);
    else if (key.return) onOpen();
    else if (extra) extra(input, key);
  });
  return null;
}

export function Spinner({ label }: { label: string }) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [i, setI] = useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % frames.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color="cyan">
      {frames[i]} {label}
    </Text>
  );
}
