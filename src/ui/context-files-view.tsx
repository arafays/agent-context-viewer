import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useState } from "react"
import { Header, KeyHint, useSelection } from "./components.tsx"
import type { AgentSession } from "../adapters/types.ts"

export function ContextFilesView({
  session,
  onBack,
}: {
  session: AgentSession;
  onBack: () => void;
}) {
  const { width: columns, height: rows } = useTerminalDimensions();
  const info = session.contextInfo;
  const files = info.contextFiles;
  const fileSel = useSelection(files.length);
  const selectedFile = files[fileSel.selected];

  useKeyboard((key) => {
    if (key.name === "down" || key.name === "j") fileSel.move(1);
    else if (key.name === "up" || key.name === "k") fileSel.move(-1);
    else if (key.name === "home") fileSel.move(-Number.MAX_SAFE_INTEGER);
    else if (key.name === "end") fileSel.move(Number.MAX_SAFE_INTEGER);
    else if (key.name === "q" || key.name === "escape") onBack();
  });

  const filePaneWidth = Math.floor(columns / 3);
  const contentPaneWidth = columns - filePaneWidth - 2;

  const fileLines = files.map((f, i) => ({
    text: `${f.global ? "[global]" : "       "} ${truncPath(f.path, filePaneWidth - 12)}`,
    sel: i === fileSel.selected,
  }));

  const content = selectedFile?.content ?? "";
  const contentLines = content.split("\n");
  const [contentScroll, setContentScroll] = useState(0);

  const visibleContent = contentLines.slice(contentScroll, contentScroll + rows - 6);

  return (
    <box flexDirection="column" width="100%" height={rows}>
      <Header title="Context files" subtitle={`${session.meta.id.slice(0, 8)}  ${files.length} file${files.length === 1 ? "" : "s"}`} />
      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" width={filePaneWidth} borderStyle="rounded" borderColor="gray" padding={1}>
          <text attributes={TextAttributes.BOLD} fg="gray"> FILES</text>
          {fileLines.map((f, i) => (
            <text
              key={i}
              attributes={f.sel ? TextAttributes.BOLD : TextAttributes.DIM}
              fg={f.sel ? "cyan" : undefined}
            >
              {f.sel ? "▶ " : "  "}{f.text}
            </text>
          ))}
        </box>
        <box flexDirection="column" width={contentPaneWidth} borderStyle="rounded" borderColor="gray" padding={1}>
          <text attributes={TextAttributes.BOLD} fg="gray"> {selectedFile?.path ?? "(select a file)"}</text>
          {selectedFile ? (
            <box flexDirection="column" flexGrow={1}>
              {visibleContent.map((l, i) => (
                <text key={i}>{l}</text>
              ))}
            </box>
          ) : (
            <text fg="gray" attributes={TextAttributes.DIM}>select a file to view its content</text>
          )}
        </box>
      </box>
      <KeyHint keys={[["scroll files", "j/k"], ["back", "q"]]} />
    </box>
  );
}

function truncPath(path: string, max: number): string {
  if (path.length <= max) return path;
  return "…" + path.slice(-(max - 1));
}
