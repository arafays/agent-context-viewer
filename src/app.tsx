import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/react"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { discoverSessions, loadSession, availableTools } from "./adapters/registry.ts"
import type { AgentSession, AgentTool, SessionMeta } from "./adapters/types.ts"
import { buildSearchIndex, type SearchIndex, type SearchHit } from "./engine/search-index.ts"
import { Home } from "./ui/home.tsx"
import { SessionList } from "./ui/session-list.tsx"
import { SessionDetail } from "./ui/session-detail.tsx"
import { ContextView } from "./ui/context-view.tsx"
import { SystemPromptView } from "./ui/system-prompt-view.tsx"
import { ContextFilesView } from "./ui/context-files-view.tsx"
import { SearchPanel } from "./ui/search-panel.tsx"
import { defaultTheme, watchTheme, type Theme } from "./ui/theme.ts"

type Screen =
  | { name: "home" }
  | { name: "list"; tool: AgentTool; project: string | null }
  | { name: "detail"; meta: SessionMeta; session: AgentSession; jump?: { turn: number } }
  | { name: "context"; session: AgentSession }
  | { name: "sysprompt"; session: AgentSession }
  | { name: "files"; session: AgentSession };

/** A jump target derived from a search hit. */
export interface JumpTarget {
  /** turn index in the session's turns array. */
  turn: number;
}

const HELP_ROWS: Array<[string, string]> = [
  ["move / scroll", "j/k, ↑/↓, PgUp/PgDn"],
  ["fuzzy search", "/"],
  ["open / select", "Enter"],
  ["switch tool", "Tab / g / G"],
  ["context view", "c"],
  ["system prompt", "s"],
  ["context files", "f"],
  ["show thinking", "t"],
  ["toggle snapshots", "d"],
  ["back", "q / Esc"],
  ["quit app", "Q (Shift+Q)"],
  ["help", "?"],
];

export function App() {
  const renderer = useRenderer();
  const [theme, setTheme] = useState<Theme>(() => defaultTheme());
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [sessionsByTool, setSessionsByTool] = useState<Record<AgentTool, SessionMeta[]> | null>(null);
  const [searchIndex, setSearchIndex] = useState<SearchIndex | null>(null);
  const [cache] = useState(() => new Map<string, AgentSession>());
  const [showHelp, setShowHelp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTool, setSearchTool] = useState<AgentTool | null>(null);
  const lastToolRef = useRef<AgentTool>("pi");
  const indexRef = useRef<SearchIndex | null>(null);

  // discovery on mount (synchronous — pre-existing), then build the fuzzy
  // search index. Both are heavy for opencode's 5GB DB, so index building is
  // deferred to a microtask so the UI paints the loaded list first.
  useEffect(() => {
    const byTool: Record<string, SessionMeta[]> = {};
    for (const tool of availableTools()) {
      byTool[tool] = discoverSessions(tool);
    }
    setSessionsByTool(byTool as Record<AgentTool, SessionMeta[]>);
    // build the search index after the first paint
    setTimeout(() => {
      const res = buildSearchIndex(byTool as Record<AgentTool, SessionMeta[]>);
      indexRef.current = res.index;
      setSearchIndex(res.index);
    }, 0);
  }, []);

  // Live terminal theme: default first, then swap to the real palette once
  // the renderer answers the OSC query (and on any later palette change).
  useEffect(() => {
    return watchTheme(renderer, setTheme);
  }, [renderer]);

  const openSession = (meta: SessionMeta, jump?: { turn: number }) => {
    lastToolRef.current = meta.tool;
    const cached = cache.get(meta.path ?? meta.id);
    if (cached) {
      setScreen({ name: "detail", meta, session: cached, jump });
      return;
    }
    try {
      const session = loadSession(meta);
      cache.set(meta.path ?? meta.id, session);
      setScreen({ name: "detail", meta, session, jump });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("load failed:", err);
    }
  };

  useKeyboard((key) => {
    // Global hard quit — Shift+Q from anywhere destroys the app.
    if (key.name === "q" && key.shift) {
      renderer.destroy();
      return;
    }
    // Global help toggle
    if (key.name === "?" && !showHelp) {
      setShowHelp(true);
      return;
    }
    if (showHelp) {
      if (key.name === "escape" || (key.name === "q" && !key.shift) || key.name === "return") {
        setShowHelp(false);
      }
      return;
    }
  });

  const openSearch = (tool: AgentTool | null) => {
    setSearchTool(tool);
    setSearchOpen(true);
  };

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
            theme={theme}
            onOpenProject={(tool, project) => {
              lastToolRef.current = tool;
              setScreen({ name: "list", tool, project });
            }}
            onOpenAll={(tool) => {
              lastToolRef.current = tool;
              setScreen({ name: "list", tool, project: null });
            }}
            onSearch={(tool) => openSearch(tool)}
            onQuit={() => renderer.destroy()}
          />
        );
      case "list":
        return (
          <SessionList
            tool={screen.tool}
            project={screen.project}
            sessions={sessionsByTool[screen.tool] ?? []}
            theme={theme}
            onOpen={(meta) => openSession(meta)}
            onBack={() => setScreen({ name: "home" })}
            onSearch={() => openSearch(screen.tool)}
          />
        );
      case "detail":
        return (
          <SessionDetail
            session={screen.session}
            meta={screen.meta}
            jump={screen.jump}
            theme={theme}
            onOpenContext={() => setScreen({ name: "context", session: screen.session })}
            onOpenSysPrompt={() => setScreen({ name: "sysprompt", session: screen.session })}
            onOpenFiles={() => setScreen({ name: "files", session: screen.session })}
            onBack={() => setScreen({ name: "list", tool: screen.meta.tool, project: null })}
          />
        );
      case "context":
        return (
          <ContextView session={screen.session} theme={theme} onBack={() => setScreen({
            name: "detail",
            meta: screen.session.meta,
            session: screen.session,
          })} />
        );
      case "sysprompt":
        return (
          <SystemPromptView
            session={screen.session}
            theme={theme}
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
            theme={theme}
            onBack={() => setScreen({
              name: "detail",
              meta: screen.session.meta,
              session: screen.session,
            })}
          />
        );
    }
  }, [screen, sessionsByTool, cache, theme]);

  const helpPanel = showHelp ? (
    <box position="absolute" width="100%" height="100%" backgroundColor={theme.defaultBg ?? (theme.dark ? "#111" : "#f0f0f0")} flexDirection="column" justifyContent="center" alignItems="center">
      <box borderStyle="rounded" borderColor={theme.accent} padding={1} flexDirection="column" width={54}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}> Help</text>
        <box flexDirection="column" gap={1} padding={2}>
          {HELP_ROWS.map(([label, k]) => (
            <box key={label} flexDirection="row" gap={1}>
              <text attributes={TextAttributes.BOLD} fg={theme.warning}>{k.padEnd(25)}</text>
              <text>{label}</text>
            </box>
          ))}
        </box>
      </box>
    </box>
  ) : null;

  const searchPanel = searchOpen ? (
    <SearchPanel
      index={searchIndex}
      tool={searchTool}
      sessionsByTool={sessionsByTool ?? ({} as Record<AgentTool, SessionMeta[]>)}
      theme={theme}
      onPick={(hit) => {
        setSearchOpen(false);
        openSession(hit.meta, { turn: hit.turn });
      }}
      onClose={() => setSearchOpen(false)}
    />
  ) : null;

  return (
    <box flexDirection="column" width="100%" height="100%">
      {body}
      {searchPanel}
      {helpPanel}
    </box>
  );
}
