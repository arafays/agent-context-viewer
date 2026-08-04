import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/react"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { discoverSessions, loadSession, availableTools } from "./adapters/registry.ts"
import type { AgentSession, AgentTool, SessionMeta } from "./adapters/types.ts"
import { Home } from "./ui/home.tsx"
import { SessionList } from "./ui/session-list.tsx"
import { SessionDetail } from "./ui/session-detail.tsx"
import { ContextView } from "./ui/context-view.tsx"
import { SystemPromptView } from "./ui/system-prompt-view.tsx"
import { ContextFilesView } from "./ui/context-files-view.tsx"

type Screen =
  | { name: "home" }
  | { name: "list"; tool: AgentTool; project: string | null }
  | { name: "detail"; meta: SessionMeta; session: AgentSession }
  | { name: "context"; session: AgentSession }
  | { name: "sysprompt"; session: AgentSession }
  | { name: "files"; session: AgentSession };

const HELP_ROWS: Array<[string, string]> = [
  ["move / scroll", "j/k, ↑/↓, PgUp/PgDn"],
  ["search", "/"],
  ["open / select", "Enter"],
  ["switch tool", "Tab / g / G"],
  ["context view", "c"],
  ["system prompt", "s"],
  ["context files", "f"],
  ["show thinking", "t"],
  ["toggle snapshots", "d"],
  ["back / quit", "q / Esc"],
  ["help", "?"],
];

export function App() {
  const renderer = useRenderer();
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [sessionsByTool, setSessionsByTool] = useState<Record<AgentTool, SessionMeta[]> | null>(null);
  const [cache] = useState(() => new Map<string, AgentSession>());
  const [showHelp, setShowHelp] = useState(false);
  const lastToolRef = useRef<AgentTool>("pi");

  // discovery on mount
  useEffect(() => {
    const byTool: Record<string, SessionMeta[]> = {};
    for (const tool of availableTools()) {
      byTool[tool] = discoverSessions(tool);
    }
    setSessionsByTool(byTool as Record<AgentTool, SessionMeta[]>);
  }, []);

  const openSession = (meta: SessionMeta) => {
    lastToolRef.current = meta.tool;
    const cached = cache.get(meta.path ?? meta.id);
    if (cached) {
      setScreen({ name: "detail", meta, session: cached });
      return;
    }
    try {
      const session = loadSession(meta);
      cache.set(meta.path ?? meta.id, session);
      setScreen({ name: "detail", meta, session });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("load failed:", err);
    }
  };

  useKeyboard((key) => {
    // Global help toggle
    if (key.name === "?" && !showHelp) {
      setShowHelp(true);
      return;
    }
    if (showHelp) {
      if (key.name === "escape" || key.name === "q" || key.name === "return") {
        setShowHelp(false);
      }
      return;
    }
  });

  const body = useMemo(() => {
    if (!sessionsByTool) {
      return (
        <box flexDirection="column" alignItems="center" justifyContent="center" width="100%" height="100%">
          <text>Loading sessions...</text>
        </box>
      );
    }
    switch (screen.name) {
      case "home":
        return (
          <Home
            sessionsByTool={sessionsByTool}
            initialTool={lastToolRef.current}
            onOpenProject={(tool, project) => {
              lastToolRef.current = tool;
              setScreen({ name: "list", tool, project });
            }}
            onOpenAll={(tool) => {
              lastToolRef.current = tool;
              setScreen({ name: "list", tool, project: null });
            }}
            onQuit={() => renderer.destroy()}
          />
        );
      case "list":
        return (
          <SessionList
            tool={screen.tool}
            project={screen.project}
            sessions={sessionsByTool[screen.tool] ?? []}
            onOpen={(meta) => openSession(meta)}
            onBack={() => setScreen({ name: "home" })}
          />
        );
      case "detail":
        return (
          <SessionDetail
            session={screen.session}
            meta={screen.meta}
            onOpenContext={() => setScreen({ name: "context", session: screen.session })}
            onOpenSysPrompt={() => setScreen({ name: "sysprompt", session: screen.session })}
            onOpenFiles={() => setScreen({ name: "files", session: screen.session })}
            onBack={() => setScreen({ name: "list", tool: screen.meta.tool, project: null })}
          />
        );
      case "context":
        return (
          <ContextView session={screen.session} onBack={() => setScreen({
            name: "detail",
            meta: screen.session.meta,
            session: screen.session,
          })} />
        );
      case "sysprompt":
        return (
          <SystemPromptView
            session={screen.session}
            onBack={() => setScreen({
              name: "detail",
              meta: screen.session.meta,
              session: screen.session,
            })}
          />
        );
      case "files":
        return (
          <ContextFilesView
            session={screen.session}
            onBack={() => setScreen({
              name: "detail",
              meta: screen.session.meta,
              session: screen.session,
            })}
          />
        );
    }
  }, [screen, sessionsByTool, cache]);

  const helpPanel = showHelp ? (
    <box position="absolute" width="100%" height="100%" backgroundColor="#111">
      <box borderStyle="rounded" borderColor="#00FFFF" padding={1} flexDirection="column" width={50} style={{ marginTop: 2, marginLeft: 4 }}>
        <text fg="#00FFFF" attributes={TextAttributes.BOLD}>Help</text>
        <box flexDirection="column" gap={1}>
          {HELP_ROWS.map(([label, k]) => (
            <box key={label} flexDirection="row" gap={1}>
              <text attributes={TextAttributes.BOLD} fg="#FFFF00">{k.padEnd(25)}</text>
              <text>{label}</text>
            </box>
          ))}
        </box>
      </box>
    </box>
  ) : null;

  return (
    <box flexDirection="column" width="100%" height="100%">
      {body}
      {helpPanel}
    </box>
  );
}
