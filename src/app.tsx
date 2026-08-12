import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/react"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { loadSession, availableTools } from "./adapters/registry.ts"
import type { AgentSession, AgentTool, SessionMeta } from "./adapters/types.ts"
import { getSessionStore } from "./engine/session-store.ts"
import { buildSearchIndex, type SearchIndex } from "./engine/search-index.ts"
import { Home } from "./ui/home.tsx"
import { SessionList } from "./ui/session-list.tsx"
import { SessionDetail } from "./ui/session-detail.tsx"
import { ContextView } from "./ui/context-view.tsx"
import { SystemPromptView } from "./ui/system-prompt-view.tsx"
import { ContextFilesView } from "./ui/context-files-view.tsx"
import { SearchPanel } from "./ui/search-panel.tsx"
import { overlayOpen } from "./ui/overlay.ts"
import { defaultTheme, watchTheme, type Theme } from "./ui/theme.ts"

type Screen =
  | { name: "home" }
  | { name: "list"; tool: AgentTool; project: string | null }
  | { name: "detail"; meta: SessionMeta; session: AgentSession; jump?: { turn: number }; fromProject?: string | null }
  | { name: "context"; session: AgentSession }
  | { name: "sysprompt"; session: AgentSession }
  | { name: "files"; session: AgentSession };

/** A jump target derived from a search hit. */
export interface JumpTarget {
  /** turn index in the session's turns array. */
  turn: number;
}

type DiscoveryStatus = "pending" | "loading" | "done" | "error";

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
  // seeded to {} so Home renders immediately; per-tool lists stream in as
  // each tool's (cache-first, async) discovery completes.
  const [sessionsByTool, setSessionsByTool] = useState<Record<AgentTool, SessionMeta[]>>({} as Record<AgentTool, SessionMeta[]>);
  const [discovery, setDiscovery] = useState<Record<AgentTool, DiscoveryStatus>>({} as Record<AgentTool, DiscoveryStatus>);
  const [searchIndex, setSearchIndex] = useState<SearchIndex | null>(null);
  const [cache] = useState(() => new Map<string, AgentSession>());
  const [showHelp, setShowHelp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const lastToolRef = useRef<AgentTool>("pi");
  const indexRef = useRef<SearchIndex | null>(null);

  // Async, cache-first, per-tool discovery. Each tool runs on its own deferred
  // macrotask so the UI paints home immediately and tool lists appear as they
  // finish (no single blocking full-parse pass across all tools).
  useEffect(() => {
    const store = getSessionStore();
    const tools = availableTools();
    const byTool: Record<AgentTool, SessionMeta[]> = {} as Record<AgentTool, SessionMeta[]>;
    const statuses = {} as Record<AgentTool, DiscoveryStatus>;
    for (const tool of tools) {
      byTool[tool] = [];
      statuses[tool] = "pending";
    }
    setSessionsByTool({ ...byTool });
    setDiscovery({ ...statuses });
    let settled = 0;
    const okTools: AgentTool[] = [];
    for (const tool of tools) {
      statuses[tool] = "loading";
      setDiscovery({ ...statuses });
      store.discover(tool).then((res) => {
        byTool[tool] = res.metas;
        setSessionsByTool({ ...byTool });
        statuses[tool] = res.error ? "error" : "done";
        setDiscovery({ ...statuses });
        if (!res.error) okTools.push(tool);
        settled++;
        // Build the fuzzy search index incrementally as each tool settles, so
        // a slow discovery (e.g. a cold opencode scan) never blocks the index
        // for tools that already finished. Only tools that settled without
        // error are enumerated for cache cleanup — an errored tool must not
        // have its cached search files treated as authoritative-empty.
        if (okTools.length > 0) {
          const settledTools = [...okTools];
          setTimeout(() => {
            const snapshot: Record<AgentTool, SessionMeta[]> = { ...byTool };
            for (const t of settledTools) snapshot[t] = byTool[t] ?? [];
            const idx = buildSearchIndex(snapshot, settledTools);
            indexRef.current = idx.index;
            setSearchIndex(idx.index);
          }, 0);
        }
        if (settled === tools.length) {
          // final rebuild once everything settles, so the snapshot is complete
          setTimeout(() => {
            const idx = buildSearchIndex({ ...byTool }, [...okTools]);
            indexRef.current = idx.index;
            setSearchIndex(idx.index);
          }, 0);
        }
      });
    }
  }, []);

  // Live terminal theme: default first, then swap to the real palette once
  // the renderer answers the OSC query (and on any later palette change).
  useEffect(() => {
    return watchTheme(renderer, setTheme);
  }, [renderer]);

  const openSession = (meta: SessionMeta, jump?: { turn: number }, fromProject?: string | null) => {
    lastToolRef.current = meta.tool;
    const cached = cache.get(meta.path ?? meta.id);
    if (cached) {
      setScreen({ name: "detail", meta, session: cached, jump, fromProject });
      return;
    }
    try {
      const session = loadSession(meta);
      cache.set(meta.path ?? meta.id, session);
      // refresh the fff search file with full fidelity now that we have the
      // fully-loaded session (the discovery-pass searchText is a cheaper subset)
      if (indexRef.current?.ready) {
        try {
          indexRef.current.writeSession(meta, session);
        } catch (e) {
          // a failed cache write must not block opening the session
          console.error("search write failed:", e);
        }
      }
      setScreen({ name: "detail", meta, session, jump, fromProject });
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
    // Ctrl+C quits (the renderer was created with exitOnCtrlC disabled).
    if (key.name === "c" && key.ctrl) {
      renderer.destroy();
      return;
    }
    if (showHelp) {
      if (key.name === "escape" || (key.name === "q" && !key.shift) || key.name === "return") {
        setShowHelp(false);
        if (!searchOpen) overlayOpen.current = false;
      }
      return;
    }
    if (searchOpen) {
      return;
    }
    if (key.name === "?") {
      setShowHelp(true);
      overlayOpen.current = true;
      return;
    }
    // global fuzzy search (jump-to-turn) on screens that have no inline / filter
    if (
      key.name === "/" &&
      (screen.name === "detail" || screen.name === "context" || screen.name === "sysprompt" || screen.name === "files")
    ) {
      setSearchOpen(true);
      overlayOpen.current = true;
    }
  });

  const body = useMemo(() => {
    switch (screen.name) {
      case "home":
        return (
          <Home
            sessionsByTool={sessionsByTool}
            discovery={discovery}
            index={searchIndex}
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
            onQuit={() => renderer.destroy()}
          />
        );
      case "list":
        return (
          <SessionList
            tool={screen.tool}
            project={screen.project}
            sessions={sessionsByTool[screen.tool] ?? []}
            status={discovery[screen.tool]}
            index={searchIndex}
            theme={theme}
            onOpen={(meta) => openSession(meta, undefined, screen.project)}
            onBack={() => setScreen({ name: "home" })}
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
            onBack={() => setScreen({ name: "list", tool: screen.meta.tool, project: screen.fromProject ?? null })}
          />
        );
      case "context":
        return (
          <ContextView
            session={screen.session}
            theme={theme}
            onOpenSysPrompt={() => setScreen({ name: "sysprompt", session: screen.session })}
            onBack={() => setScreen({
              name: "detail",
              meta: screen.session.meta,
              session: screen.session,
            })}
          />
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
  }, [screen, sessionsByTool, discovery, searchIndex, cache, theme]);

  const searchPanel = searchOpen ? (
    <SearchPanel
      index={searchIndex}
      tool={null}
      sessionsByTool={sessionsByTool}
      theme={theme}
      onPick={(hit) => {
        setSearchOpen(false);
        overlayOpen.current = false;
        openSession(hit.meta, { turn: hit.turn });
      }}
      onClose={() => {
        setSearchOpen(false);
        overlayOpen.current = false;
      }}
    />
  ) : null;

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

  return (
    <box flexDirection="column" width="100%" height="100%">
      {body}
      {searchPanel}
      {helpPanel}
    </box>
  );
}
