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
 *  - `session_message` holds model-switched / agent-switched events.
 *
 * opencode does NOT persist the system prompt — like Pi it's built at runtime
 * from global AGENTS.md + cwd-walk AGENTS.md/CLAUDE.md, so we reconstruct it
 * with an honest note (files as of today).
 */
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import type {
  AgentSession,
  ContentBlockView,
  ContextPoint,
  ContextFile,
  NormalizedMessage,
  SessionContextInfo,
  SessionEventView,
  SessionMeta,
  Turn,
  UsageTotals
} from "../types.ts"
import { loadProjectContextFiles } from "../../vendor/pi/context-files.ts"
import { SearchFileBuilder } from "../../engine/transcript-lines.ts"
import { metaCacheKey, isFresh as cacheIsFresh, type MetaCache } from "../../engine/meta-cache.ts"

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
  const rows = d
    .query(
      `SELECT id, slug, directory, title, model, agent, cost,
              tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
              time_created, time_updated, time_compacting, time_archived,
              summary_additions, summary_deletions, summary_files
       FROM session`
    )
    .all() as Array<Record<string, unknown>>

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
    const fewMisses = missedIds.length <= 64
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
      for (const id of missedIds) {
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
        `WHERE ${col} IN (${missedIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
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
      for (const r of d.query(`SELECT id, directory, title FROM session`).all() as Array<{
        id: string
        directory?: unknown
        title?: unknown
      }>) {
        sessionInfo.set(r.id, {
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
        for (const id of missedIds) {
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
        const missList = missedIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")
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

function readSkills(configDir: string): Array<{ name: string; description: string; filePath: string }> {
  const dir = join(configDir, "skills")
  const out: Array<{ name: string; description: string; filePath: string }> = []
  if (!existsSync(dir)) return out
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const skillDir = join(dir, e)
    let skillDirStat = skillDir
    try {
      // follow symlinks (e.g. browser-control -> ~/.agents/skills/browser-control)
      if (existsSync(skillDir) && statSync(skillDir).isSymbolicLink()) {
        skillDirStat = realpathSync(skillDir)
      }
    } catch {
      /* keep */
    }
    const md = join(skillDirStat, "SKILL.md")
    if (!existsSync(md)) continue
    try {
      const content = readFileSync(md, "utf8")
      const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? e
      const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ""
      out.push({ name, description, filePath: md })
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

const DEFAULT_TOOLS = ["bash", "read", "write", "edit", "grep", "glob", "list"]

function buildSystemPrompt(
  cwd: string,
  configDir: string,
  contextFiles: ContextFile[],
  skills: Array<{ name: string; description: string }>,
  tools: string[]
): string {
  const lines: string[] = [
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  opencode system prompt — reconstructed at view time            ║",
    "║  opencode does NOT persist the system prompt in its database.   ║",
    "║  This is a best-effort reconstruction from available session    ║",
    "║  data: inferred tools, current skills, and AGENTS.md/CLAUDE.md  ║",
    "║  as they exist on disk today (may differ from session time).    ║",
    "╚══════════════════════════════════════════════════════════════════╝",
    "",
    "---",
    "",
    `Working directory: ${cwd}`,
    "",
    "---",
    "",
    "## Tools",
    ""
  ]
  for (const t of tools) {
    lines.push(`- ${t}`)
  }
  if (skills.length > 0) {
    lines.push("", "---", "", "## Skills", "")
    for (const s of skills) {
      lines.push(`- **${s.name}** — ${s.description || "(no description)"}`)
    }
  }
  if (contextFiles.length > 0) {
    lines.push("", "---", "", "## Context files (AGENTS.md / CLAUDE.md)", "")
    for (const f of contextFiles) {
      lines.push(`### ${f.path}`)
      lines.push("")
      lines.push(f.content)
      lines.push("")
    }
  }
  return lines.join("\n")
}

/** Full load of one opencode session (messages + parts + events). */
export function loadSession(meta: SessionMeta): AgentSession {
  const d = openDb()
  const s = d.query(`SELECT * FROM session WHERE id = ?`).get(meta.id) as Record<string, unknown> | null
  if (!s) throw new Error(`opencode session not found: ${meta.id}`)

  const msgRows = d
    .query(`SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created`)
    .all(meta.id) as Array<{ id: string; data: string }>
  const partRows = d
    .query(`SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created`)
    .all(meta.id) as Array<{ message_id: string; data: string }>
  const evtRows = d
    .query(`SELECT type, data FROM session_message WHERE session_id = ? ORDER BY time_created`)
    .all(meta.id) as Array<{ type: string; data: string }>

  interface OcMsg {
    id: string
    role: "user" | "assistant"
    data: Record<string, unknown>
  }
  const messages: OcMsg[] = []
  for (const r of msgRows) {
    try {
      const data = JSON.parse(r.data) as Record<string, unknown>
      messages.push({ id: r.id, role: data.role === "user" ? "user" : "assistant", data })
    } catch {
      /* skip malformed */
    }
  }
  const partsByMsg = new Map<string, OcToolPart[]>()
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
        current.events.push({
          kind: "compaction",
          timestamp: ts,
          detail: `compaction (auto)`,
          summary: "auto-compaction",
          tokensBefore: lastCall ? (lastCall.usage?.input ?? 0) + (lastCall.usage?.cacheRead ?? 0) : 0,
          entryIndex: i
        })
      }
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

  // events
  const events: SessionEventView[] = []
  for (const ev of evtRows) {
    let data: Record<string, unknown> = {}
    try {
      data = JSON.parse(ev.data) as Record<string, unknown>
    } catch {
      /* skip */
    }
    const model = parseModel(data.model)
    const detail = model ? `${model.providerID}/${model.id}`.replace(/^\//, model.id) : String(data.model ?? "")
    const evData = data.time as { created?: number } | undefined
    const ts = num(evData?.created ?? 0)
    if (ev.type === "model-switched") {
      const e: SessionEventView = { kind: "model_change", timestamp: ts, detail: `model → ${detail}` }
      events.push(e)
      attachEvent(turns, ts, e)
    } else if (ev.type === "agent-switched") {
      const e: SessionEventView = { kind: "custom", timestamp: ts, detail: `agent → ${detail}` }
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

  // context info (reconstructed)
  const cwd = typeof s.directory === "string" ? s.directory : meta.cwd
  const configDir = getConfigDir()
  const contextFiles = loadProjectContextFiles({ cwd, agentDir: configDir }).map((f) => ({
    ...f,
    global: f.path === join(configDir, "AGENTS.md") || f.path === join(configDir, "AGENTS.MD")
  }))
  const skills = readSkills(configDir)
  const toolSet = new Set<string>()
  for (const m of assistantCalls) {
    for (const b of m.blocks) if (b.toolName) toolSet.add(b.toolName)
  }
  for (const t of turns) for (const tr of t.toolResults) if (tr.toolName) toolSet.add(tr.toolName)
  const tools = toolSet.size > 0 ? [...toolSet].sort() : DEFAULT_TOOLS
  const notes = [
    "system prompt not persisted by opencode — reconstructed at view time",
    "context files are AGENTS.md/CLAUDE.md as they exist today (may differ from what was loaded during the session)"
  ]
  const contextInfo: SessionContextInfo = {
    systemPrompt: buildSystemPrompt(cwd, configDir, contextFiles, skills, tools),
    contextFiles,
    skills,
    tools,
    reconstructed: true,
    notes
  }

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
