/**
 * Read-only access to Cursor's on-disk stores.
 *
 * Cursor keeps everything the adapter reads in two SQLite files under
 * `~/.config/Cursor/User/globalStorage/`:
 *   - `state.vscdb`              — ItemTable, cursorDiskKV blobs (composerData,
 *                                  bubbles), composerHeaders
 *   - `conversation-search.db`   — Cursor's own title/FTS digest of chats
 *
 * Hard rule: these stores are opened read-only and never written. When a
 * direct read-only open fails (locked WAL, permissions), the db (+ -wal/-shm)
 * is snapshotted to a temp copy under the approved tmp dir and the copy is
 * opened instead.
 */
import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"

/** Cursor's config dir (honors XDG_CONFIG_HOME, falls back to ~/.config). */
export function cursorConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg?.trim() ? xdg : join(homedir(), ".config")
  return join(base, "Cursor")
}

/** Cursor's user-data dir (the store lives in User/globalStorage). */
export function cursorUserDir(): string {
  return join(cursorConfigDir(), "User")
}

/** Primary store: composerHeaders + cursorDiskKV blobs. */
export function globalStoragePath(): string {
  return join(cursorUserDir(), "globalStorage", "state.vscdb")
}

/** Cursor's chat digest store (titles + FTS bodies). */
export function conversationSearchPath(): string {
  return join(cursorUserDir(), "globalStorage", "conversation-search.db")
}

export interface OpenedDb {
  db: Database
  /** path of the live store (not the temp snapshot, when one was needed) */
  sourcePath: string
  dispose(): void
}

/**
 * Open a SQLite store read-only. Falls back to a snapshot copy in the tmp dir
 * when the live file cannot be read directly. Returns null when the store
 * does not exist or neither open works (caller treats it as "tool unavailable").
 */
export function openReadonly(path: string): OpenedDb | null {
  if (!existsSync(path)) return null
  try {
    const db = new Database(path, { readonly: true })
    db.query(`SELECT 1`).get()
    return { db, sourcePath: path, dispose: () => db.close() }
  } catch {
    /* direct open failed → snapshot copy below */
  }
  try {
    const dir = join(tmpdir(), "opencode")
    mkdirSync(dir, { recursive: true })
    const copy = join(dir, `cursor-${basename(path)}-${process.pid}.db`)
    copyFileSync(path, copy)
    for (const side of ["-wal", "-shm"]) {
      if (existsSync(path + side)) copyFileSync(path + side, copy + side)
    }
    const db = new Database(copy, { readonly: true })
    db.query(`SELECT 1`).get()
    return {
      db,
      sourcePath: path,
      dispose: () => {
        db.close()
        rmSync(copy, { force: true })
        rmSync(`${copy}-wal`, { force: true })
        rmSync(`${copy}-shm`, { force: true })
      }
    }
  } catch {
    return null
  }
}

let stateStore: OpenedDb | null | undefined
let searchStore: OpenedDb | null | undefined

/** Singleton open of state.vscdb (null when Cursor's store is absent/unreadable). */
export function openStateStore(): OpenedDb | null {
  if (stateStore === undefined) stateStore = openReadonly(globalStoragePath())
  return stateStore
}

/** Singleton open of conversation-search.db (null → titles/body simply unavailable). */
export function openSearchStore(): OpenedDb | null {
  if (searchStore === undefined) searchStore = openReadonly(conversationSearchPath())
  return searchStore
}

/** Close + forget both handles (tests/smoke). */
export function closeCursorStores(): void {
  stateStore?.dispose()
  searchStore?.dispose()
  stateStore = undefined
  searchStore = undefined
}
