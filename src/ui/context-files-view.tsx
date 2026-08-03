/**
 * Context Files view — the AGENTS.md/CLAUDE.md hierarchy that was injected
 * into the system prompt (global agent file + ancestors from cwd up to root).
 */
import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { Header, KeyHint, ListKeyBindings, ScrollList, useSelection, useTerminalSize } from "./components.tsx";
import type { AgentSession } from "../adapters/types.ts";

export function ContextFilesView({ session, onBack }: { session: AgentSession; onBack: () => void }) {
  const info = useMemo(() => session.contextInfo, [session]);
  const [selectedFile, setSelectedFile] = useState(0);

  const files = info.contextFiles;
  const fileSel = useSelection(files.length);
  const activeFile = files[Math.min(fileSel.selected, Math.max(0, files.length - 1))];

  ListKeyBindings({
    move: fileSel.move,
    onOpen: () => {},
    extra: (input, key) => (input === "q" || key.escape) && onBack(),
  });

  return (
    <Box flexDirection="column">
      <Header title={`Context files — ${session.meta.id.slice(0, 8)}`} subtitle={`AGENTS.md/CLAUDE.md loaded for ${session.meta.cwd}`} />
      {files.length === 0 ? (
        <Text dimColor wrap="truncate-end">no AGENTS.md/CLAUDE.md found</Text>
      ) : (
        <>
          <Box flexDirection="column" borderStyle="round" borderColor="gray" marginLeft={1} marginRight={1} marginTop={1}>
            <ScrollList
              items={files}
              selected={fileSel.selected}
              onSelect={fileSel.setSelected}
              topOffset={0}
              bottomOffset={1}
              renderItem={(f, _i, sel) => (
                <Box paddingLeft={1}>
                  <Text color={sel ? "cyan" : "dim"} bold={sel}>
                    {sel ? "▶ " : "  "}
                    {f.global ? "[global] " : ""}
                  </Text>
                  <Text color={sel ? "white" : "gray"} wrap="truncate-end">
                    {f.path.padEnd(70)}
                  </Text>
                  <Text dimColor>{`  ${f.content.length.toLocaleString()} chars`}</Text>
                </Box>
              )}
            />
          </Box>
          <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray" marginLeft={1} marginRight={1}>
            <Text bold color="gray" wrap="truncate-end">
              {activeFile?.path ?? ""}
            </Text>
            {activeFile ? (
              <FileContent content={activeFile.content} />
            ) : null}
          </Box>
          <Box paddingLeft={1} paddingTop={1}>
            <KeyHint keys={[["j/k", "file"], ["q", "back"]]} />
          </Box>
        </>
      )}
    </Box>
  );
}

function FileContent({ content }: { content: string }) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const sel = useSelection(lines.length);
  const { rows } = useTerminalSize();
  const viewport = Math.max(1, rows - 12);
  const start = Math.max(0, Math.min(sel.selected - Math.floor(viewport / 2), Math.max(0, lines.length - viewport)));
  const visible = lines.slice(start, start + viewport);
  return (
    <Box flexDirection="column">
      {visible.map((l, i) => (
        <Text key={start + i} wrap="truncate-end" dimColor={l.trim() === ""}>
          {l}
        </Text>
      ))}
    </Box>
  );
}
