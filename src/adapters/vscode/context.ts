/**
 * contextInfo reconstruction for the VS Code / Copilot Chat adapter.
 *
 * What VS Code persists about context (verified against session data):
 *  - NO literal system prompt. `promptTokenDetails` only gives a percentage
 *    breakdown (System Instructions / Tool Definitions / Messages / Files /
 *    Tool Results) — the prompt text itself is never written to disk.
 *  - Per-request injected context IS persisted in some requests:
 *      · `result.metadata.renderedGlobalContext` — <environment_info>,
 *        <workspace_info> tree, memory blocks (parts array, type 1 = text)
 *      · `result.metadata.renderedUserMessage` — <context>, <editorContext>,
 *        <reminderInstructions> prepended to the user turn
 *      · `variableData.variables` — the real context files:
 *        `promptFile` vars (AGENTS.md, .github/copilot-instructions.md…) by
 *        path, plus `vscode.prompt.instructions.text` (rendered
 *        prompt:instructionsList text, stored inline).
 *  - Agent/mode identity: `request.agent` {extensionId, id, name} — but the
 *    agent prompt text itself is NOT persisted, so it is never reconstructed
 *    from guesswork here.
 *
 * Everything is shown with provenance labels + honesty notes; instruction
 * file *content* is read from disk as of today (marked reconstructed —
 * files may have changed since the session ran).
 */
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ContextFile, SessionContextInfo } from "../types.ts"
import type { DbSessionRow } from "./store.ts"

export interface VscodeContextArgs {
  /** raw replayed requests (state.requests) */
  requests: Array<Record<string, unknown>>
  /** observed tool ids from toolInvocationSerialized parts */
  tools: string[]
  /** requests with persisted token usage / total requests */
  usageKnown: number
  /** malformed mutation-log lines/ops skipped during replay */
  malformedLines: number
  /** enrichment row from session-store.db, when present */
  dbRow: DbSessionRow | null
  /** true when the transcript came from session-store.db (no jsonl) */
  fromDb: boolean
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asArr(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null
}

/** result.metadata / result.usage accessor. */
function resultOf(req: Record<string, unknown>): Record<string, unknown> {
  return asObj(req.result) ?? {}
}

function metadataOf(req: Record<string, unknown>): Record<string, unknown> {
  return asObj(resultOf(req).metadata) ?? {}
}

/** Join markdown-ish parts `[{type:1,text},…]` (or a plain string) to text. */
function partsText(v: unknown): string {
  const s = str(v)
  if (s) return s
  const arr = asArr(v)
  if (!arr) return ""
  return arr
    .map((p) => {
      const o = asObj(p)
      return o && o.type === 1 ? str(o.text) : ""
    })
    .filter((t) => t.length > 0)
    .join("\n")
}

/** First defined value of `keys` among metadata X, usage Y, top-level Z (one request). */
function firstTextOf(req: Record<string, unknown>, keys: string[]): string {
  const sources = [metadataOf(req), asObj(resultOf(req).usage) ?? {}, req]
  for (const src of sources) {
    for (const k of keys) {
      const t = partsText(src[k])
      if (t) return t
    }
  }
  return ""
}

/** First non-empty value of `keys` across requests, in request order. */
function firstTextAcross(requests: Array<Record<string, unknown>>, keys: string[]): string {
  for (const req of requests) {
    const t = firstTextOf(req, keys)
    if (t) return t
  }
  return ""
}

interface PromptFileVar {
  path: string
  name: string
}

/** Collect promptFile / instructions variables (deduped by path). */
function collectPromptFiles(requests: Array<Record<string, unknown>>): PromptFileVar[] {
  const out: PromptFileVar[] = []
  const seen = new Set<string>()
  for (const req of requests) {
    const vd = asObj(req.variableData)
    const vars = asArr(vd?.variables) ?? []
    for (const raw of vars) {
      const v = asObj(raw)
      if (!v) continue
      const id = str(v.id)
      const kind = str(v.kind)
      const isPromptFile =
        kind === "promptFile" ||
        id.startsWith("vscode.prompt.instructions.root__") ||
        id.startsWith("vscode.instructions.file.root__")
      if (!isPromptFile) continue
      const val = asObj(v.value)
      let path = str(val?.path)
      if (!path) {
        const ext = str(val?.external)
        if (ext.startsWith("file://")) {
          try {
            path = fileURLToPath(ext)
          } catch {
            path = ""
          }
        }
      }
      if (!path || seen.has(path)) continue
      seen.add(path)
      out.push({ path, name: str(v.name) || id })
    }
  }
  return out
}

/** Strip the trailing <userRequest> block (already shown as the turn prompt). */
function elideUserRequest(text: string): string {
  const idx = text.indexOf("<userRequest>")
  if (idx <= 0) return text
  return `${text.slice(0, idx).trimEnd()}\n… (<userRequest> elided — shown as the turn's user message)`
}

/** Rendered prompt:instructionsList text (persisted inline in variableData). */
function instructionsListText(requests: Array<Record<string, unknown>>): string {
  for (const req of requests) {
    const vd = asObj(req.variableData)
    const vars = asArr(vd?.variables) ?? []
    for (const raw of vars) {
      const v = asObj(raw)
      if (v && str(v.id) === "vscode.prompt.instructions.text") {
        const t = str(v.value)
        if (t) return t
      }
    }
  }
  return ""
}

/** First promptTokenDetails breakdown, rendered as one labeled line. */
function tokenBreakdown(requests: Array<Record<string, unknown>>): string {
  for (const req of requests) {
    const sources = [asObj(resultOf(req).usage) ?? {}, req]
    for (const src of sources) {
      const details = asArr(src.promptTokenDetails)
      if (!details || details.length === 0) continue
      const parts = details
        .map((d) => {
          const o = asObj(d)
          if (!o) return ""
          const label = str(o.label)
          const pct = typeof o.percentageOfPrompt === "number" ? o.percentageOfPrompt : null
          return label && pct !== null ? `${label} ${pct}%` : ""
        })
        .filter((p) => p.length > 0)
      if (parts.length > 0) return parts.join(" · ")
    }
  }
  return ""
}

export function buildVscodeContextInfo(a: VscodeContextArgs): SessionContextInfo {
  const notes: string[] = []

  // ---- context files: prompt instruction files referenced at capture time,
  // content read from disk today (reconstructed — may differ from session).
  const promptFiles = collectPromptFiles(a.requests)
  const contextFiles: ContextFile[] = []
  const missing: string[] = []
  for (const f of promptFiles) {
    let content = ""
    try {
      if (existsSync(f.path)) content = readFileSync(f.path, "utf8")
      else missing.push(f.path)
    } catch {
      missing.push(f.path)
    }
    contextFiles.push({ path: f.path, content })
  }
  if (contextFiles.length > 0) {
    notes.push(
      `context files read from disk as of today (may differ from session date): ${contextFiles.length} file(s)`
    )
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).map((p) => p.split("/").slice(-1)[0] ?? p)
    notes.push(
      `${missing.length} instruction file(s) referenced at capture time are no longer on disk: ${shown.join(", ")}${
        missing.length > 3 ? ", …" : ""
      }`
    )
  }

  // ---- system prompt: no literal prompt persisted → labeled fragments only.
  const fragments: string[] = []
  const globalCtx = firstTextAcross(a.requests, ["renderedGlobalContext"])
  if (globalCtx) {
    fragments.push(`## renderedGlobalContext — persisted per-request context (verbatim)\n${globalCtx}`)
  }
  const userCtx = firstTextAcross(a.requests, ["renderedUserMessage"])
  if (userCtx) {
    fragments.push(
      `## renderedUserMessage — persisted context prepended to the user turn (verbatim)\n${elideUserRequest(userCtx)}`
    )
  }
  const instr = instructionsListText(a.requests)
  if (instr) {
    fragments.push(`## prompt:instructionsList — persisted instruction text (verbatim)\n${instr}`)
  }
  const breakdown = tokenBreakdown(a.requests)
  if (breakdown) {
    fragments.push(`## prompt token breakdown (promptTokenDetails, percentages only — no prompt text)\n${breakdown}`)
  }

  const agent = asObj(a.requests[a.requests.length - 1]?.agent)
  const agentLabel = [str(agent?.extensionId), str(agent?.id)].filter((s) => s.length > 0).join(" / ")

  notes.unshift(
    "VS Code does not persist the system prompt or agent prompt text — sections below are labeled persisted per-request fragments (renderedGlobalContext / renderedUserMessage / instructions), not a literal system prompt"
  )
  if (a.usageKnown < a.requests.length) {
    notes.push(
      `token usage persisted for ${a.usageKnown}/${a.requests.length} requests (result.metadata.promptTokens) — context points exist only for those`
    )
  }
  notes.push(
    "tool results and the full per-request message list are not persisted; context points show conversation messages only"
  )
  if (agentLabel) notes.push(`session agent: ${agentLabel} (prompt text not persisted)`)
  if (a.fromDb) notes.push("transcript loaded from session-store.db (no chatSessions mutation log on disk)")
  if (a.dbRow) {
    const bits = [
      a.dbRow.branch ? `branch ${a.dbRow.branch}` : "",
      a.dbRow.repository ? `repo ${a.dbRow.repository}` : ""
    ].filter((s) => s.length > 0)
    if (bits.length > 0) notes.push(`enriched from session-store.db: ${bits.join(" · ")}`)
  }
  if (a.malformedLines > 0) notes.push(`replay skipped ${a.malformedLines} malformed mutation-log line/op(s)`)
  if (fragments.length === 0) notes.push("no persisted context fragments found in this session")

  let systemPrompt = ""
  if (fragments.length > 0) {
    systemPrompt = [
      "[assembled from persisted per-request evidence — VS Code stores no literal system prompt]",
      "",
      ...fragments.flatMap((f) => [f, ""])
    ].join("\n")
  }

  return {
    systemPrompt,
    contextFiles,
    skills: [],
    tools: [...new Set(a.tools)].sort(),
    reconstructed: true,
    notes
  }
}
