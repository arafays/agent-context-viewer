/**
 * opencode system-prompt reconstruction from local evidence.
 *
 * How opencode actually assembles a prompt (verified against the installed
 * opencode v2.0.16 binary and the source checkout at
 * ~/.local/share/opencode/repos/github.com/anomalyco/opencode@v2):
 *
 *  - `packages/core/src/session/model-request.ts` (`baseTranscript`, ~L83-95)
 *    sends TWO system blocks, in this order:
 *      1. `agent.system ?? SessionSystemPrompt.make(toolNames)` — the agent's own
 *         system prompt (built-in hardcoded text, or the body of an agent .md
 *         file with frontmatter stripped), else the 756-byte base prompt with
 *         `${OPENCODE_TOOL_GUIDANCE}` substituted
 *         (`session/system-prompt.ts:9-28`, fixed push order shell → write → edit).
 *         Model-family plugins (`plugin/optimize.ts`) then override or append
 *         their asset onto block 1 — skipped when the agent defines its own
 *         system. Each template that contains the placeholder gets the same
 *         tool-guidance substitution.
 *      2. `InstructionState.initial(...)` — the epoch baseline stored in
 *         `instruction_state.initial_values` (key → blob hash), rendered through
 *         `Instructions.renderInitial` (`instructions/index.ts:161-169`) with the
 *         sources built by `SessionContext.select` (`session/context.ts:144-152`):
 *           builtins(core/environment, core/date) → core/codemode →
 *           core/instructions → core/skill-guidance → core/reference-guidance →
 *           core/mcp-guidance → api/* entries (key-ascending).
 *         Source parts join with "\n\n"; blob values are raw JSON text
 *         (`instruction_blob.value`), so the render is byte-exact.
 *
 * This module therefore has two modes:
 *   - EXACT (an `instruction_state` row exists): block 2 is rendered from the
 *     stored blobs, block 1 from embedded byte-verified assets
 *     (prompt-assets.ts) with the tool set approximated.
 *   - RECONSTRUCTED (no row — opencode ≤ 1.x never persisted instructions):
 *     same two-block shape, block 1 is today's base prompt/reference asset and
 *     block 2 renders today's files/skills with the same renderers opencode
 *     uses, plus a date line and a metadata-derived environment block.
 *
 * Every assumption is spelled out in `notes`.
 */
import type { Database } from "bun:sqlite"
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { loadProjectContextFiles } from "../../vendor/pi/context-files.ts"
import type { ContextFile, SessionContextInfo } from "../types.ts"
import {
  AGENT_SYSTEM_EXPLORE,
  AGENT_SYSTEM_SUMMARY,
  AGENT_SYSTEM_TITLE,
  BASE_PROMPT,
  BUILTIN_SKILLS,
  MODEL_PROMPTS
} from "./prompt-assets.ts"

/** opencode release whose prompt assets are embedded (see prompt-assets.ts). */
const ASSET_VERSION = "2.0.16"

/** Tools a stock opencode v2 snapshot advertises (packages/core/src/tool/plugin/*.ts). */
export const DEFAULT_TOOLS = [
  "shell",
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "patch",
  "question",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "execute",
  "search"
]

// ---------------------------------------------------------------------------
// tool guidance (packages/core/src/session/system-prompt.ts:9-28)
// ---------------------------------------------------------------------------

/**
 * Byte-verbatim guidance lines. opencode pushes them in a fixed order
 * (shell first, then write, then edit) regardless of the tool array order, and
 * substitutes them into the single `${OPENCODE_TOOL_GUIDANCE}` placeholder.
 */
const TOOL_GUIDANCE: Array<[string, string[]]> = [
  [
    "shell",
    [
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse."
    ]
  ],
  [
    "write",
    [
      "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes."
    ]
  ],
  [
    "edit",
    [
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence."
    ]
  ]
]

/** `SessionSystemPrompt.render(prompt, tools)` — placeholder replaced once, first match. */
function renderToolGuidance(template: string, tools: ReadonlySet<string>): string {
  const lines: string[] = []
  for (const [tool, guidance] of TOOL_GUIDANCE) {
    if (tools.has(tool)) lines.push(...guidance)
  }
  return template.replace("${OPENCODE_TOOL_GUIDANCE}", lines.join("\n"))
}

function guidanceToolsInEffect(tools: ReadonlySet<string>): string[] {
  return TOOL_GUIDANCE.flatMap(([tool]) => (tools.has(tool) ? [tool] : []))
}

const OPENCODE_PLACEHOLDER = "`${OPENCODE_TOOL_GUIDANCE}`"

// ---------------------------------------------------------------------------
// instruction_state evidence (exact block 2)
// ---------------------------------------------------------------------------

export interface InstructionEvidence {
  /** instruction key → raw JSON text of the blob `initial_values` points at */
  values: Record<string, string>
  /** blob hashes whose row is missing (should not happen) */
  missing: string[]
  epochStart: number
  throughSeq: number
  /** `initial_values !== current_values` — deltas landed after the baseline */
  drifted: boolean
  /** a compaction ends at `epoch_start` → the baseline was re-snapshotted there */
  rebasedAtCompaction: boolean
}

/** Read `instruction_state` + `instruction_blob` for one session (null = no evidence). */
export function loadInstructionState(db: Database, sessionID: string): InstructionEvidence | null {
  const state = db
    .query(
      `SELECT epoch_start, through_seq, initial_values, current_values
       FROM instruction_state WHERE session_id = ?`
    )
    .get(sessionID) as {
    epoch_start: number
    through_seq: number
    initial_values: string
    current_values: string
  } | null
  if (!state) return null
  let initial: Record<string, unknown>
  try {
    initial = JSON.parse(state.initial_values) as Record<string, unknown>
  } catch {
    return null
  }

  const hashes = [...new Set(Object.values(initial).filter((h): h is string => typeof h === "string"))]
  const blobs = new Map<string, string>()
  // opencode batches blob loads at 500 hashes; mirror that.
  for (let i = 0; i < hashes.length; i += 500) {
    const batch = hashes.slice(i, i + 500)
    const rows = db
      .query(`SELECT hash, value FROM instruction_blob WHERE hash IN (${batch.map(() => "?").join(",")})`)
      .all(...batch) as Array<{ hash: string; value: string }>
    for (const r of rows) blobs.set(r.hash, r.value)
  }

  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const [key, hash] of Object.entries(initial)) {
    if (typeof hash !== "string") continue
    const value = blobs.get(hash)
    if (value === undefined) missing.push(key)
    else values[key] = value
  }

  const epochStart = Number(state.epoch_start) || 0
  const rebasedAtCompaction =
    epochStart > 0 &&
    db
      .query(`SELECT 1 FROM session_message WHERE session_id = ? AND type = 'compaction' AND seq = ?`)
      .get(sessionID, epochStart) !== null

  return {
    values,
    missing,
    epochStart,
    throughSeq: Number(state.through_seq) || 0,
    drifted: state.initial_values !== state.current_values,
    rebasedAtCompaction
  }
}

// ---------------------------------------------------------------------------
// instruction renderers — byte-exact copies of the opencode source renderers
// ---------------------------------------------------------------------------

/** Fixed source order (`session/context.ts:144-152`); absent keys are skipped. */
const INSTRUCTION_ORDER = [
  "core/environment",
  "core/date",
  "core/codemode",
  "core/instructions",
  "core/skill-guidance",
  "core/reference-guidance",
  "core/mcp-guidance"
] as const

/** `search({ ... })` signature embedded in the code-mode prompt (ground truth: a persisted `instructions` notice). */
const SEARCH_SIGNATURE = `search({
  query?: string,
  namespace?: string,
  /** @integer @exclusiveMinimum 0 */
  limit?: number,
  /** @integer @minimum 0 */
  offset?: number,
}): {
  items: Array<{
      path: string,
      description: string,
      signature: string,
    }>,
  /** @integer @minimum 0 */
  remaining: number,
  next: {
      /** @integer @minimum 0 */
      offset: number,
    } | null,
}`

/** Blob values are JSON-encoded (env/date serialize as JSON strings). */
function decodeInstructionString(value: string): string | null {
  if (!value.startsWith('"')) return value
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === "string" ? parsed : null
  } catch {
    return null
  }
}

/** builtins.ts — environment value is wrapped with a header line. */
function renderEnvironment(value: string): string | null {
  const raw = decodeInstructionString(value)
  if (raw === null || !raw.startsWith("<env>")) return null
  return ["Here is some useful information about the environment you are running in:", raw].join("\n")
}

function renderDate(value: string): string | null {
  const raw = decodeInstructionString(value)
  return raw && raw.length > 0 ? `Today's date: ${raw}` : null
}

/** instruction-discovery.ts:124 */
function renderInstructionFiles(raw: string): string | null {
  const files = parseInstructionFiles(raw)
  if (files === null) return null
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}

interface SkillSummary {
  id: string
  name: string
  description: string
}

/** skill/instructions.ts render() */
function renderSkillsValue(skills: SkillSummary[]): string {
  const entries = skills.flatMap((skill) => [
    "  <skill>",
    `    <id>${skill.id}</id>`,
    `    <name>${skill.name}</name>`,
    `    <description>${skill.description}</description>`,
    "  </skill>"
  ])
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
    ...(skills.length === 0
      ? ["No skills are currently available."]
      : ["<available_skills>", ...entries, "</available_skills>"])
  ].join("\n")
}

function renderSkills(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const skills: SkillSummary[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null
    const { id, name, description } = item as { id?: unknown; name?: unknown; description?: unknown }
    if (typeof name !== "string" || typeof description !== "string") return null
    skills.push({ id: typeof id === "string" ? id : name, name, description })
  }
  return renderSkillsValue(skills)
}

interface ReferenceSummary {
  name: string
  path: string
  description?: string
}

/** reference/instructions.ts render() */
function renderReferencesValue(references: ReferenceSummary[]): string {
  const entries = references.flatMap((reference) => [
    "  <reference>",
    `    <name>${reference.name}</name>`,
    `    <path>${reference.path}</path>`,
    ...(reference.description === undefined ? [] : [`    <description>${reference.description}</description>`]),
    "  </reference>"
  ])
  return [
    "Project references provide additional directories that can be accessed when relevant.",
    "<available_references>",
    ...entries,
    "</available_references>"
  ].join("\n")
}

function renderReferences(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const references: ReferenceSummary[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null
    const { name, path, description } = item as { name?: unknown; path?: unknown; description?: unknown }
    if (typeof name !== "string" || typeof path !== "string") return null
    references.push({
      name,
      path,
      ...(typeof description === "string" ? { description } : {})
    })
  }
  return renderReferencesValue(references)
}

/** tool/mcp.ts:16 — server → codemode namespace */
const mcpNamespace = (server: string): string => server.replace(/[^a-zA-Z0-9_-]/g, "_")

/** mcp/instructions.ts render() */
function renderMcp(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const lines: string[] = ["<mcp_instructions>"]
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null
    const { server, instructions, codemode } = item as {
      server?: unknown
      instructions?: unknown
      codemode?: unknown
    }
    if (typeof server !== "string" || typeof instructions !== "string") return null
    lines.push(`  <server name="${server}">`)
    if (codemode !== false) {
      lines.push(
        `    Use tools from this server through \`execute\` under \`tools[${JSON.stringify(mcpNamespace(server))}]\`.`
      )
    }
    lines.push(...instructions.split("\n").map((line) => `    ${line}`), "  </server>")
  }
  lines.push("</mcp_instructions>")
  return lines.join("\n")
}

/** codemode/instructions.ts render() — catalog is the stored `Summary` shape. */
function renderCodeMode(raw: string): string | null {
  let catalog: {
    total?: unknown
    shown?: unknown
    namespaces?: unknown
  }
  try {
    catalog = JSON.parse(raw) as typeof catalog
  } catch {
    return null
  }
  const total = catalog.total
  const shown = catalog.shown
  const namespaces = catalog.namespaces
  if (typeof total !== "number" || typeof shown !== "number" || !Array.isArray(namespaces)) return null
  if (total === 0) {
    return "No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools. Do not call `execute` unless there is at least one available Code Mode tool."
  }

  const hasMoreTools = shown < total
  const header = `# Code Mode

Use the \`execute\` tool to call the tools listed below. They cannot be called directly${
    hasMoreTools ? ", and neither can \`search\`. Both" : ". They"
  } only work inside code you pass to \`execute\`.

${
  hasMoreTools
    ? // v2.0.16 binary bytes + persisted `instructions` notice: the sentence below was
      // dropped in the post-v2.0.16 source checkout, so the binary is the ground truth.
      `The catalog is partial. Inside \`execute\`, use \`search(...)\` to find a tool, then call it by the \`path\` in the result. \`search\` is synchronous. Call it without \`await\`; it does not return a Promise. Do not guess tool names.

- ${SEARCH_SIGNATURE}`
    : "The catalog is complete. Do not guess tool names."
}

## Available tools`

  const listing: string[] = []
  for (const namespace of namespaces) {
    if (typeof namespace !== "object" || namespace === null) return null
    const ns = namespace as {
      name?: unknown
      description?: unknown
      count?: unknown
      entries?: unknown
    }
    if (typeof ns.name !== "string" || typeof ns.count !== "number" || !Array.isArray(ns.entries)) return null
    const countLabel = ns.count === 1 ? "1 tool" : `${ns.count} tools`
    const label =
      ns.entries.length === ns.count
        ? countLabel
        : ns.entries.length === 0
          ? `${countLabel}, none shown`
          : `${countLabel}, ${ns.entries.length} shown`
    const description = typeof ns.description === "string" ? ns.description : undefined
    listing.push(`- ${ns.name} (${label})${description === undefined ? "" : ` // ${description}`}`)
    for (const entry of ns.entries) {
      if (typeof entry !== "object" || entry === null) return null
      const { line } = entry as { line?: unknown }
      if (typeof line !== "string") return null
      listing.push(line)
    }
  }
  return `${header}\n\n${listing.join("\n")}`
}

/** instruction-entry.ts renderBlock() — `api/<key>` entries, rendered last. */
function renderContextEntry(key: string, raw: string): string | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  if (text === undefined) return null
  return [`<context key="${key}">`, text, "</context>"].join("\n")
}

function renderInstructionKey(key: string, raw: string): string | null {
  switch (key) {
    case "core/environment":
      return renderEnvironment(raw)
    case "core/date":
      return renderDate(raw)
    case "core/codemode":
      return renderCodeMode(raw)
    case "core/instructions":
      return renderInstructionFiles(raw)
    case "core/skill-guidance":
      return renderSkills(raw)
    case "core/reference-guidance":
      return renderReferences(raw)
    case "core/mcp-guidance":
      return renderMcp(raw)
    default:
      return key.startsWith("api/") ? renderContextEntry(key.slice("api/".length), raw) : null
  }
}

/**
 * `Instructions.renderInitial`: source order first, then key-ascending `api/*`
 * entries; unknown stored keys are reported (opencode only renders keys it has
 * a source for, so they never reached the model either).
 */
function renderInitialBlock(evidence: InstructionEvidence, notes: string[]): string {
  const order = new Set<string>(INSTRUCTION_ORDER)
  const keys = [
    ...INSTRUCTION_ORDER.filter((key) => evidence.values[key] !== undefined),
    ...Object.keys(evidence.values)
      .filter((key) => key.startsWith("api/") && !order.has(key))
      .sort()
  ]
  const parts: string[] = []
  for (const key of keys) {
    const raw = evidence.values[key]
    if (raw === undefined) continue
    const text = renderInstructionKey(key, raw)
    if (text === null) {
      notes.push(`instruction "${key}": stored blob did not render (unexpected shape) — skipped`)
      continue
    }
    if (text.length === 0) {
      notes.push(`instruction "${key}": rendered empty text — skipped (opencode rejects empty renders)`)
      continue
    }
    parts.push(text)
  }
  const unknown = Object.keys(evidence.values).filter((key) => !order.has(key) && !key.startsWith("api/"))
  if (unknown.length > 0) {
    notes.push(
      `stored instruction key(s) with no renderer in this reconstruction: ${unknown.join(", ")} (opencode renders a key only when it builds a source for it)`
    )
  }
  if (evidence.missing.length > 0) {
    notes.push(`instruction blob(s) missing for: ${evidence.missing.join(", ")} — skipped`)
  }
  return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// block 1: agent system / base prompt / model-family asset
// ---------------------------------------------------------------------------

interface ModelAsset {
  key: keyof typeof MODEL_PROMPTS
  mode: "override" | "append"
}

/** `plugin/optimize.ts` matchers, in plugin order. */
function modelAssetFor(modelID: string): ModelAsset | null {
  const id = modelID.toLowerCase()
  if (id.includes("gpt")) return { key: id.includes("gpt-6") ? "gptAstra" : "gpt", mode: "override" }
  if (id.includes("claude")) return { key: "anthropic", mode: "append" }
  if (id.includes("kimi")) return { key: "kimi", mode: "override" }
  if (id.includes("trinity")) return { key: "trinity", mode: "override" }
  if (id.includes("muse")) return { key: "meta", mode: "override" }
  return null
}

/** models.dev catalog from the `kv` table (MetaPlugin substitutes `{{MODEL_NAME}}`). */
let modelCatalog: Record<string, { models?: Record<string, { name?: unknown }> }> | null = null

function loadModelName(db: Database, providerID: string, id: string): string {
  if (modelCatalog === null) {
    try {
      const row = db.query(`SELECT value FROM kv WHERE key = 'models-dev:catalog'`).get() as { value: string } | null
      if (row) {
        const parsed = JSON.parse(row.value) as { body?: unknown }
        const body = typeof parsed.body === "string" ? (JSON.parse(parsed.body) as unknown) : parsed.body
        modelCatalog = (body ?? {}) as Record<string, { models?: Record<string, { name?: unknown }> }>
      }
    } catch {
      modelCatalog = {}
    }
  }
  const name = modelCatalog?.[providerID]?.models?.[id]?.name
  // `Model.Info.default` falls back to the id itself (packages/schema/src/model.ts).
  return typeof name === "string" && name.length > 0 ? name : id
}

/** Built-in agents with a hardcoded system prompt (`plugin/agent.ts`). */
const BUILTIN_AGENT_SYSTEM: Record<string, { text: string; source: string }> = {
  explore: { text: AGENT_SYSTEM_EXPLORE, source: "opencode built-in (plugin/agent.ts PROMPT_EXPLORE)" },
  title: { text: AGENT_SYSTEM_TITLE, source: "opencode built-in (plugin/agent.ts PROMPT_TITLE)" },
  summary: { text: AGENT_SYSTEM_SUMMARY, source: "opencode built-in (plugin/agent.ts PROMPT_SUMMARY)" }
}

/** Built-ins verified to define no `system` (plugin/agent.ts, plugin/plan.ts). */
const BUILTIN_NO_SYSTEM = new Set(["build", "general", "plan", "compaction"])

const AGENT_SOURCE_DIRS = ["agent", "agents", "mode", "modes"]

/** Config roots opencode scans for agent .md files (config/discovery.ts). */
function agentRoots(configDir: string, cwd: string): string[] {
  const home = homedir()
  const roots = [configDir, join(home, ".claude"), join(home, ".agents")]
  let dir = cwd
  for (let i = 0; i < 8 && dir && dir !== dirname(dir); i++) {
    roots.push(dir, join(dir, ".opencode"), join(dir, ".claude"), join(dir, ".agents"))
    dir = dirname(dir)
  }
  return [...new Set(roots)]
}

/** gray-matter body: everything after the closing `---` of the frontmatter. */
function markdownBody(content: string): string {
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/)
  return (frontmatter ? content.slice(frontmatter[0].length) : content).trim()
}

/** `config/plugin/agent.ts decode()` — name strips the source dir prefix and `.md`. */
function findAgentFile(agentId: string, configDir: string, cwd: string): string | null {
  for (const root of agentRoots(configDir, cwd)) {
    for (const sourceDir of AGENT_SOURCE_DIRS) {
      const dir = join(root, sourceDir)
      if (!existsSync(dir)) continue
      for (const file of walkMarkdown(dir, 4)) {
        const name = file
          .slice(root.length + 1)
          .replaceAll("\\", "/")
          .replace(/^(agent|agents|mode|modes)\//, "")
          .replace(/\.md$/, "")
        if (name === agentId || name.toLowerCase() === agentId.toLowerCase()) return file
      }
    }
  }
  return null
}

function walkMarkdown(root: string, maxDepth: number): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue
      const full = join(dir, entry)
      let isDir = false
      let isFile = false
      try {
        const stat = statSync(full)
        isDir = stat.isDirectory()
        isFile = stat.isFile()
      } catch {
        continue
      }
      if (isDir) walk(full, depth + 1)
      else if (isFile && entry.endsWith(".md")) out.push(full)
    }
  }
  walk(root, 0)
  return out
}

interface BlockOne {
  text: string
  notes: string[]
}

function buildBlockOne(input: OpencodeContextInput, guidanceTools: ReadonlySet<string>): BlockOne {
  const notes: string[] = []
  const agentId = input.agent ?? "build"
  const builtin = BUILTIN_AGENT_SYSTEM[agentId]
  if (builtin) {
    notes.push(
      `block 1: agent "${agentId}" system prompt — ${builtin.text.length} chars, ${builtin.source}; sent verbatim (opencode skips tool guidance and model-family plugins for agents with their own system)`
    )
    if (input.agentChanges > 0) {
      notes.push(
        `the agent changed ${input.agentChanges} time(s) mid-session — block 1 shows the session's final agent`
      )
    }
    return { text: builtin.text, notes }
  }

  if (!BUILTIN_NO_SYSTEM.has(agentId)) {
    const file = findAgentFile(agentId, input.configDir, input.cwd)
    if (file) {
      let body = ""
      try {
        body = markdownBody(readFileSync(file, "utf8"))
      } catch {
        body = ""
      }
      if (body) {
        notes.push(
          `block 1: agent "${agentId}" system prompt — body of ${file} (as of today; opencode strips the .md frontmatter, \`config/plugin/agent.ts decode()\`), sent verbatim`
        )
        if (input.agentChanges > 0) {
          notes.push(
            `the agent changed ${input.agentChanges} time(s) mid-session — block 1 shows the session's final agent`
          )
        }
        return { text: body, notes }
      }
    }
    notes.push(
      `block 1: agent "${agentId}" has no system prompt on this machine (no agent .md file found under ${AGENT_SOURCE_DIRS.join("/")} in the config roots) — assuming it uses the base prompt; if that agent defined its own prompt, block 1 is wrong`
    )
  }

  const guided = guidanceToolsInEffect(guidanceTools)
  let text = renderToolGuidance(BASE_PROMPT, guidanceTools)
  notes.push(
    `block 1: opencode base prompt (${BASE_PROMPT.length} chars, embedded from packages/core/src/session/runner/prompt/system.txt, byte-verified against the installed v${ASSET_VERSION} binary) with ${OPENCODE_PLACEHOLDER} substituted for: ${guided.length > 0 ? guided.join(", ") : "none"}`
  )
  notes.push(
    `tool set for guidance = observed tools ∪ opencode v${ASSET_VERSION} defaults (${DEFAULT_TOOLS.join(", ")}); tools hidden by session permissions would over-approximate`
  )

  const asset = input.model ? modelAssetFor(input.model.id) : null
  if (asset && input.model) {
    let template: string = MODEL_PROMPTS[asset.key]
    if (asset.key === "meta") {
      const name = loadModelName(input.db, input.model.providerID, input.model.id)
      template = template.replaceAll("{{MODEL_NAME}}", name)
      notes.push(`model display name for {{MODEL_NAME}}: "${name}" (models.dev catalog in the opencode kv table)`)
    }
    const rendered = renderToolGuidance(template, guidanceTools)
    text = asset.mode === "append" ? `${text}\n\n${rendered}` : rendered
    notes.push(
      `model-family prompt: ${asset.key} asset ${asset.mode === "append" ? "appended to" : "replaces"} the base prompt (plugin/optimize.ts, mode "${asset.mode}", matched model id "${input.model.id}")`
    )
  }
  if (input.version && input.version !== ASSET_VERSION) {
    notes.push(
      `prompt assets are embedded from opencode v${ASSET_VERSION}; this session ran v${input.version} — block 1 may differ byte-wise from what that build sent`
    )
  }
  return { text, notes }
}

// ---------------------------------------------------------------------------
// disk state (fallback reconstruction + path/skill enrichment)
// ---------------------------------------------------------------------------

interface DiskSkill {
  id: string
  name: string
  description: string
  filePath: string
}

function scanSkills(roots: string[]): DiskSkill[] {
  // opencode scans `<root>/{skill,skills}` with the glob `{*.md, **/SKILL.md}`
  // (config/plugin/skill.ts) — SKILL.md at any depth plus loose top-level .md
  // files — and merges by id with the nearest source winning. Built-ins
  // (plugin/skill.ts) join first so a disk skill of the same id overrides them.
  const byId = new Map<string, DiskSkill>()
  const push = (skill: DiskSkill): void => {
    byId.set(skill.id, skill)
  }
  for (const builtin of BUILTIN_SKILLS) push({ ...builtin, filePath: "" })
  for (const root of roots) {
    for (const sub of ["skills", "skill"]) {
      const dir = join(root, sub)
      if (!existsSync(dir)) continue
      for (const md of collectSkillFiles(dir)) {
        try {
          const content = readFileSync(md, "utf8")
          // skill-file.ts parse(): top-level `<name>.md` → id = file basename,
          // `…/<dir>/SKILL.md` → id = directory name.
          const topLevel = dirname(md) === dir && basename(md) !== "SKILL.md"
          const id = topLevel ? basename(md, ".md") : basename(dirname(md))
          const fm = frontmatter(content)
          push({ id, name: fm.name ?? id, description: fm.description ?? "", filePath: md })
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** All skill files under `dir`: SKILL.md at any depth + top-level `*.md`. */
function collectSkillFiles(dir: string): string[] {
  const out: string[] = []
  const visited = new Set<string>() // symlink-cycle guard (realpath)
  const walk = (current: string, depth: number): void => {
    if (depth > 8) return
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    entries.sort()
    for (const entry of entries) {
      const full = join(current, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full) // follows symlinks, like opencode's scan
      } catch {
        continue // broken link
      }
      if (st.isDirectory()) {
        let key = full
        try {
          key = realpathSync(full)
        } catch {
          /* keep */
        }
        if (visited.has(key)) continue
        visited.add(key)
        walk(full, depth + 1)
      } else if (st.isFile()) {
        if (current === dir && entry.endsWith(".md")) out.push(full)
        else if (entry === "SKILL.md") out.push(full)
      }
    }
  }
  walk(dir, 0)
  return out
}

/** Minimal frontmatter reader (YAML scalars, single/double-quoted). */
function frontmatter(content: string): { name?: string; description?: string } {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const body = block?.[1]
  if (!body) return {}
  const out: { name?: string; description?: string } = {}
  for (const key of ["name", "description"] as const) {
    const hit = body.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))
    const raw = hit?.[1]
    if (raw === undefined) continue
    let value = raw.trim()
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'")
    else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"')
    out[key] = value
  }
  return out
}

function skillRoots(configDir: string, cwd: string): string[] {
  // Config-discovery roots that may carry `skills/` (config/discovery.ts):
  // global config dir + ~/.claude + ~/.agents, then each ancestor of the
  // session cwd with its .opencode/<bare>/.claude/.agents variants. Ordered so
  // the nearest root is last → it wins id collisions (opencode merges sources
  // with later sources overriding earlier ones).
  const globals = [configDir, join(homedir(), ".claude"), join(homedir(), ".agents")]
  const ancestors: string[] = []
  let dir = cwd
  for (let i = 0; i < 32 && dir && dir !== dirname(dir); i++) {
    ancestors.push(join(dir, ".agents"), join(dir, ".claude"), dir, join(dir, ".opencode"))
    dir = dirname(dir)
  }
  ancestors.reverse()
  return [...globals, ...ancestors]
}

/**
 * Environment block: exact template from `instructions/builtins.ts`. Values come
 * from session metadata; `Project.root()` semantics = nearest .git/.hg ancestor
 * (packages/core/src/project.ts:49-58), tmp mirrors the observed `/tmp/opencode`.
 */
function reconstructEnvironment(sessionID: string, cwd: string): { text: string; approximated: string[] } {
  const approximated: string[] = []
  let root = cwd
  let git = false
  if (cwd) {
    let dir = cwd
    let marker: { root: string; git: boolean } | null = null
    for (let i = 0; i < 24 && dir && dir !== dirname(dir); i++) {
      if (existsSync(join(dir, ".git"))) {
        marker = { root: dir, git: true }
        break
      }
      if (existsSync(join(dir, ".hg"))) {
        marker = { root: dir, git: false }
        break
      }
      dir = dirname(dir)
    }
    if (marker) {
      root = marker.root
      git = marker.git
      if (marker.root !== cwd) approximated.push("workspace root = nearest .git/.hg ancestor of the session directory")
    } else {
      approximated.push("workspace root = session directory (no .git/.hg ancestor found on disk today)")
    }
    approximated.push("git-repo flag checked on disk today, not at session time")
  } else {
    approximated.push("workspace root and git flag unknown (no session directory)")
  }
  const tmp = join(tmpdir(), "opencode")
  approximated.push(`tmp = ${tmp} (opencode's Global.tmp, inferred from a persisted environment blob)`)
  const text = [
    "<env>",
    `  Current conversation session ID: ${sessionID}`,
    `  Working directory: ${cwd}`,
    `  Workspace root folder: ${root}`,
    `  Is directory a git repo: ${git ? "yes" : "no"}`,
    `  Platform: ${process.platform}`,
    `  Prefer ${tmp} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    "</env>"
  ].join("\n")
  return { text, approximated }
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

export interface OpencodeContextInput {
  db: Database
  sessionID: string
  cwd: string
  /** `session.version` — the opencode build that ran the session */
  version: string | null
  /** `session.agent` (null → default agent "build") */
  agent: string | null
  model: { id: string; providerID: string } | null
  /** tool names observed in the transcript */
  observedTools: string[]
  configDir: string
  /** session start (epoch ms) — used for the fallback date line */
  startedAt: number
  /** mid-session agent/model switch event counts (for notes) */
  agentChanges: number
  modelChanges: number
}

/**
 * Rebuild `contextInfo` for one opencode session: exact when the session has
 * `instruction_state` evidence, a labeled two-block reconstruction otherwise.
 */
export function buildOpencodeContextInfo(input: OpencodeContextInput): SessionContextInfo {
  const notes: string[] = []
  const evidence = loadInstructionState(input.db, input.sessionID)
  const observed = input.observedTools
  const tools = observed.length > 0 ? [...observed].sort() : DEFAULT_TOOLS
  const guidanceTools = new Set([...observed, ...DEFAULT_TOOLS])

  const blockOne = buildBlockOne(input, guidanceTools)
  notes.push(...blockOne.notes)

  let systemPrompt: string
  let contextFiles: ContextFile[]
  let skills: SessionContextInfo["skills"]

  const diskSkills = scanSkills(skillRoots(input.configDir, input.cwd))
  const skillPath = new Map(diskSkills.map((s) => [s.id, s.filePath]))
  let diskFiles: ContextFile[] = []
  try {
    diskFiles = loadProjectContextFiles({
      cwd: input.cwd,
      agentDir: input.configDir
    }).map((f) => ({
      path: f.path,
      content: f.content,
      global: f.path === join(input.configDir, "AGENTS.md") || f.path === join(input.configDir, "AGENTS.MD")
    }))
  } catch {
    diskFiles = []
  }

  if (evidence) {
    const blockTwo = renderInitialBlock(evidence, notes)
    systemPrompt = [blockOne.text, blockTwo].filter((part) => part.length > 0).join("\n\n")

    notes.push(
      "system prompt = the two system blocks opencode sends ([agent/base prompt, rendered instructions]); joined here with a blank line"
    )
    notes.push(
      `block 2 (instructions): EXACT — epoch baseline from \`instruction_state\` rendered through content-addressed \`instruction_blob\` values (${Object.keys(evidence.values).length} keys, join "\\n\\n" in opencode's fixed source order)`
    )
    if (evidence.rebasedAtCompaction) {
      notes.push(
        `the baseline was re-snapshotted at the compaction ending on seq ${evidence.epochStart} (instruction-state.ts advanceEpoch) — instruction sets from before that compaction are not recoverable`
      )
    }
    if (evidence.drifted) {
      notes.push(
        `instruction values changed after this epoch's baseline (current_values drifted through seq ${evidence.throughSeq}) — block 2 shows the baseline every request of the epoch started with`
      )
    }

    // context files + skills: exact values from the same blobs
    const filesRaw = evidence.values["core/instructions"]
    const parsedFiles = filesRaw === undefined ? null : parseInstructionFiles(filesRaw)
    if (parsedFiles) {
      contextFiles = parsedFiles.map((f) => ({
        path: f.path,
        content: f.content,
        global: f.path.startsWith(input.configDir)
      }))
      notes.push(`context files: EXACT contents from the \`core/instructions\` blob (${contextFiles.length} files)`)
    } else {
      contextFiles = diskFiles
      notes.push(
        evidence.values["core/instructions"] === undefined
          ? "context files: no `core/instructions` value was stored for this session — falling back to today's AGENTS.md/CLAUDE.md hierarchy on disk"
          : "context files: `core/instructions` blob did not parse — falling back to today's disk hierarchy"
      )
    }

    const skillsRaw = evidence.values["core/skill-guidance"]
    const parsedSkills = skillsRaw === undefined ? null : parseSkillSummaries(skillsRaw)
    if (parsedSkills) {
      skills = parsedSkills.map((s) => ({
        name: s.name,
        description: s.description,
        filePath: skillPath.get(s.id) ?? ""
      }))
      const noFile = skills.filter((s) => !s.filePath).map((s) => s.name)
      notes.push(
        `skills: EXACT listing from the \`core/skill-guidance\` blob (${skills.length})${
          noFile.length > 0
            ? `; no on-disk file for ${noFile.join(", ")} (built-in skill${noFile.length === 1 ? "" : "s"} or removed since the session)`
            : ""
        }`
      )
    } else {
      skills = diskSkills.map((s) => ({ name: s.name, description: s.description, filePath: s.filePath }))
      notes.push(
        evidence.values["core/skill-guidance"] === undefined
          ? "skills: no `core/skill-guidance` value stored (opencode records none when no skill is available) — listing today's skills from disk"
          : "skills: `core/skill-guidance` blob did not parse — listing today's skills from disk"
      )
    }

    const noticeCount = countInstructionNotices(input)
    if (noticeCount > 0) {
      notes.push(
        `instructions changed ${noticeCount} time(s) mid-session (persisted \`system\` notices) — block 2 is the epoch baseline, later changes are not part of it`
      )
    }
    if (input.modelChanges > 0) {
      notes.push(
        `the model changed ${input.modelChanges} time(s) mid-session — block 1 reflects the session's final model`
      )
    }
  } else {
    // ---- reconstruction (no persisted instruction evidence) ----
    notes.push(
      `no instruction evidence: this session has no \`instruction_state\` row (opencode ${input.version ? `v${input.version}` : "≤1.x"} predates or skipped prompt persistence) — the prompt below is reconstructed at view time`
    )
    notes.push(
      `block 1 text is opencode v${ASSET_VERSION}'s prompt assets (byte-verified against the installed binary); the prompt that actually ran is not recoverable`
    )
    notes.push(
      `block 2 reuses opencode's own renderers against local state: AGENTS.md/CLAUDE.md and skills are as of today, the date line is the session's start date`
    )

    const parts: string[] = []
    const environment = reconstructEnvironment(input.sessionID, input.cwd)
    parts.push(
      ["Here is some useful information about the environment you are running in:", environment.text].join("\n")
    )
    notes.push(`environment block reconstructed from session metadata (${environment.approximated.join("; ")})`)
    parts.push(`Today's date: ${new Date(input.startedAt).toDateString()}`)

    if (diskFiles.length > 0) {
      parts.push(diskFiles.map((f) => `Instructions from: ${f.path}\n${f.content}`).join("\n\n"))
      notes.push(
        `context files: rendered from today's disk hierarchy (${diskFiles.length} files, "Instructions from:" format)`
      )
    } else {
      notes.push("context files: none found on disk today")
    }
    if (diskSkills.length > 0) {
      parts.push(renderSkillsValue(diskSkills))
      notes.push(
        `skills: rendered from today's scan (${diskSkills.length} = config + ~/.claude + ~/.agents + project ancestry, incl. ${BUILTIN_SKILLS.length} built-in${BUILTIN_SKILLS.length === 1 ? "" : "s"}; ids = skill directory names)`
      )
    } else {
      notes.push("skills: none found on disk today")
    }
    notes.push(
      "code-mode catalog and MCP server instructions are omitted — they were never persisted for this session and only exist at request time"
    )

    systemPrompt = [blockOne.text, ...parts].filter((part) => part.length > 0).join("\n\n")
    contextFiles = diskFiles
    skills = diskSkills.map((s) => ({ name: s.name, description: s.description, filePath: s.filePath }))
  }

  notes.push(
    "reconstructed: true — opencode never stores the assembled prompt; even with exact instruction evidence, block 1's tool set, the embedded asset version, and any disk-read agent prompt are approximations"
  )

  return {
    systemPrompt,
    contextFiles,
    skills,
    tools,
    reconstructed: true,
    notes
  }
}

interface InstructionFile {
  path: string
  content: string
}

function parseInstructionFiles(raw: string): InstructionFile[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out: InstructionFile[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null
    const { path, content } = item as { path?: unknown; content?: unknown }
    if (typeof path !== "string" || typeof content !== "string") return null
    out.push({ path, content })
  }
  return out
}

function parseSkillSummaries(raw: string): SkillSummary[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out: SkillSummary[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null
    const { id, name, description } = item as { id?: unknown; name?: unknown; description?: unknown }
    if (typeof name !== "string" || typeof description !== "string") return null
    out.push({ id: typeof id === "string" ? id : name, name, description })
  }
  return out
}

/** Count persisted `system` notices with `metadata.notice === "instructions"`. */
function countInstructionNotices(input: OpencodeContextInput): number {
  const row = input.db
    .query(
      `SELECT COUNT(*) AS c FROM session_message
       WHERE session_id = ? AND type = 'system' AND json_extract(data, '$.metadata.notice') = 'instructions'`
    )
    .get(input.sessionID) as { c: number } | null
  return Number(row?.c ?? 0)
}
