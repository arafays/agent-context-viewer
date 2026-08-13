/**
 * Session store — cache-first, async discovery for the app.
 *
 * Startup discovery currently blocks the UI on a synchronous full parse of
 * every session. This module:
 *   1. consults the sidecar meta cache (meta-cache.ts) so unchanged sessions
 *      are not re-parsed;
 *   2. exposes per-tool discovery as a background task so the UI can paint
 *      immediately and stream tool lists in as they finish.
 *
 * The heavy lifting stays in the per-adapter discoverSessions(); this module
 * just wraps it with the cache + async boundary.
 */
import { statSync } from "node:fs"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { discoverSessions as discoverTool } from "../adapters/registry.ts"
import type { AgentTool, SessionMeta } from "../adapters/types.ts"
import { createMetaCache, type MetaCache, metaCacheKey } from "./meta-cache.ts"

export interface ToolDiscoveryResult {
  tool: AgentTool
  metas: SessionMeta[]
  /** sessions re-parsed this run (cache misses) */
  parsed: number
  /** sessions served from the sidecar cache */
  cached: number
  /** number of stale sidecars removed */
  removed: number
  error?: string
}

export interface SessionStoreService {
  /** discover one tool on a background task; resolves with the result. */
  readonly discover: (tool: AgentTool) => Effect.Effect<ToolDiscoveryResult, never, never>
}

export class SessionStore extends Context.Tag("engine/SessionStore")<SessionStore, SessionStoreService>() {}

export const SessionStoreLive: Layer.Layer<SessionStore> = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const metaCache = createMetaCache()

    const discover = Effect.fn("SessionStore.discover")(function* (tool: AgentTool) {
      // Defer to a macrotask so the UI can paint the loading state before
      // the (potentially long) synchronous discovery runs.
      yield* Effect.yieldNow()
      return yield* Effect.try(() => ({ tool, ...discoverToolCached(tool, metaCache) })).pipe(
        Effect.catchAll((e) =>
          Effect.succeed({
            tool,
            metas: [],
            parsed: 0,
            cached: 0,
            removed: 0,
            error: e instanceof Error ? e.message : String(e)
          })
        )
      )
    })

    return SessionStore.of({ discover })
  })
)

export const sessionStoreRuntime: ManagedRuntime.ManagedRuntime<SessionStore, never> =
  ManagedRuntime.make(SessionStoreLive)

export const discoverSession = (tool: AgentTool): Effect.Effect<ToolDiscoveryResult, never, SessionStore> =>
  Effect.gen(function* () {
    const svc = yield* SessionStore
    return yield* svc.discover(tool)
  })

/**
 * Cache-first discovery for one tool. The adapter's discoverSessions()
 * consults the sidecar cache itself (it knows its own stat/mtime semantics);
 * here we only measure hits/misses for the progress report.
 */
function discoverToolCached(tool: AgentTool, cache: MetaCache): Omit<ToolDiscoveryResult, "tool"> {
  const metas = discoverTool(tool, cache)
  let cached = 0
  let parsed = 0
  for (const m of metas) {
    const entry = cache.read(metaCacheKey(m))
    if (entry && isFreshFor(m, entry)) cached++
    else parsed++
  }
  return { metas, parsed, cached, removed: 0 }
}

function isFreshFor(m: SessionMeta, entry: { sizeBytes: number; mtimeMs: number; meta: SessionMeta | null }): boolean {
  // opencode sessions have no file path (path === id); they are always
  // considered parsed (the adapter decides freshness via time_updated).
  if (m.tool === "opencode" || !m.path || m.path === m.id) return false
  try {
    const st = statSync(m.path)
    return entry.sizeBytes === st.size && entry.mtimeMs === st.mtimeMs && entry.meta !== null
  } catch {
    return false
  }
}
