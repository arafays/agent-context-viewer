/**
 * Shared contracts between the imperative app router (app.ts) and the screens.
 *
 * A "screen" is an imperative object with two methods: `render` rebuilds its
 * subtree into the given container; `handleKey` consumes a keypress and may
 * mutate navigation state via the `AppCtx` callbacks. The router owns the
 * single key dispatcher and re-renders after every handled key.
 */
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core"
import type { AgentSession, AgentTool, SessionMeta } from "../adapters/types.ts"
import type { SearchIndex } from "../engine/search-index.ts"
import type { Theme } from "./theme.ts"

export type DiscoveryStatus = "pending" | "loading" | "done" | "error"

/** A jump target derived from a search hit. */
export interface JumpTarget {
  turn: number
}

/**
 * Context handed to every screen render/handleKey call. Navigation methods
 * mutate the router state (and trigger a re-render) so screens never need to
 * know the `Screen` union.
 */
export interface AppCtx {
  readonly renderer: CliRenderer
  readonly theme: Theme
  readonly cols: number
  readonly rows: number
  readonly sessionsByTool: Record<AgentTool, SessionMeta[]>
  readonly discovery: Record<AgentTool, DiscoveryStatus>
  readonly searchIndex: SearchIndex | null
  readonly sessionCache: Map<string, AgentSession>
  /** open a session's detail view (optionally jumping to a turn). */
  openSession(meta: SessionMeta, jump?: JumpTarget, fromProject?: string | null): void
  /** home → list for a project. */
  openProject(tool: AgentTool, project: string): void
  /** home → list for all of a tool's sessions. */
  openAll(tool: AgentTool): void
  /** list → home. */
  goHome(): void
  /** detail → context. */
  openContext(session: AgentSession): void
  /** detail → system prompt. */
  openSysprompt(session: AgentSession): void
  /** detail → context files. */
  openFiles(session: AgentSession): void
  /** context/sysprompt/files → detail. */
  backToDetail(session: AgentSession): void
  /** detail → list. */
  backFromDetail(meta: SessionMeta, fromProject: string | null): void
  /** open the global fuzzy search overlay. */
  openSearch(): void
  /** close the global fuzzy search overlay. */
  closeSearch(): void
  /** destroy the app. */
  quit(): void
  /**
   * Force the app to re-render immediately. Screens call this after mutating
   * local state (selection, scroll, query, async results) so the imperative
   * tree is rebuilt against the new state.
   */
  rerender(): void
}

export interface ScreenInstance {
  render(container: Renderable, ctx: AppCtx): void
  handleKey(key: KeyEvent, ctx: AppCtx): void
}
