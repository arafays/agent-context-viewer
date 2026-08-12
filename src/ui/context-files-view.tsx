import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useState } from "react"
import { Header, KeyHint, useSelection } from "./components.tsx"
import { overlayOpen } from "./overlay.ts"
import type { Theme } from "./theme.ts"
import { tildeHome, wordWrap } from "./util.ts"
import type { AgentSession } from "../adapters/types.ts"

export function ContextFilesView({
  session,
  theme,
  onBack,
}: {
  session: AgentSession;
  theme: Theme;
  onBack: () => void;
}) {
  const { width: columns, height: rows } = useTerminalDimensions();
  const info = session.contextInfo;
  const files = info.contextFiles;
  const fileSel = useSelection(files.length);
  const selectedFile = files[fileSel.selected];

  useKeyboard((key) => {
    if (overlayOpen.current) return;
    if (key.name === "down" || key.name === "j") fileSel.move(1);
    else if (key.name === "up" || key.name === "k") fileSel.move(-1);
    else if (key.name === "pagedown") setContentScroll((s) => s + 10);
    else if (key.name === "pageup") setContentScroll((s) => Math.max(0, s - 10));
    else if (key.name === "home") setContentScroll(0);
    else if (key.name === "end") setContentScroll(wrappedContent.length);
    else if ((key.name === "q" || key.name === "escape") && !key.ctrl && !key.shift) onBack();
  });

  const borderPad = 4;
  const filePaneWidth = Math.floor(columns / 3);
  const contentPaneWidth = columns - filePaneWidth;
  const fileContentWidth = filePaneWidth - borderPad;
  const contentContentWidth = contentPaneWidth - borderPad;

  const fileLines = files.map((f, i) => {
    const prefix = i === fileSel.selected ? "▶ " : "  ";
    const raw = `${f.global ? "[global]" : "       "} ${truncPath(tildeHome(f.path), fileContentWidth - 12)}`;
    const full = prefix + raw;
    const truncated = full.length > fileContentWidth ? full.slice(0, fileContentWidth - 1) + "…" : full;
    return { path: f.path, text: truncated, sel: i === fileSel.selected };
  });

  // The FILES pane renders a fixed number of rows (border 2 + padding 2 + title 1
  // rows are taken by the pane chrome). Window the file list around the selection
  // so the pane never overflows — OpenTUI corrupts rows once content exceeds the
  // bordered box.
  const fileViewportRows = Math.max(1, rows - 7 - 1);
  const fileHalf = Math.max(1, Math.floor(fileViewportRows / 2));
  const fStart = Math.max(
    0,
    Math.min(fileSel.selected - fileHalf, Math.max(0, fileLines.length - fileViewportRows)),
  );
  const visibleFiles = fileLines.slice(fStart, fStart + fileViewportRows);

  const content = selectedFile?.content ?? "";
  const maxContentWidth = contentContentWidth - 2;
  const [contentScroll, setContentScroll] = useState(0);
  const viewportRows = Math.max(1, rows - 6);
  // word-wrap the selected file's content to the content pane width
  const wrappedContent = useMemo(
    () => (selectedFile ? wordWrap(content, Math.max(8, maxContentWidth)) : []),
    [content, maxContentWidth, selectedFile],
  );
  // reset scroll to top whenever the selected file changes
  useEffect(() => { setContentScroll(0); }, [selectedFile]);
  const safeContentScroll = Math.min(contentScroll, Math.max(0, wrappedContent.length - 1));
  const half = Math.max(1, Math.floor(viewportRows / 2));
  const cStart = Math.max(0, Math.min(safeContentScroll - half, Math.max(0, wrappedContent.length - viewportRows)));
  const visibleContent = wrappedContent.slice(cStart, cStart + viewportRows);

  return (
    <box flexDirection="column" width="100%" height={rows}>
      <Header title="Context files" subtitle={`${session.meta.id.slice(0, 8)}  ${files.length} file${files.length === 1 ? "" : "s"}`} theme={theme} />
      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" width={filePaneWidth} borderStyle="rounded" borderColor={theme.border} padding={1}>
          <text attributes={TextAttributes.BOLD} fg={theme.toolResult}> FILES</text>
          {visibleFiles.map((f, i) => (
            <text
              key={f.path}
              attributes={f.sel ? TextAttributes.BOLD : TextAttributes.DIM}
              fg={f.sel ? theme.accent : undefined}
            >
              {f.text}
            </text>
          ))}
        </box>
        <box flexDirection="column" width={contentPaneWidth} borderStyle="rounded" borderColor={theme.border} padding={1}>
          <text attributes={TextAttributes.BOLD} fg={theme.toolResult}> {tildeHome(selectedFile?.path ?? "(select a file)")}</text>
          {selectedFile ? (
            <box flexDirection="column" flexGrow={1}>
              {visibleContent.map((l, i) => (
                <text key={cStart + i} attributes={TextAttributes.DIM}>{l || " "}</text>
              ))}
            </box>
          ) : (
            <text fg={theme.toolResult} attributes={TextAttributes.DIM}>select a file to view its content</text>
          )}
        </box>
      </box>
      <KeyHint keys={[["scroll files", "j/k"], ["back", "q"], ["quit app", "Q"]]} theme={theme} />
    </box>
  );
}

function truncPath(path: string, max: number): string {
  if (path.length <= max) return path;
  return "…" + path.slice(-(max - 1));
}
