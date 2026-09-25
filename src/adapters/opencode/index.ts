/**
 * opencode adapter — reads the opencode SQLite store (~/.local/share/opencode/opencode.db).
 *
 * Schema facts (verified against opencode 0.146-era DB):
 *  - `session` has rich precomputed columns: slug, directory, title, agent,
 *    model (JSON string {"id","providerID"}), cost, tokens_input/output/
 *    reasoning/cache_read/cache_write, time_created/updated/compacting/archived.
 *  - `message` data JSON: { role: "user"|"assistant", parentID, modelID,
 *    providerID, tokens:{total,input,output,reasoning,cache:{write,read}},
 *    cost, finish, path:{cwd,root}, time:{created,completed} }.
 *    Each assistant message == one LLM request (a tool loop = one user message
 *    followed by a parent-chained run of assistant messages).
 *  - `part` data JSON types: text, reasoning, tool (state.input/output),
 *    step-start/step-finish (snapshot hash + tokens), patch, file, compaction.
 *    A compaction is attached to a user-role message → that message becomes a
 *    compaction summary in the LLM context.
 *  - opencode 2.x writes `session_v2` + `session_message` instead (the legacy
 *    `session`/`message`/`part` tables stop being updated). v2-only sessions
 *    are normalized into the same message/parts shape here: user/assistant/
 *    compaction rows map to messages, synthetic/shell rows to `custom`
 *    messages, idle rows are skipped, and system/model/agent rows to events.
 *  - `session_message` also holds model-switched / agent-switched events and
 *    persisted `system` notices for every session.
 *
 * The system prompt is rebuilt by ./context.ts: exact from the persisted
 * `instruction_state`/`instruction_blob` rows when present, a labeled
 * two-block reconstruction otherwise.
 */
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { isFresh as cacheIsFresh, type MetaCache, metaCacheKey } from "../../engine/meta-cache.ts"
import { SearchFileBuilder } from "../../engine/transcript-lines.ts"
import type {
  AgentSession,
  ContentBlockView,
  ContextPoint,
  NormalizedMessage,
  SessionEventView,
  SessionMeta,
  Turn,
  UsageTotals
} from "../types.ts"
import { buildOpencodeContextInfo } from "./context.ts"

let db: Database | null = null

/** opencode data dir: OPENCODE_DATA_DIR → XDG_DATA_HOME/opencode → ~/.local/share/opencode */
export function getDataDir(): string {
  const env = process.env.OPENCODE_DATA_DIR
  if (env) return env
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".local", "share")
  return join(base, "opencode")
}

/** opencode config dir: OPENCODE_CONFIG → ~/.config/opencode (global AGENTS.md + skills live here) */
export function getConfigDir(): string {
  const env = process.env.OPENCODE_CONFIG
  if (env) return env
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".config")
  return join(base, "opencode")
}

function openDb(): Database {
  if (db) return db
  db = new Database(join(getDataDir(), "opencode.db"), { readonly: true })
  return db
}

function tableExists(d: Database, name: string): boolean {
  return Boolean(d.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name))
}

function num(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "bigint") return Number(v)
  return 0
}

function zeroUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function projectLabel(cwd: string): string {
  if (!cwd) return ""
  const b = basename(cwd)
  return b && b !== "/" ? b : cwd
}

function parseModel(raw: unknown): { id: string; providerID: string } | null {
  if (typeof raw !== "string") return null
  try {
    const o = JSON.parse(raw)
    if (o && typeof o === "object" && typeof o.id === "string") {
      return { id: o.id, providerID: typeof o.providerID === "string" ? o.providerID : "" }
    }
  } catch {
    /* not JSON → plain model string */
  }
  return typeof raw === "string" && raw.trim() ? { id: raw, providerID: "" } : null
}

/** Full discovery pass — one SQL scan over session/message/part, ~1s for 950 sessions. */
export function discoverSessions(cache?: MetaCache): SessionMeta[] {
  const d = openDb()

  // Cheap: the session table carries most meta (tokens, times, title). The
  // expensive parts are the three COUNT/GROUP BY queries and the message⋈part
  // join over the ~5GB DB. When every session is cache-fresh (time_updated
  // matches a sidecar), we skip all of them.
  //
  // opencode 2.x only writes `session_v2` (the legacy `session` table stops at
  // the migration), so source rows from it when it exists and keep any legacy
  // `session` rows it doesn't know about (orphans — none observed, but cheap).
  const SESSION_COLS = `id, slug, directory, title, model, agent, cost,
            tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
            time_created, time_updated, time_compacting, time_archived,
            summary_additions, summary_deletions, summary_files`
  const hasV2 = tableExists(d, "session_v2")
  let rows = (
    hasV2
      ? d
          .query(
            `SELECT ${SESSION_COLS} FROM session_v2
             UNION ALL
             SELECT ${SESSION_COLS} FROM session WHERE id NOT IN (SELECT id FROM session_v2)`
          )
          .all()
      : d.query(`SELECT ${SESSION_COLS} FROM session`).all()
  ) as Array<Record<string, unknown>>

  // Legacy membership decides storage: sessions present in `session` keep the
  // message/part read path; v2-only sessions are read from `session_message`.
  const legacyIds = new Set<string>(
    hasV2
      ? (d.query(`SELECT id FROM session`).all() as Array<{ id: string }>).map((r) => r.id)
      : rows.map((r) => String(r.id))
  )

  // Skip v2-only sessions with no `message` and no `session_message` rows —
  // throwaway sessions opencode created but never wrote a transcript to
  // (mostly "image auto-describe"); they would only clutter the list.
  if (hasV2) {
    const withSessionMessage = new Set(
      (d.query(`SELECT DISTINCT session_id FROM session_message`).all() as Array<{ session_id: string }>).map(
        (r) => r.session_id
      )
    )
    const hasMessageQ = d.query(`SELECT 1 FROM message WHERE session_id = ? LIMIT 1`)
    rows = rows.filter((r) => {
      const id = String(r.id)
      if (legacyIds.has(id)) return true
      if (withSessionMessage.has(id)) return true
      return Boolean(hasMessageQ.get(id))
    })
  }

  const updatedOf = (r: Record<string, unknown>): number => num(r.time_updated) || num(r.time_created)

  // Cache hits: session rows whose time_updated matches a sidecar.
  const cachedById = new Map<string, SessionMeta>()
  if (cache) {
    for (const r of rows) {
      const id = String(r.id)
      const key = metaCacheKey({
        tool: "opencode",
        project: projectLabel(typeof r.directory === "string" ? r.directory : ""),
        id
      })
      const entry = cache.read(key)
      if (entry && cacheIsFresh(entry, 0, updatedOf(r))) cachedById.set(id, entry.meta!)
    }
  }

  // Sessions that need re-parsing (new or changed since the sidecar).
  const missedIds = rows.map((r) => String(r.id)).filter((id) => !cachedById.has(id))
  const allCached = missedIds.length === 0
  // Legacy sessions read counts/text from message⋈part; v2-only sessions
  // (no legacy rows) from session_message.
  const missedV1 = missedIds.filter((id) => legacyIds.has(id))
  const missedV2 = missedIds.filter((id) => !legacyIds.has(id))

  const msgCounts = new Map<string, { total: number; users: number }>()
  const toolCounts = new Map<string, number>()
  const compCounts = new Map<string, number>()
  const searchTextBySession = new Map<string, string>()

  if (!allCached) {
    // When only a handful of sessions are stale, per-session indexed queries
    // are far cheaper than full-table GROUP BY scans of the (multi-GB) DB:
    // `WHERE session_id = ?` uses the primary index on both message and part,
    // while `session_id IN (...)` does not help the planner — it still walks
    // every row and json_extract()s every blob.
    const fewMisses = missedV1.length <= 64
    const msgCountQ = d.query(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN json_extract(data,'$.role')='user' THEN 1 ELSE 0 END) users
       FROM message WHERE session_id = ?`
    )
    const toolCountQ = d.query(
      `SELECT COUNT(*) c FROM part WHERE session_id = ? AND json_extract(data,'$.type')='tool'`
    )
    const compCountQ = d.query(
      `SELECT COUNT(*) c FROM part WHERE session_id = ? AND json_extract(data,'$.type')='compaction'`
    )
    if (fewMisses) {
      for (const id of missedV1) {
        const mc = msgCountQ.get(id) as { total: number; users: number | null } | null
        if (mc) msgCounts.set(id, { total: num(mc.total), users: num(mc.users) })
        const tc = toolCountQ.get(id) as { c: number } | null
        if (tc) toolCounts.set(id, num(tc.c))
        const cc = compCountQ.get(id) as { c: number } | null
        if (cc) compCounts.set(id, num(cc.c))
      }
    } else {
      // Bulk path: batch by session_id, but cap the batch so a single stale
      // session never re-scans the whole table. Fall back to per-session when
      // the batch is smaller than the table anyway.
      const missFilter = (col: string) =>
        `WHERE ${col} IN (${missedV1.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
      for (const r of d
        .query(
          `SELECT session_id, COUNT(*) total,
                  SUM(CASE WHEN json_extract(data,'$.role')='user' THEN 1 ELSE 0 END) users
           FROM message ${missFilter("session_id")} GROUP BY session_id`
        )
        .all() as Array<{ session_id: string; total: number; users: number | null }>) {
        msgCounts.set(r.session_id, { total: num(r.total), users: num(r.users) })
      }
      for (const r of d
        .query(
          `SELECT session_id, COUNT(*) c FROM part ${missFilter("session_id")} AND json_extract(data,'$.type')='tool' GROUP BY session_id`
        )
        .all() as Array<{ session_id: string; c: number }>) {
        toolCounts.set(r.session_id, num(r.c))
      }
      for (const r of d
        .query(
          `SELECT session_id, COUNT(*) c FROM part ${missFilter("session_id")} AND json_extract(data,'$.type')='compaction' GROUP BY session_id`
        )
        .all() as Array<{ session_id: string; c: number }>) {
        compCounts.set(r.session_id, num(r.c))
      }
    }

    // Cheap searchable text: user prompts + assistant replies (per design, tool
    // output is excluded — it dominates the DB and is rarely what you search for).
    // Format matches the search file (header/content pairs with [turn N]).
    // One SQL join over message+part; no per-message query (the DB is ~5GB).
    try {
      const sessionInfo = new Map<string, { directory: string; title: string }>()
      for (const r of rows) {
        sessionInfo.set(String(r.id), {
          directory: typeof r.directory === "string" ? r.directory : "",
          title: typeof r.title === "string" ? r.title : ""
        })
      }
      const builderFor = (sessionId: string): SearchFileBuilder => {
        const info = sessionInfo.get(sessionId) ?? { directory: "", title: "" }
        const dummyMeta: SessionMeta = {
          tool: "opencode",
          id: sessionId,
          path: sessionId,
          cwd: info.directory,
          project: projectLabel(info.directory),
          startedAt: "",
          updatedAt: "",
          sizeBytes: 0,
          messageCount: 0,
          userMessages: 0,
          assistantMessages: 0,
          toolResults: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compactionCount: 0,
          customTypes: [],
          name: info.title && !info.title.startsWith("New session") ? info.title : undefined,
          model: undefined
        }
        return SearchFileBuilder.start(dummyMeta)
      }
      const emitFor = (
        b: SearchFileBuilder,
        sessionId: string,
        role: string,
        text: string,
        turnBySession: Map<string, number>
      ): void => {
        const turn = turnBySession.get(sessionId) ?? 0
        // A user message and its assistant reply share the turn; a new user
        // message advances the turn counter.
        b.emit(turn, role === "user" ? "user" : "assistant", text)
        if (role === "user") turnBySession.set(sessionId, turn + 1)
      }
      if (fewMisses) {
        // Indexed per-session queries — no full-table join over the multi-GB DB.
        const textRowsQ = d.query(
          `SELECT m.data AS mdata, p.data AS pdata
           FROM message m
           JOIN part p ON p.message_id = m.id
           WHERE m.session_id = ?
             AND json_extract(m.data,'$.role') IN ('user','assistant')
             AND json_extract(p.data,'$.type') = 'text'
           ORDER BY m.time_created, p.time_created`
        )
        for (const id of missedV1) {
          const turnBySession = new Map<string, number>()
          const b = builderFor(id)
          const rowsForId = textRowsQ.all(id) as Array<{ mdata: string; pdata: string }>
          for (const r of rowsForId) {
            let role: string
            try {
              role = (JSON.parse(r.mdata) as { role?: string }).role ?? ""
            } catch {
              continue
            }
            if (role !== "user" && role !== "assistant") continue
            let text: string
            try {
              text = (JSON.parse(r.pdata) as { text?: string }).text ?? ""
            } catch {
              continue
            }
            if (!text.trim()) continue
            emitFor(b, id, role, text, turnBySession)
          }
          const s = b.toString()
          if (s) searchTextBySession.set(id, s)
        }
      } else {
        const missList = missedV1.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")
        const textRows = d
          .query(
            `SELECT m.session_id, m.data AS mdata, p.data AS pdata
             FROM message m
             JOIN part p ON p.message_id = m.id
             WHERE m.session_id IN (${missList})
               AND json_extract(m.data,'$.role') IN ('user','assistant')
               AND json_extract(p.data,'$.type') = 'text'
             ORDER BY m.time_created, p.time_created`
          )
          .all() as Array<{ session_id: string; mdata: string; pdata: string }>
        const turnBySession = new Map<string, number>()
        const buildersBySession = new Map<string, SearchFileBuilder>()
        for (const r of textRows) {
          const sessionId = r.session_id
          let role: string
          try {
            role = (JSON.parse(r.mdata) as { role?: string }).role ?? ""
          } catch {
            continue
          }
          if (role !== "user" && role !== "assistant") continue
          let text: string
          try {
            text = (JSON.parse(r.pdata) as { text?: string }).text ?? ""
          } catch {
            continue
          }
          if (!text.trim()) continue
          let b = buildersBySession.get(sessionId)
          if (!b) {
            b = builderFor(sessionId)
            buildersBySession.set(sessionId, b)
          }
          emitFor(b, sessionId, role, text, turnBySession)
        }
        for (const [sid, b] of buildersBySession) {
          const s = b.toString()
          if (s) searchTextBySession.set(sid, s)
        }
      }

      // v2-only sessions: counts + searchable text come from `session_message`
      // (message/part have no rows for them). One indexed scan feeds both.
      if (missedV2.length > 0) {
        try {
          const idList = missedV2.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")
          const v2Rows = d
            .query(
              `SELECT session_id, type, data FROM session_message
               WHERE session_id IN (${idList})
                 AND type IN ('user','assistant','synthetic','compaction','shell')
               ORDER BY session_id, seq`
            )
            .all() as Array<{ session_id: string; type: string; data: string }>
          const turnBySession = new Map<string, number>()
          const buildersBySession = new Map<string, SearchFileBuilder>()
          const totals = new Map<string, { total: number; users: number }>()
          for (const r of v2Rows) {
            let data: Record<string, unknown>
            try {
              data = JSON.parse(r.data) as Record<string, unknown>
            } catch {
              continue
            }
            const t = totals.get(r.session_id) ?? { total: 0, users: 0 }
            t.total += 1
            // user/synthetic/compaction rows normalize to user-role messages
            if (r.type === "user" || r.type === "synthetic" || r.type === "compaction") t.users += 1
            totals.set(r.session_id, t)
            if (r.type === "compaction") {
              compCounts.set(r.session_id, (compCounts.get(r.session_id) ?? 0) + 1)
            }
            // searchable text: user/synthetic prompts + assistant replies
            // (same scope as the v1 path — tool/reasoning output excluded)
            const texts: string[] = []
            if (r.type === "user" || r.type === "synthetic") {
              if (typeof data.text === "string") texts.push(data.text)
            } else if (r.type === "assistant") {
              const content = Array.isArray(data.content) ? data.content : []
              for (const c of content) {
                const item = c as { type?: unknown; text?: unknown }
                if (item?.type === "tool") {
                  toolCounts.set(r.session_id, (toolCounts.get(r.session_id) ?? 0) + 1)
                } else if (item?.type === "text" && typeof item.text === "string") {
                  texts.push(item.text)
                }
              }
            }
            for (const text of texts) {
              if (!text.trim()) continue
              let b = buildersBySession.get(r.session_id)
              if (!b) {
                b = builderFor(r.session_id)
                buildersBySession.set(r.session_id, b)
              }
              const turn = turnBySession.get(r.session_id) ?? 0
              b.emit(turn, r.type === "assistant" ? "assistant" : "user", text)
              // only a real user message advances the turn counter
              if (r.type === "user") turnBySession.set(r.session_id, turn + 1)
            }
          }
          for (const [id, t] of totals) msgCounts.set(id, t)
          for (const [sid, b] of buildersBySession) {
            const s = b.toString()
            if (s) searchTextBySession.set(sid, s)
          }
        } catch {
          /* index stays empty for opencode */
        }
      }
    } catch {
      /* index stays empty for opencode */
    }
  }

  const metas: SessionMeta[] = []
  for (const r of rows) {
    const id = String(r.id)
    const updated = num(r.time_updated) || num(r.time_created)
    const cached = cachedById.get(id)
    if (cached) {
      // live row data (title/model may have changed) — keep cached searchText
      metas.push({
        ...cached,
        updatedAt: new Date(updated).toISOString(),
        name: typeof r.title === "string" && r.title && !r.title.startsWith("New session") ? r.title : cached.name
      })
      continue
    }
    const counts = msgCounts.get(id) ?? { total: 0, users: 0 }
    const compCount = compCounts.get(id) ?? 0
    const model = parseModel(r.model)
    const title = typeof r.title === "string" ? r.title : ""
    const created = num(r.time_created)
    const input = num(r.tokens_input)
    const output = num(r.tokens_output)
    const cacheRead = num(r.tokens_cache_read)
    const meta: SessionMeta = {
      tool: "opencode",
      id,
      path: id,
      cwd: typeof r.directory === "string" ? r.directory : "",
      project: projectLabel(typeof r.directory === "string" ? r.directory : ""),
      startedAt: new Date(created).toISOString(),
      updatedAt: new Date(updated).toISOString(),
      sizeBytes: 0,
      name: title && !title.startsWith("New session") ? title : undefined,
      model: model ? `${model.providerID}/${model.id}`.replace(/^\//, model.id) : undefined,
      thinkingLevel: undefined,
      messageCount: counts.total,
      userMessages: counts.users,
      assistantMessages: counts.total - counts.users,
      toolResults: toolCounts.get(id) ?? 0,
      tokens: { input, output, cacheRead, cacheWrite: num(r.tokens_cache_write) },
      compactionCount: compCount,
      customTypes: compCount > 0 ? [{ type: "compaction", count: compCount }] : []
    }
    const searchText = searchTextBySession.get(id)
    if (searchText) meta.searchText = searchText
    if (cache) {
      cache.write(metaCacheKey({ tool: "opencode", project: meta.project, id }), {
        sizeBytes: 0,
        mtimeMs: updated,
        meta
      })
    }
    metas.push(meta)
  }
  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return metas
}

interface OcToolPart {
  type: string
  tool?: string
  callID?: string
  /** text/reasoning content (v1 part JSON + v2-derived parts) */
  text?: string
  /** compaction part: why the epoch re-snapshotted (v2 rows carry it) */
  reason?: string
  state?: { status?: string; input?: unknown; output?: unknown }
}

function fullOutput(out: unknown): string {
  if (typeof out === "string") return out
  if (out == null) return ""
  try {
    return JSON.stringify(out)
  } catch {
    return String(out)
  }
}

function textBlock(text: string): ContentBlockView {
  return { kind: "text", text }
}

/** Full load of one opencode session (messages + parts + events). */
export function loadSession(meta: SessionMeta): AgentSession {
  const d = openDb()
  // opencode 2.x sessions live in session_v2; the legacy `session` table stops
  // being updated at the migration (try v2 first so in-both sessions read the
  // row the app itself reads).
  let s: Record<string, unknown> | null = null
  if (tableExists(d, "session_v2")) {
    s = d.query(`SELECT * FROM session_v2 WHERE id = ?`).get(meta.id) as Record<string, unknown> | null
  }
  if (!s) s = d.query(`SELECT * FROM session WHERE id = ?`).get(meta.id) as Record<string, unknown> | null
  if (!s) throw new Error(`opencode session not found: ${meta.id}`)

  const msgRows = d
    .query(`SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created`)
    .all(meta.id) as Array<{ id: string; data: string }>
  const partRows = d
    .query(`SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created`)
    .all(meta.id) as Array<{ message_id: string; data: string }>
  // session_message carries events for every era and the full transcript for
  // v2-only sessions. seq is unique per session and strictly time-ordered
  // (verified: 0 inversions across the table).
  const smRows = d
    .query(`SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq`)
    .all(meta.id) as Array<{ type: string; data: string }>

  interface OcMsg {
    id: string
    role: "user" | "assistant" | "custom"
    data: Record<string, unknown>
  }
  const messages: OcMsg[] = []
  const partsByMsg = new Map<string, OcToolPart[]>()

  if (msgRows.length > 0) {
    // legacy storage: message + part tables (dual-written sessions also have
    // session_message rows — those are ignored here to avoid duplicates)
    for (const r of msgRows) {
      try {
        const data = JSON.parse(r.data) as Record<string, unknown>
        messages.push({ id: r.id, role: data.role === "user" ? "user" : "assistant", data })
      } catch {
        /* skip malformed */
      }
    }
    for (const r of partRows) {
      try {
        const d2 = JSON.parse(r.data) as OcToolPart
        const arr = partsByMsg.get(r.message_id) ?? []
        arr.push(d2)
        partsByMsg.set(r.message_id, arr)
      } catch {
        /* skip malformed */
      }
    }
  } else {
    // opencode 2.x storage: one session_message row per transcript entry,
    // normalized into the same message+parts shape the loop below expects
    let entry = 0
    for (const r of smRows) {
      const entryId = `sm_${entry++}`
      let data: Record<string, unknown>
      try {
        data = JSON.parse(r.data) as Record<string, unknown>
      } catch {
        continue
      }
      if (r.type === "user" || r.type === "compaction") {
        // a compaction row replaces history exactly like a v1 compaction part
        // attached to a user-role message
        messages.push({ id: entryId, role: "user", data: { role: "user", time: data.time } })
        const parts: OcToolPart[] = []
        if (r.type === "compaction") {
          parts.push({ type: "compaction", reason: typeof data.reason === "string" ? data.reason : undefined })
        } else if (typeof data.text === "string" && data.text.length > 0) {
          parts.push({ type: "text", text: data.text })
        }
        partsByMsg.set(entryId, parts)
      } else if (r.type === "assistant") {
        const model = data.model as { id?: unknown; providerID?: unknown } | undefined
        const parts: OcToolPart[] = []
        const content = Array.isArray(data.content) ? data.content : []
        for (const c of content) {
          const item = c as {
            type?: unknown
            text?: unknown
            name?: unknown
            id?: unknown
            state?: { status?: unknown; input?: unknown; content?: unknown; error?: unknown }
          }
          if (item?.type === "reasoning") {
            if (typeof item.text === "string") parts.push({ type: "reasoning", text: item.text })
          } else if (item?.type === "text") {
            if (typeof item.text === "string") parts.push({ type: "text", text: item.text })
          } else if (item?.type === "tool") {
            const st = item.state ?? {}
            let output: unknown
            if (Array.isArray(st.content)) {
              output = st.content
                .map((x) =>
                  x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string"
                    ? (x as { text: string }).text
                    : ""
                )
                .filter((t) => t.length > 0)
                .join("\n")
            } else if (st.error !== undefined) {
              output = st.error
            }
            parts.push({
              type: "tool",
              tool: typeof item.name === "string" ? item.name : "tool",
              callID: typeof item.id === "string" ? item.id : undefined,
              state: {
                status: typeof st.status === "string" ? st.status : undefined,
                input: st.input,
                output
              }
            })
          }
        }
        messages.push({
          id: entryId,
          role: "assistant",
          data: {
            role: "assistant",
            modelID: typeof model?.id === "string" ? model.id : undefined,
            providerID: typeof model?.providerID === "string" ? model.providerID : undefined,
            tokens: data.tokens,
            finish: data.finish,
            time: data.time
          }
        })
        partsByMsg.set(entryId, parts)
      } else if (r.type === "synthetic" || r.type === "shell") {
        // pushed into the LLM context as custom messages; they don't start a turn
        let text = ""
        if (r.type === "synthetic") {
          text = typeof data.text === "string" ? data.text : ""
        } else {
          const cmd = typeof data.command === "string" ? data.command : ""
          const exit = typeof data.exit === "number" ? `exit ${data.exit}` : ""
          const out =
            data.output && typeof data.output === "object" ? (data.output as { output?: unknown }).output : undefined
          text = [cmd, exit, typeof out === "string" ? out : ""].filter((t) => t.length > 0).join("\n")
        }
        messages.push({ id: entryId, role: "custom", data: { ...data, customType: r.type } })
        partsByMsg.set(entryId, text ? [{ type: "text", text }] : [])
      }
      // idle rows are metadata only; system/model/agent rows become events below
    }
  }

  const llm: NormalizedMessage[] = []
  const callPositions: number[] = []
  // compaction cutoffs: for each llm position, the index of the latest
  // compaction-summary message that replaced history before it (0 = none yet).
  // opencode compactions replace the message history with a summary, so the
  // reconstructed before-context drops everything before the summary message.
  const cutoffs: number[] = []
  const turns: Turn[] = []
  const assistantCalls: NormalizedMessage[] = []
  let current: Turn | null = null
  let turnIndex = 0

  const startTurn = (userMsg: NormalizedMessage | null, ts: number, entryStart: number): Turn => {
    const t: Turn = {
      index: turnIndex++,
      timestamp: ts,
      userMessage: userMsg,
      assistantCalls: [],
      toolResults: [],
      events: [],
      usage: zeroUsage(),
      model: null,
      thinkingLevel: null,
      entryStart,
      entryEnd: entryStart
    }
    turns.push(t)
    return t
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    const mTime = m.data.time as { created?: number } | undefined
    const ts = num(mTime?.created ?? 0)
    const parts = partsByMsg.get(m.id) ?? []

    if (m.role === "user") {
      const hasCompaction = parts.some((p) => p.type === "compaction")
      const textParts = parts.filter((p) => p.type === "text")
      const text = textParts
        .map((p) => (p as { text?: string }).text ?? "")
        .join("\n")
        .trim()
      const norm: NormalizedMessage = {
        role: hasCompaction ? "compactionSummary" : "user",
        timestamp: ts,
        blocks: hasCompaction ? [] : text ? [textBlock(text)] : [],
        summary: hasCompaction ? "auto-compaction" : undefined,
        entryIndex: i
      }
      llm.push(norm)
      current = startTurn(norm, ts, i)
      if (hasCompaction) {
        const lastCall = assistantCalls[assistantCalls.length - 1]
        const compPart = parts.find((p) => p.type === "compaction")
        current.events.push({
          kind: "compaction",
          timestamp: ts,
          detail: `compaction (${compPart?.reason ?? "auto"})`,
          summary: "auto-compaction",
          tokensBefore: lastCall ? (lastCall.usage?.input ?? 0) + (lastCall.usage?.cacheRead ?? 0) : 0,
          entryIndex: i
        })
      }
      continue
    }

    if (m.role === "custom") {
      // synthetic/shell entries (v2): pushed to the LLM but they don't
      // start a turn
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
        .trim()
      const customType = typeof m.data.customType === "string" ? m.data.customType : "custom"
      llm.push({
        role: "custom",
        timestamp: ts,
        blocks: text ? [textBlock(text)] : [],
        customType,
        entryIndex: i
      })
      continue
    }

    // assistant message == one LLM request
    const mTokens = (m.data.tokens ?? {}) as {
      total?: number
      input?: number
      output?: number
      reasoning?: number
      cache?: { write?: number; read?: number }
    }
    const usage: UsageTotals = {
      input: num(mTokens.input),
      output: num(mTokens.output),
      cacheRead: num(mTokens.cache?.read),
      cacheWrite: num(mTokens.cache?.write),
      total: num(mTokens.total) || num(mTokens.input) + num(mTokens.output) + num(mTokens.cache?.read)
    }
    const reasoningParts = parts.filter((p) => p.type === "reasoning")
    const textParts = parts.filter((p) => p.type === "text")
    const toolParts = parts.filter((p) => p.type === "tool")
    const patchParts = parts.filter((p) => p.type === "patch")

    const blocks: ContentBlockView[] = []
    for (const rp of reasoningParts) {
      const txt = (rp as { text?: string }).text
      if (txt) blocks.push({ kind: "thinking", text: txt })
    }
    const reply = textParts
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n")
      .trim()
    if (reply) blocks.push(textBlock(reply))
    const patchNote =
      patchParts.length > 0 ? `\n⛭ patch applied to ${patchParts.length} file${patchParts.length === 1 ? "" : "s"}` : ""
    if (patchNote.trim()) blocks.push(textBlock(patchNote.trim()))

    const modelId = typeof m.data.modelID === "string" ? m.data.modelID : undefined
    const provider = typeof m.data.providerID === "string" ? m.data.providerID : undefined
    const norm: NormalizedMessage = {
      role: "assistant",
      timestamp: ts,
      blocks,
      provider,
      model: modelId,
      usage,
      stopReason: typeof m.data.finish === "string" ? m.data.finish : undefined,
      entryIndex: i
    }
    llm.push(norm)
    callPositions.push(llm.length - 1)
    assistantCalls.push(norm)

    if (!current) current = startTurn(null, ts, i)
    current.assistantCalls.push(norm)
    current.entryEnd = i
    current.usage = {
      input: current.usage.input + usage.input,
      output: current.usage.output + usage.output,
      cacheRead: current.usage.cacheRead + usage.cacheRead,
      cacheWrite: current.usage.cacheWrite + usage.cacheWrite,
      total: current.usage.total + usage.total
    }
    current.model = modelId ?? current.model

    // tool calls + results become toolResult messages (they are in the next request's context)
    for (const tp of toolParts) {
      const toolName = tp.tool ?? "tool"
      const toolNorm: NormalizedMessage = {
        role: "toolResult",
        timestamp: ts,
        blocks: [{ kind: "tool_result", text: fullOutput(tp.state?.output) }],
        toolName,
        toolCallId: tp.callID,
        isError: tp.state?.status !== undefined && tp.state?.status !== "completed",
        entryIndex: i
      }
      llm.push(toolNorm)
      current.toolResults.push(toolNorm)
    }
  }

  // events (session_message: model/agent switches + persisted system notices)
  const events: SessionEventView[] = []
  let agentChanges = 0
  let modelChanges = 0
  for (const ev of smRows) {
    if (ev.type !== "model-switched" && ev.type !== "agent-switched" && ev.type !== "system") continue
    let data: Record<string, unknown>
    try {
      data = JSON.parse(ev.data) as Record<string, unknown>
    } catch {
      continue
    }
    const evData = data.time as { created?: number } | undefined
    const ts = num(evData?.created ?? 0)
    if (ev.type === "model-switched") {
      modelChanges += 1
      const model = parseModel(data.model)
      const detail = model ? `${model.providerID}/${model.id}`.replace(/^\//, model.id) : String(data.model ?? "")
      const e: SessionEventView = { kind: "model_change", timestamp: ts, detail: `model → ${detail}` }
      events.push(e)
      attachEvent(turns, ts, e)
    } else if (ev.type === "agent-switched") {
      agentChanges += 1
      const detail = typeof data.agent === "string" ? data.agent : String(data.previous ?? "")
      const e: SessionEventView = { kind: "custom", timestamp: ts, detail: `agent → ${detail}` }
      events.push(e)
      attachEvent(turns, ts, e)
    } else {
      // persisted system notice (e.g. the "instructions changed" diff)
      const text = typeof data.text === "string" ? data.text : ""
      if (!text) continue
      const metadata = data.metadata as { notice?: unknown } | undefined
      const notice = metadata && typeof metadata.notice === "string" ? `[${metadata.notice}] ` : ""
      const full = `${notice}${text}`
      const e: SessionEventView = {
        kind: "custom",
        timestamp: ts,
        detail: full.length > 200 ? `${full.slice(0, 200)}…` : full
      }
      events.push(e)
      attachEvent(turns, ts, e)
    }
  }

  // compaction-aware cutoff per llm position (recomputed once, after llm is built)
  const cutoffsFinal: number[] = []
  {
    let cutoff = 0
    for (let i = 0; i < llm.length; i++) {
      cutoffsFinal.push(cutoff)
      const role = llm[i]?.role
      if (role === "compactionSummary" || role === "branchSummary") cutoff = i
    }
  }

  // context points: one per assistant call, before-context = the llm messages
  // the request saw (after the last compaction, if any), up to but not incl. the call
  const contextPoints: ContextPoint[] = []
  for (let k = 0; k < assistantCalls.length; k++) {
    const call = assistantCalls[k]
    if (!call) continue
    const pos = callPositions[k] ?? 0
    const start = cutoffsFinal[pos] ?? 0
    contextPoints.push({
      requestIndex: k,
      turnIndex: turnIndexOf(turns, call),
      timestamp: call.timestamp,
      model: call.model ?? null,
      thinkingLevel: null,
      usage: call.usage ?? zeroUsage(),
      contextTokens: (call.usage?.input ?? 0) + (call.usage?.cacheRead ?? 0),
      contextMessages: llm.slice(start, pos)
    })
  }

  // context info: exact when the session persisted instruction evidence,
  // labeled two-block reconstruction otherwise (see ./context.ts)
  const cwd = typeof s.directory === "string" ? s.directory : meta.cwd
  const configDir = getConfigDir()
  const toolSet = new Set<string>()
  for (const m of assistantCalls) {
    for (const b of m.blocks) if (b.toolName) toolSet.add(b.toolName)
  }
  for (const t of turns) for (const tr of t.toolResults) if (tr.toolName) toolSet.add(tr.toolName)
  const contextInfo = buildOpencodeContextInfo({
    db: d,
    sessionID: meta.id,
    cwd,
    version: typeof s.version === "string" ? s.version : null,
    agent: typeof s.agent === "string" ? s.agent : null,
    model: parseModel(s.model),
    observedTools: [...toolSet].sort(),
    configDir,
    startedAt: num(s.time_created),
    agentChanges,
    modelChanges
  })

  const session: AgentSession = {
    meta,
    turns,
    events: turns.flatMap((t) => t.events),
    assistantCalls,
    contextInfo,
    contextPoints
  }
  return session
}

function attachEvent(turns: Turn[], ts: number, e: SessionEventView): void {
  // attach to the turn whose time range covers ts (fall back to the first turn)
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (!t) continue
    if (t.timestamp <= ts || i === 0) {
      t.events.push(e)
      return
    }
  }
}

function turnIndexOf(turns: Turn[], call: NormalizedMessage): number {
  for (const t of turns) {
    if (t.assistantCalls.includes(call)) return t.index
  }
  return 0
}
