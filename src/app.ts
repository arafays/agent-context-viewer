/**
 * Imperative app router (no React). Owns the single root Box, the single key
 * dispatcher, terminal resize + theme wiring, and the navigation state. On
 * every state change it clears the root and rebuilds the active screen's
 * subtree from scratch — screens are factories that hold their own mutable
 * state in a closure and render imperatively into a container.
 */

import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core"
import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core"
import { availableTools, loadSession } from "./adapters/registry.ts"
import type { AgentSession, AgentTool, SessionMeta } from "./adapters/types.ts"
import { buildSearchIndex, type SearchIndex } from "./engine/search-index.ts"
import { discoverSession, sessionStoreRuntime } from "./engine/session-store.ts"
import { createContextFilesView } from "./ui/context-files-view.ts"
import { createContextView } from "./ui/context-view.ts"
import { clearChildren } from "./ui/framework.ts"
import { createHome } from "./ui/home.ts"
import { overlayOpen } from "./ui/overlay.ts"
import type { AppCtx, DiscoveryStatus, JumpTarget, ScreenInstance } from "./ui/screen.ts"
import { createSearchPanel } from "./ui/search-panel.ts"
import { createSessionDetail } from "./ui/session-detail.ts"
import { createSessionList } from "./ui/session-list.ts"
import { createSystemPromptView } from "./ui/system-prompt-view.ts"
import { defaultTheme, type Theme, watchTheme } from "./ui/theme.ts"

type Screen =
  | { name: "home" }
  | { name: "list"; tool: AgentTool; project: string | null }
  | { name: "detail"; meta: SessionMeta; session: AgentSession; jump?: JumpTarget; fromProject?: string | null }
  | { name: "context"; session: AgentSession }
  | { name: "sysprompt"; session: AgentSession }
  | { name: "files"; session: AgentSession }

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
  ["help", "?"]
]

export function createApp(renderer: CliRenderer): void {
  let theme: Theme = defaultTheme()
  let screen: Screen = { name: "home" }
  const sessionsByTool = {} as Record<AgentTool, SessionMeta[]>
  const discovery = {} as Record<AgentTool, DiscoveryStatus>
  let searchIndex: SearchIndex | null = null
  const cache = new Map<string, AgentSession>()
  let showHelp = false
  let searchOpen = false
  let lastTool: AgentTool = "pi"
  let indexRef: SearchIndex | null = null

  let currentScreen: ScreenInstance = createHome(lastTool)
  let searchPanel: ScreenInstance | null = null

  const root = new BoxRenderable(renderer, {})
  renderer.root.add(root)

  function setScreen(next: Screen, instance: ScreenInstance): void {
    screen = next
    currentScreen = instance
    render()
  }

  function openProject(tool: AgentTool, project: string): void {
    lastTool = tool
    setScreen({ name: "list", tool, project }, createSessionList(tool, project))
  }

  function openAll(tool: AgentTool): void {
    lastTool = tool
    setScreen({ name: "list", tool, project: null }, createSessionList(tool, null))
  }

  function goHome(): void {
    setScreen({ name: "home" }, createHome(lastTool))
  }

  function openContext(session: AgentSession): void {
    setScreen({ name: "context", session }, createContextView(session))
  }

  function openSysprompt(session: AgentSession): void {
    setScreen({ name: "sysprompt", session }, createSystemPromptView(session))
  }

  function openFiles(session: AgentSession): void {
    setScreen({ name: "files", session }, createContextFilesView(session))
  }

  function backToDetail(session: AgentSession): void {
    setScreen({ name: "detail", meta: session.meta, session }, createSessionDetail(session, session.meta))
  }

  function backFromDetail(meta: SessionMeta, fromProject: string | null): void {
    setScreen({ name: "list", tool: meta.tool, project: fromProject }, createSessionList(meta.tool, fromProject))
  }

  function openSearch(): void {
    searchOpen = true
    searchPanel = createSearchPanel()
    overlayOpen.current = true
    render()
  }

  function closeSearch(): void {
    searchOpen = false
    searchPanel = null
    overlayOpen.current = false
    render()
  }

  function openSession(meta: SessionMeta, jump?: JumpTarget, fromProject?: string | null): void {
    lastTool = meta.tool
    const key = meta.path ?? meta.id
    const cached = cache.get(key)
    if (cached) {
      setScreen(
        { name: "detail", meta, session: cached, jump, fromProject },
        createSessionDetail(cached, meta, jump, fromProject)
      )
      return
    }
    try {
      const session = loadSession(meta)
      cache.set(key, session)
      // refresh the fff search file with full fidelity now that we have the
      // fully-loaded session (the discovery-pass searchText is a cheaper subset)
      if (indexRef?.ready) {
        try {
          indexRef.writeSession(meta, session)
        } catch (e) {
          console.error("search write failed:", e)
        }
      }
      setScreen(
        { name: "detail", meta, session, jump, fromProject },
        createSessionDetail(session, meta, jump, fromProject)
      )
    } catch (e) {
      console.error("load failed:", e instanceof Error ? e.message : String(e))
    }
  }

  const ctx: AppCtx = {
    renderer,
    get theme() {
      return theme
    },
    get cols() {
      return renderer.width
    },
    get rows() {
      return renderer.height
    },
    get sessionsByTool() {
      return sessionsByTool
    },
    get discovery() {
      return discovery
    },
    get searchIndex() {
      return searchIndex
    },
    get sessionCache() {
      return cache
    },
    openSession,
    openProject,
    openAll,
    goHome,
    openContext,
    openSysprompt,
    openFiles,
    backToDetail,
    backFromDetail,
    openSearch,
    closeSearch,
    quit: () => renderer.destroy(),
    rerender: render
  }

  function renderHelp(): Renderable {
    const cols = renderer.width
    const h = renderer.height
    const overlay = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: cols,
      height: h,
      backgroundColor: theme.defaultBg ?? (theme.dark ? "#111" : "#f0f0f0"),
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center"
    })
    const panel = new BoxRenderable(renderer, {
      borderStyle: "rounded",
      borderColor: theme.accent,
      padding: 1,
      flexDirection: "column",
      width: 54
    })
    panel.add(new TextRenderable(renderer, { content: " Help", fg: theme.accent, attributes: TextAttributes.BOLD }))
    const list = new BoxRenderable(renderer, { flexDirection: "column", gap: 1, padding: 2 })
    for (const [label, k] of HELP_ROWS) {
      const row = new BoxRenderable(renderer, { flexDirection: "row", gap: 1 })
      row.add(
        new TextRenderable(renderer, { content: k.padEnd(25), attributes: TextAttributes.BOLD, fg: theme.warning })
      )
      row.add(new TextRenderable(renderer, { content: label }))
      list.add(row)
    }
    panel.add(list)
    overlay.add(panel)
    return overlay
  }

  function renderOverlay(panel: ScreenInstance): Renderable {
    const cols = renderer.width
    const rows = renderer.height
    const overlay = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      left: 0,
      width: cols,
      height: rows,
      backgroundColor: theme.defaultBg ?? (theme.dark ? "#111" : "#f0f0f0"),
      flexDirection: "column"
    })
    panel.render(overlay, ctx)
    return overlay
  }

  function render(): void {
    const cols = renderer.width
    const rows = renderer.height
    root.width = cols
    root.height = rows
    clearChildren(root)
    const body = new BoxRenderable(renderer, { flexDirection: "column", width: cols, height: rows })
    root.add(body)
    currentScreen.render(body, ctx)
    if (searchOpen && searchPanel) root.add(renderOverlay(searchPanel))
    if (showHelp) root.add(renderHelp())
    renderer.requestRender()
  }

  // Async, cache-first, per-tool discovery. Each tool runs on its own deferred
  // macrotask so the UI paints home immediately and tool lists stream in as
  // they finish (no single blocking full-parse pass across all tools).
  const tools = availableTools()
  for (const tool of tools) {
    sessionsByTool[tool] = []
    discovery[tool] = "pending"
  }
  let settled = 0
  const okTools: AgentTool[] = []
  for (const tool of tools) {
    discovery[tool] = "loading"
    sessionStoreRuntime.runPromise(discoverSession(tool)).then((res) => {
      sessionsByTool[tool] = res.metas
      discovery[tool] = res.error ? "error" : "done"
      if (!res.error) okTools.push(tool)
      settled++
      // Build the fuzzy search index incrementally as each tool settles, so a
      // slow discovery (e.g. a cold opencode scan) never blocks the index for
      // tools that already finished. Only tools that settled without error are
      // enumerated for cache cleanup.
      if (okTools.length > 0) {
        const settledTools = [...okTools]
        setTimeout(() => {
          const snapshot: Record<AgentTool, SessionMeta[]> = { ...sessionsByTool }
          for (const t of settledTools) snapshot[t] = sessionsByTool[t] ?? []
          const idx = buildSearchIndex(snapshot, settledTools)
          indexRef = idx.index
          searchIndex = idx.index
          render()
        }, 0)
      }
      if (settled === tools.length) {
        setTimeout(() => {
          const idx = buildSearchIndex({ ...sessionsByTool }, [...okTools])
          indexRef = idx.index
          searchIndex = idx.index
          render()
        }, 0)
      }
      render()
    })
  }

  // Live terminal theme: default first, then the real palette on OSC answer.
  watchTheme(renderer, (t) => {
    theme = t
    render()
  })

  renderer.on("resize", () => render())

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    // Global hard quit — Shift+Q from anywhere destroys the app.
    if (key.name === "q" && key.shift) {
      renderer.destroy()
      return
    }
    // Ctrl+C quits (the renderer was created with exitOnCtrlC disabled).
    if (key.name === "c" && key.ctrl) {
      renderer.destroy()
      return
    }
    if (showHelp) {
      if (key.name === "escape" || (key.name === "q" && !key.shift) || key.name === "return") {
        showHelp = false
        if (!searchOpen) overlayOpen.current = false
        render()
      }
      return
    }
    if (searchOpen) {
      searchPanel?.handleKey(key, ctx)
      return
    }
    if (key.name === "?") {
      showHelp = true
      overlayOpen.current = true
      render()
      return
    }
    // global fuzzy search (jump-to-turn) on screens that have no inline / filter
    if (
      key.name === "/" &&
      (screen.name === "detail" || screen.name === "context" || screen.name === "sysprompt" || screen.name === "files")
    ) {
      openSearch()
      return
    }
    currentScreen.handleKey(key, ctx)
  })

  render()
}
