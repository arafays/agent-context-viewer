/**
 * Persistent sidecar cache for discovery-pass session metadata.
 *
 * Discovery currently full-parses every session file on every launch just to
 * fill counters + searchText. This cache persists that parsed `SessionMeta`
 * as a JSON sidecar in `~/.cache/acv/meta/` keyed by the session's source file
 * path, guarded by the source's size+mtime. When both match, discovery can
 * skip re-parsing and use the cached meta (searchText included).
 *
 * Layout mirrors the search-file layout from search-index.ts:
 *   <cacheRoot>/meta/<tool>/<project>/<sanitizedId>.json
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { SessionMeta } from "../adapters/types.ts"

/** Bump when a SessionMeta/cache schema change invalidates old sidecars. */
const CURRENT_VERSION = 1

export interface CachedSession {
  /** cache schema version (CURRENT_VERSION); mismatches are treated as a miss */
  version: number
  /** source file size in bytes at cache time */
  sizeBytes: number
  /** source file mtime in epoch ms at cache time */
  mtimeMs: number
  /** the parsed meta, or null when the session failed to parse */
  meta: SessionMeta | null
}

/** What callers supply when writing; `version` is stamped by write(). */
type CachedSessionInput = Omit<CachedSession, "version">

export interface MetaCache {
  /** read a sidecar; returns null when absent/corrupt */
  read(key: string): CachedSession | null
  /** write a sidecar (atomic via temp + rename); stamps the schema version */
  write(key: string, entry: CachedSessionInput): void
  /** delete a sidecar (used for stale cleanup) */
  remove(key: string): void
  /** the absolute dir the sidecars live in (for fff scan/warm) */
  dir: string
}

function cacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() ? process.env.XDG_CACHE_HOME : join(homedir(), ".cache")
  return join(base, "acv")
}

/**
 * Deterministic per-session cache key, mirroring sessionFileName() in
 * search-index.ts: <tool>/<project>/<sanitizedId> (no extension).
 */
export function metaCacheKey(meta: { tool: string; project?: string; cwd?: string; id: string }): string {
  const safeProject = (meta.project || meta.cwd || "misc").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "misc"
  const safeId = (meta.id || "session").replace(/[^\w.-]+/g, "_").slice(0, 120) || "session"
  return join("meta", meta.tool, safeProject, safeId)
}

export function createMetaCache(): MetaCache {
  const dir = join(cacheRoot(), "meta")
  mkdirSync(dir, { recursive: true })

  const fileFor = (key: string): string => {
    // keys already start with "meta/" — strip so join keeps them nested
    const rel = key.replace(/^meta\//, "")
    return join(dir, `${rel}.json`)
  }

  const read = (key: string): CachedSession | null => {
    const file = fileFor(key)
    if (!existsSync(file)) return null
    try {
      const raw = readFileSync(file, "utf8")
      const parsed = JSON.parse(raw) as Partial<CachedSession>
      if (typeof parsed !== "object" || parsed === null) return null
      if (parsed.version !== CURRENT_VERSION) return null
      if (typeof parsed.sizeBytes !== "number" || typeof parsed.mtimeMs !== "number") return null
      if (parsed.meta !== null && typeof parsed.meta !== "object") return null
      return {
        version: CURRENT_VERSION,
        sizeBytes: parsed.sizeBytes,
        mtimeMs: parsed.mtimeMs,
        meta: (parsed.meta ?? null) as SessionMeta | null
      }
    } catch {
      return null
    }
  }

  const write = (key: string, entry: CachedSessionInput): void => {
    const file = fileFor(key)
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ version: CURRENT_VERSION, ...entry }), "utf8")
      renameSync(tmp, file)
    } catch {
      /* cache is best-effort */
    }
  }

  const remove = (key: string): void => {
    try {
      rmSync(fileFor(key), { force: true })
    } catch {
      /* ignore */
    }
  }

  return { read, write, remove, dir }
}

/** Freshness check helper: size+mtime guard against the source stat. */
export function isFresh(entry: CachedSession, sizeBytes: number, mtimeMs: number): boolean {
  return entry.sizeBytes === sizeBytes && entry.mtimeMs === mtimeMs && entry.meta !== null
}

/** Stat wrapper returning { sizeBytes, mtimeMs } or null when unreadable. */
export function fileStat(path: string): { sizeBytes: number; mtimeMs: number } | null {
  try {
    const st = statSync(path)
    return { sizeBytes: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}
