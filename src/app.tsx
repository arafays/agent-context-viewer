/**
 * Top-level app: session discovery + screen routing (state machine).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentTool, SessionMeta } from "./adapters/types.ts";
import { availableTools, discoverSessions, loadSession } from "./adapters/registry.ts";
import type { AgentSession } from "./adapters/types.ts";
import { Home } from "./ui/home.tsx";
import { SessionList } from "./ui/session-list.tsx";
import { SessionDetail } from "./ui/session-detail.tsx";
import { ContextView } from "./ui/context-view.tsx";
import { SystemPromptView } from "./ui/system-prompt-view.tsx";
import { ContextFilesView } from "./ui/context-files-view.tsx";
import { Spinner } from "./ui/components.tsx";

type Screen =
  | { name: "home" }
  | { name: "list"; tool: AgentTool; project: string | null }
  | { name: "detail"; session: SessionMeta; pi?: AgentSession }
  | { name: "context"; session: AgentSession }
  | { name: "sysprompt"; session: AgentSession }
  | { name: "files"; session: AgentSession };

export function App() {
  const [sessionsByTool, setSessionsByTool] = useState<Record<AgentTool, SessionMeta[]> | null>(null);
  const lastToolRef = useRef<AgentTool>("pi");
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [cache, setCache] = useState<Map<string, AgentSession>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  // Global `?` help toggle (works on every screen).
  useInput((input, key) => {
    if (input === "?") setShowHelp((v) => !v);
    else if (showHelp && (input === "q" || key.escape || key.return)) setShowHelp(false);
  });

  useEffect(() => {
    try {
      const byTool = {} as Record<AgentTool, SessionMeta[]>;
      for (const tool of availableTools()) {
        byTool[tool] = discoverSessions(tool);
      }
      setSessionsByTool(byTool);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const openSession = (meta: SessionMeta) => {
    lastToolRef.current = meta.tool;
    const cached = cache.get(meta.path);
    if (cached) {
      setScreen({ name: "detail", session: meta, pi: cached });
      return;
    }
    try {
      const s = loadSession(meta);
      const next = new Map(cache);
      next.set(meta.path, s);
      setCache(next);
      setScreen({ name: "detail", session: meta, pi: s });
    } catch (e) {
      setError(String(e));
    }
  };

  const back = () => {
    setScreen((prev) => {
      switch (prev.name) {
        case "home":
          process.exit(0);
          return prev;
        case "list":
          return { name: "home" };
        case "detail":
        case "context":
        case "sysprompt":
        case "files":
          return prev.name === "detail"
            ? ({ name: "list", tool: prev.session.tool, project: null } as Screen)
            : ({ name: "detail", session: sessionMetaOf(prev.session) } as Screen);
      }
    });
  };

  const currentDetailMeta = screen.name === "detail" ? screen.session : undefined;

  const sessionsFor = (tool: AgentTool) => sessionsByTool?.[tool] ?? [];

  const body = useMemo(() => {
    if (showHelp) return <HelpPanel onClose={() => setShowHelp(false)} />;
    if (error) return <Text color="red">{error}</Text>;
    if (!sessionsByTool) return <Spinner label="discovering sessions…" />;
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
            onQuit={() => process.exit(0)}
          />
        );
      case "list":
        return (
          <SessionList
            tool={screen.tool}
            project={screen.project}
            sessions={screen.project ? sessionsFor(screen.tool).filter((s) => s.project === screen.project) : sessionsFor(screen.tool)}
            onOpen={openSession}
            onBack={() => setScreen({ name: "home" })}
          />
        );
      case "detail":
        return (
          <SessionDetail
            session={screen.session}
            pi={screen.pi}
            onOpenContext={(s) => setScreen({ name: "context", session: s })}
            onOpenSystemPrompt={(s) => setScreen({ name: "sysprompt", session: s })}
            onOpenFiles={(s) => setScreen({ name: "files", session: s })}
            onBack={back}
          />
        );
      case "context":
        return <ContextView session={screen.session} onOpenSystemPrompt={(s) => setScreen({ name: "sysprompt", session: s })} onBack={back} />;
      case "sysprompt":
        return <SystemPromptView session={screen.session} onBack={back} />;
      case "files":
        return <ContextFilesView session={screen.session} onBack={back} />;
    }
  }, [screen, sessionsByTool, cache, error, showHelp]);

  return <Box flexDirection="column">{body}</Box>;
}

function sessionMetaOf(s: AgentSession): SessionMeta {
  return s.meta;
}

const HELP_ROWS: Array<[string, string]> = [
  ["j / k", "move selection / scroll"],
  ["↑ ↓", "move selection"],
  ["PgUp / PgDn", "page scroll"],
  ["Enter", "open session / toggle snapshots"],
  ["Tab or g / G", "switch agent tool (home)"],
  ["/", "search sessions / filter projects"],
  ["c", "context view (before/after per request)"],
  ["s", "system prompt view"],
  ["f", "context files view (AGENTS.md / CLAUDE.md)"],
  ["d / v", "toggle context snapshots"],
  ["t", "toggle thinking blocks"],
  ["?", "this help"],
  ["q / Esc", "back / quit"],
];

function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingLeft={1} paddingRight={1} margin={1}>
      <Text bold color="cyan">
        Keybindings
      </Text>
      {HELP_ROWS.map(([k, desc]) => (
        <Box key={k}>
          <Text bold color="yellow">
            {k.padEnd(14)}
          </Text>
          <Text dimColor>{desc}</Text>
        </Box>
      ))}
      <Text dimColor>{"\n? or q to close"}</Text>
    </Box>
  );
}
