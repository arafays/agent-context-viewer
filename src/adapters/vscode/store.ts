/**
 * Store discovery for the VS Code / Copilot Chat adapter.
 *
 * Where VS Code persists chat (verified on this machine, Linux):
 *  - `~/.config/<quality>/User/workspaceStorage/<hash>/chatSessions/*.jsonl`
 *      Primary transcript store: per-session ObjectMutationLog files (the
 *      richest source — requests, responses, usage, variableData…).
 *  - `~/.config/<quality>/User/workspaceStorage/<hash>/workspace.json`
 *      Maps the storage dir to its workspace folder (`{folder|workspace}:
 *      file:///…`) → session cwd.
 *  - `~/.config/<quality>/User/globalStorage/emptyWindowChatSessions/*.jsonl`
 *      Transcripts started from an empty window (no workspace → no cwd).
 *  - `~/.config/<quality>/User/globalStorage/github.copilot-chat/session-store.db`
 *      SQLite (`schema_version`=3): `sessions` (cwd, branch, repository,
 *      summary, created/updated), `turns` (user_message/assistant_response
 *      per turn_index), `session_files` (file_path/tool_name touched),
 *      `session_refs`, `checkpoints`, FTS5 `search_index`. Small/partial —
 *      only a few sessions here even when chatSessions has hundreds — used
 *      for enrichment (branch/repo) + as a last-resort transcript source.
 *
 * `<quality>` is one of the standard user-data dir names. All opens are
 * read-only; when the WAL-shaded DB can't be opened read-only, the db + -wal
 * + -shm are copied to /tmp/opencode/ and the copy is queried instead —
 * the user's data is never written or checkpointed.
 */
import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** VS Code user-data dir qualities to scan (Insiders first: newest data). */
const QUALITIES = ["Code - Insiders", "Code", "Code - OSS", "VSCodium"]

/** Base dir that contains the per-quality user-data dirs (XDG-aware). */
export function configRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return xdg ? xdg : join(homedir(), ".config")
}

export interface VscodeStore {
  /** quality dir name, e.g. "Code - Insiders" */
  quality: string
  /** <configRoot>/<quality>/User */
  userDir: string
}

/** Existing user-data dirs that may hold chat stores. */
export function findStores(): VscodeStore[] {
  const out: VscodeStore[] = []
  for (const q of QUALITIES) {
    const userDir = join(configRoot(), q, "User")
    if (existsSync(userDir)) out.push({ quality: q, userDir })
  }
  return out
}

/** One chat transcript file on disk. */
export interface ChatFile {
  /** absolute path to the .jsonl mutation log */
  path: string
  /** session id (= file name without .jsonl; also the state's sessionId) */
  id: string
  /** workspace cwd ("" for empty-window transcripts without a db row) */
  cwd: string
  sizeBytes: number
  mtimeMs: number
}

/** Decode `workspace.json` → the workspace folder cwd ("" when absent). */
export function workspaceCwd(storageDir: string): string {
  const wf = join(storageDir, "workspace.json")
  if (!existsSync(wf)) return ""
  try {
    const parsed = JSON.parse(readFileSync(wf, "utf8")) as { folder?: unknown; workspace?: unknown }
    const raw =
      typeof parsed.folder === "string" ? parsed.folder : typeof parsed.workspace === "string" ? parsed.workspace : ""
    if (!raw) return ""
    try {
      const p = fileURLToPath(raw)
      // a .code-workspace file defines the workspace; its dir is the cwd
      return p.endsWith(".code-workspace") ? dirname(p) : p
    } catch {
      return ""
    }
  } catch {
    return ""
  }
}

/**
 * Enumerate every chat transcript file across all stores:
 * workspaceStorage/<hash>/chatSessions/*.jsonl + globalStorage/emptyWindowChatSessions.
 */
export function listChatFiles(stores: VscodeStore[]): ChatFile[] {
  const out: ChatFile[] = []
  const pushFile = (path: string, cwd: string): void => {
    try {
      const st = statSync(path)
      if (!st.isFile()) return
      const id = basename(path).replace(/\.jsonl$/, "")
      if (!id) return
      out.push({ path, id, cwd, sizeBytes: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* unreadable file — skip */
    }
  }
  for (const store of stores) {
    const wsRoot = join(store.userDir, "workspaceStorage")
    if (existsSync(wsRoot)) {
      let dirs: string[]
      try {
        dirs = readdirSync(wsRoot)
      } catch {
        dirs = []
      }
      for (const d of dirs) {
        const dir = join(wsRoot, d)
        const cs = join(dir, "chatSessions")
        if (!existsSync(cs)) continue
        const cwd = workspaceCwd(dir)
        let files: string[] = []
        try {
          files = readdirSync(cs)
        } catch {
          continue
        }
        for (const f of files) {
          if (f.endsWith(".jsonl")) pushFile(join(cs, f), cwd)
        }
      }
    }
    const empty = join(store.userDir, "globalStorage", "emptyWindowChatSessions")
    if (existsSync(empty)) {
      let files: string[] = []
      try {
        files = readdirSync(empty)
      } catch {
        files = []
      }
      for (const f of files) {
        if (f.endsWith(".jsonl")) pushFile(join(empty, f), "")
      }
    }
  }
  return out
}

/** Enrichment row for one session from session-store.db. */
export interface DbSessionRow {
  id: string
  cwd: string
  branch: string
  repository: string
  summary: string
  createdAt: string
  updatedAt: string
  agentName: string
  turnCount: number
  userMessages: number
  assistantResponses: number
  toolFiles: number
}

export interface SessionDb {
  path: string
  sizeBytes: number
  mtimeMs: number
  rows: Map<string, DbSessionRow>
}

/** Session-store.db path for a store (may not exist). */
export function sessionDbPath(store: VscodeStore): string {
  return join(store.userDir, "globalStorage", "github.copilot-chat", "session-store.db")
}

let openDb: Database | null = null
let openDbPath: string | null = null

/**
 * Open session-store.db strictly read-only. Falls back to copying
 * db + -wal + -shm into /tmp/opencode/ when the live WAL db rejects a
 * read-only connection (never modifies the user's data).
 */
function openReadonly(path: string): Database | null {
  try {
    const d = new Database(path, { readonly: true })
    d.query("SELECT 1").get() // probe: force the read path now
    return d
  } catch {
    /* fall through to the copy */
  }
  try {
    const dir = "/tmp/opencode/vscode-db"
    mkdirSync(dir, { recursive: true })
    const copy = join(dir, `session-store-${process.pid}.db`)
    copyFileSync(path, copy)
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix)
    }
    const d = new Database(copy, { readonly: true })
    d.query("SELECT 1").get()
    return d
  } catch {
    return null
  }
}

function num(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "string" && v.trim()) {
    const n = Date.parse(v)
    if (!Number.isNaN(n)) return n
    const p = Number(v)
    if (!Number.isNaN(p)) return p
  }
  return 0
}

/**
 * Read the (small) session-store.db from the first store that has it.
 * Returns null when no db exists — discovery must degrade to jsonl-only.
 */
export function readSessionDb(stores: VscodeStore[]): SessionDb | null {
  for (const store of stores) {
    const path = sessionDbPath(store)
    if (!existsSync(path)) continue
    let st: { size: number; mtimeMs: number }
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (openDbPath !== path) {
      openDb?.close()
      openDb = openReadonly(path)
      openDbPath = path
    }
    const db = openDb
    if (!db) continue
    try {
      const rows = new Map<string, DbSessionRow>()
      const sessions = db
        .query(`SELECT id, cwd, repository, branch, summary, agent_name, created_at, updated_at FROM sessions`)
        .all() as Array<Record<string, unknown>>
      const turnCountQ = db.query(`SELECT COUNT(*) c FROM turns WHERE session_id = ?`)
      const usersQ = db.query(
        `SELECT COUNT(*) c FROM turns WHERE session_id = ? AND user_message IS NOT NULL AND user_message != ''`
      )
      const answersQ = db.query(
        `SELECT COUNT(*) c FROM turns WHERE session_id = ? AND assistant_response IS NOT NULL AND assistant_response != ''`
      )
      const filesQ = db.query(`SELECT COUNT(*) c FROM session_files WHERE session_id = ?`)
      for (const s of sessions) {
        const id = typeof s.id === "string" ? s.id : ""
        if (!id) continue
        const cnt = (q: typeof turnCountQ, fallback = 0): number => {
          try {
            const r = q.get(id) as { c?: unknown } | null
            return r && typeof r.c === "number" ? r.c : fallback
          } catch {
            return fallback
          }
        }
        rows.set(id, {
          id,
          cwd: typeof s.cwd === "string" ? s.cwd : "",
          branch: typeof s.branch === "string" ? s.branch : "",
          repository: typeof s.repository === "string" ? s.repository : "",
          summary: typeof s.summary === "string" ? s.summary : "",
          createdAt: typeof s.created_at === "string" ? s.created_at : "",
          updatedAt: typeof s.updated_at === "string" ? s.updated_at : "",
          agentName: typeof s.agent_name === "string" ? s.agent_name : "",
          turnCount: cnt(turnCountQ),
          userMessages: cnt(usersQ),
          assistantResponses: cnt(answersQ),
          toolFiles: cnt(filesQ)
        })
      }
      return { path, sizeBytes: st.size, mtimeMs: st.mtimeMs, rows }
    } catch {
      return { path, sizeBytes: st.size, mtimeMs: st.mtimeMs, rows: new Map() }
    }
  }
  return null
}

/** Raw turns of a db-only session (last-resort transcript source). */
export interface DbTurnRow {
  turnIndex: number
  userMessage: string
  assistantResponse: string
  timestamp: number
}

export function readDbTurns(dbPath: string, sessionId: string): DbTurnRow[] {
  if (openDbPath !== dbPath || !openDb) return []
  try {
    const rows = openDb
      .query(
        `SELECT turn_index, user_message, assistant_response, timestamp
         FROM turns WHERE session_id = ? ORDER BY turn_index`
      )
      .all(sessionId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      turnIndex: num(r.turn_index),
      userMessage: typeof r.user_message === "string" ? r.user_message : "",
      assistantResponse: typeof r.assistant_response === "string" ? r.assistant_response : "",
      timestamp: num(r.timestamp)
    }))
  } catch {
    return []
  }
}
