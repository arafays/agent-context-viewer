/**
 * Claude Code prompt-context reconstruction from local evidence.
 *
 * What Claude Code persists (verified against real ~/.claude/projects/*.jsonl
 * session files and strings in the installed 2.1.277 CLI binary):
 *   - `prompt_snapshot` attachment (seen from ~2.1.263): the EXACT system
 *     prompt as an array of text blocks, plus optional `cliPrefix` (the leading
 *     "You are Claude Code…" block — the CLI sends `[append, cliPrefix, ...segments]`),
 *     `tools` (tool definitions at snapshot time) and `hostPrompt` (opaque id,
 *     the host prompt text itself is not persisted).
 *   - `instructions` attachment: exact CLAUDE.md/AGENTS.md contents injected
 *     for the session (path + kind Project/User + content).
 *   - `skill_listing` attachment: the exact `- name: description` skill listing.
 *   - `agent_listing_delta` attachment: the full agent listing (isInitial).
 *   - Claude's proprietary BASE system prompt is otherwise not persisted.
 *     When no snapshot exists we do NOT fabricate it: we compose only the
 *     recoverable context (context files, skills, agents, slash commands),
 *     each section labeled with its source, and say so in `notes`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join, sep } from "node:path"
import { loadProjectContextFiles } from "../../vendor/pi/context-files.ts"
import type { ContextFile, SessionContextInfo } from "../types.ts"

/** Marker Claude Code leaves between the static and dynamic prompt halves. */
const DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"

// ---------------------------------------------------------------------------
// evidence captured from the session file (see captureAttachment)
// ---------------------------------------------------------------------------

export interface PromptSnapshot {
  /** 1-based line of the attachment record in the session file */
  line: number
  /** system prompt text blocks, verbatim */
  systemPrompt: string[]
  /** leading "You are Claude Code…" block, sent as its own system block */
  cliPrefix?: string
  /** tool names recorded with the snapshot */
  tools?: string[]
  /** opaque host prompt id (host prompt text is not persisted) */
  hostPrompt?: string
}

export interface InstructionFile {
  path: string
  /** "Project" / "User" as recorded by Claude Code */
  kind: string
  content: string
}

export interface SkillListing {
  line: number
  names: string[]
  /** `- name: description` lines (descriptions may wrap) */
  content: string
}

export interface AgentListing {
  line: number
  /** full listing lines, already `- name: description` */
  lines: string[]
}

export interface SessionEvidence {
  promptSnapshots: PromptSnapshot[]
  instructionFiles: Map<string, InstructionFile>
  skillListing: SkillListing | null
  agentListing: AgentListing | null
}

export function emptyEvidence(): SessionEvidence {
  return { promptSnapshots: [], instructionFiles: new Map(), skillListing: null, agentListing: null }
}

/** Capture prompt-relevant attachments; call once per attachment record. */
export function captureAttachment(ev: SessionEvidence, raw: unknown, line: number): void {
  if (typeof raw !== "object" || raw === null) return
  const att = raw as Record<string, unknown>
  switch (att.type) {
    case "prompt_snapshot": {
      if (!Array.isArray(att.systemPrompt)) return
      ev.promptSnapshots.push({
        line,
        systemPrompt: att.systemPrompt.filter((s): s is string => typeof s === "string"),
        ...(typeof att.cliPrefix === "string" ? { cliPrefix: att.cliPrefix } : {}),
        ...(typeof att.hostPrompt === "string" ? { hostPrompt: att.hostPrompt } : {}),
        ...(Array.isArray(att.tools)
          ? { tools: att.tools.flatMap((t) => (typeof t?.name === "string" ? [t.name] : [])) }
          : {})
      })
      break
    }
    case "instructions": {
      if (!Array.isArray(att.files)) return
      for (const f of att.files) {
        if (typeof f !== "object" || f === null) continue
        const fe = f as Record<string, unknown>
        if (typeof fe.path !== "string" || typeof fe.content !== "string") continue
        ev.instructionFiles.set(fe.path, {
          path: fe.path,
          kind: typeof fe.type === "string" ? fe.type : "",
          content: fe.content
        })
      }
      break
    }
    case "skill_listing": {
      if (ev.skillListing) break
      ev.skillListing = {
        line,
        names: Array.isArray(att.names) ? att.names.filter((n): n is string => typeof n === "string") : [],
        content: typeof att.content === "string" ? att.content : ""
      }
      break
    }
    case "agent_listing_delta": {
      if (ev.agentListing) break
      ev.agentListing = {
        line,
        lines: Array.isArray(att.addedLines) ? att.addedLines.filter((l): l is string => typeof l === "string") : []
      }
      break
    }
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// snapshot rendering
// ---------------------------------------------------------------------------

/**
 * Merge fields across duplicate snapshots of the same prompt: Claude Code
 * records the system prompt first and re-records it with `tools`/`cliPrefix`
 * a few lines later, so the first record of a prompt may lack those fields.
 */
export function normalizeSnapshots(snapshots: PromptSnapshot[]): PromptSnapshot[] {
  const byPrompt = new Map<string, PromptSnapshot>()
  for (const s of snapshots) {
    const key = JSON.stringify(s.systemPrompt)
    const base = byPrompt.get(key)
    if (!base) {
      byPrompt.set(key, s)
      continue
    }
    base.cliPrefix ??= s.cliPrefix
    base.hostPrompt ??= s.hostPrompt
    base.tools ??= s.tools
  }
  return snapshots
}

/** Exact prompt for one snapshot: cliPrefix block + text blocks joined by newlines. */
export function renderSnapshot(snap: PromptSnapshot): string {
  const blocks: string[] = []
  if (snap.cliPrefix) blocks.push(snap.cliPrefix)
  blocks.push(snap.systemPrompt.join("\n"))
  return blocks.join("\n")
}

/** Prompt in effect at a session-file line: last snapshot at/before it (else the first). */
export function snapshotPromptAt(snapshots: PromptSnapshot[], line: number): string {
  const first = snapshots[0]
  if (!first) return ""
  let chosen = first
  for (const s of snapshots) {
    if (s.line <= line) chosen = s
  }
  return renderSnapshot(chosen)
}

// ---------------------------------------------------------------------------
// disk discovery (fallback only — used when the session has no attachments)
// ---------------------------------------------------------------------------

interface Row {
  name: string
  description: string
  filePath: string
}

function dedupeRoots(roots: string[]): string[] {
  return [...new Set(roots.filter((r) => r.length > 0))]
}

/** Minimal YAML frontmatter reader for `name` / `description` (no yaml dep). */
function frontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {}
  const rest = content.slice(3)
  const nl = rest.startsWith("\r") ? 1 : 0
  const end = rest.slice(nl).match(/\r?\n---[ \t]*(\r?\n|$)/)
  if (!end || end.index === undefined) return {}
  const block = rest.slice(nl + 1, nl + end.index + end[0].length)
  const lines = block.split(/\r?\n/)
  const out: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    const [, key = "", rawValue = ""] = kv
    if (!key) continue
    let value = rawValue.trim()
    if (/^[|>][-+]?$/.test(value)) {
      const folded = value.startsWith(">")
      const collected: string[] = []
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1] ?? "")) {
        i++
        collected.push((lines[i] ?? "").trim())
      }
      value = folded ? collected.join(" ") : collected.join("\n")
    } else if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** `<root>/<skill>/SKILL.md` directories across roots; first name wins. */
function scanSkillRoots(roots: string[]): Row[] {
  const out: Row[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.startsWith(".") || e === "node_modules") continue
      const dir = join(root, e)
      let resolved = dir
      try {
        resolved = realpathSync(dir) // project skills are often symlinks
      } catch {
        /* keep original path */
      }
      const md = join(resolved, "SKILL.md")
      if (!existsSync(md)) continue
      let content: string
      try {
        content = readFileSync(md, "utf8")
      } catch {
        continue
      }
      const fm = frontmatter(content)
      const name = fm.name?.trim() || e
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, description: fm.description?.trim() ?? "", filePath: md })
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** Flat `<root>/*.md` (agents) with frontmatter name/description. */
function scanMarkdownRoots(roots: string[]): Row[] {
  const out: Row[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.startsWith(".") || !e.endsWith(".md")) continue
      const file = join(root, e)
      let content: string
      try {
        if (!statSync(file).isFile()) continue
        content = readFileSync(file, "utf8")
      } catch {
        continue
      }
      const fm = frontmatter(content)
      const name = fm.name?.trim() || e.replace(/\.md$/, "")
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, description: fm.description?.trim() ?? "", filePath: file })
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** Recursive markdown files under each root (slash commands); name = rel path joined with ":". */
function scanCommandRoots(roots: string[]): Row[] {
  const out: Row[] = []
  const seen = new Set<string>()
  const walk = (root: string, relDir: string, depth: number): void => {
    if (depth > 3) return
    const dir = relDir ? join(root, relDir) : root
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      if (e.startsWith(".") || e === "node_modules") continue
      const full = join(dir, e)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        walk(root, relDir ? `${relDir}/${e}` : e, depth + 1)
        continue
      }
      if (!e.endsWith(".md")) continue
      const rel = relDir ? `${relDir}/${e}` : e
      const name = rel.replace(/\.md$/, "").split("/").join(":")
      if (seen.has(name)) continue
      let content: string
      try {
        content = readFileSync(full, "utf8")
      } catch {
        continue
      }
      seen.add(name)
      out.push({ name, description: frontmatter(content).description?.trim() ?? "", filePath: full })
    }
  }
  for (const root of roots) walk(root, "", 0)
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** Parse a `skill_listing` content into entries (continuation lines join the description). */
function parseSkillListing(listing: SkillListing): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = []
  for (const raw of listing.content.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.startsWith("- ")) {
      const body = line.slice(2)
      const idx = body.indexOf(": ")
      const name = idx >= 0 ? body.slice(0, idx) : body
      if (/^[\w.-]+$/.test(name)) {
        out.push({ name, description: idx >= 0 ? body.slice(idx + 2).trim() : "" })
        continue
      }
    }
    const last = out.at(-1)
    if (last && line.trim()) {
      last.description = `${last.description} ${line.trim()}`.trim()
    }
  }
  const seen = new Set(out.map((e) => e.name))
  for (const name of listing.names) {
    if (!seen.has(name)) out.push({ name, description: "" })
  }
  return out
}

// ---------------------------------------------------------------------------
// system prompt reconstruction
// ---------------------------------------------------------------------------

export interface ClaudeContextInput {
  cwd: string
  configDir: string
  evidence: SessionEvidence
  /** tool names observed in tool_use blocks */
  observedTools: string[]
  gitBranch: string
}

interface FallbackResult {
  text: string
  agents: number
  agentsExact: boolean
  commands: number
}

function buildFallbackPrompt(
  input: ClaudeContextInput,
  contextFiles: ContextFile[],
  contextFilesExact: boolean,
  skills: SessionContextInfo["skills"],
  skillsExact: boolean,
  skillRoots: string[]
): FallbackResult {
  const { cwd, configDir, evidence } = input
  const sections: string[] = []

  if (contextFiles.length > 0) {
    const label = contextFilesExact
      ? "exact content injected for the session (source: `instructions` attachment)"
      : "reconstructed from disk as of today (source: CLAUDE.md/AGENTS.md hierarchy; may differ from the session date)"
    sections.push(`## Context files — ${label}`)
    for (const f of contextFiles) {
      const kind = evidence.instructionFiles.get(f.path)?.kind
      sections.push(`### ${f.path}${kind ? ` (${kind})` : ""}\n${f.content.trimEnd()}`)
    }
  }

  if (skills.length > 0) {
    const label = skillsExact
      ? `exact listing (source: \`skill_listing\` attachment${
          evidence.skillListing ? `, line ${evidence.skillListing.line}` : ""
        })`
      : `discovered on disk as of today (roots: ${skillRoots.join(", ")})`
    sections.push(`## Skills — ${label}`)
    for (const s of skills) {
      sections.push(`- ${s.name}${s.filePath ? ` (${s.filePath})` : ""}: ${s.description || "(no description)"}`)
    }
  }

  let agents = 0
  let agentsExact = false
  const listing = evidence.agentListing
  if (listing && listing.lines.length > 0) {
    agentsExact = true
    agents = listing.lines.length
    sections.push(`## Agents — exact listing (source: \`agent_listing_delta\` attachment, line ${listing.line})`)
    sections.push(...listing.lines)
  } else {
    const roots = dedupeRoots([join(configDir, "agents"), cwd ? join(cwd, ".claude/agents") : ""])
    const rows = scanMarkdownRoots(roots)
    if (rows.length > 0) {
      agents = rows.length
      sections.push(
        `## Agents — discovered on disk as of today (roots: ${roots.join(", ")}) — built-in Claude Code agents are not on disk`
      )
      for (const r of rows) sections.push(`- ${r.name} (${r.filePath}): ${r.description || "(no description)"}`)
    }
  }

  const commandRoots = dedupeRoots([join(configDir, "commands"), cwd ? join(cwd, ".claude/commands") : ""])
  const commands = scanCommandRoots(commandRoots)
  if (commands.length > 0) {
    sections.push(`## Slash commands — discovered on disk as of today (roots: ${commandRoots.join(", ")})`)
    for (const c of commands) sections.push(`- /${c.name} (${c.filePath}): ${c.description || "(no description)"}`)
  }

  const banner = [
    "# Claude Code system prompt — not persisted for this session",
    "",
    "This session has no `prompt_snapshot` attachment, so Claude's proprietary base prompt cannot be recovered from disk and is NOT reconstructed here.",
    "What follows is the context Claude Code loaded alongside it, each section labeled with its source:"
  ]
  const text =
    sections.length > 0
      ? [...banner, "", sections.join("\n\n")].join("\n")
      : [...banner, "", "(no context files, skills, agents, or commands recoverable for this session's cwd)"].join("\n")
  return { text, agents, agentsExact, commands: commands.length }
}

/** Rebuild contextInfo.systemPrompt/contextFiles/skills/tools + honesty notes. */
export function buildClaudeContextInfo(input: ClaudeContextInput): SessionContextInfo {
  const { cwd, configDir, evidence, observedTools, gitBranch } = input
  const snapshots = normalizeSnapshots(evidence.promptSnapshots)
  const first = snapshots[0]

  // context files: exact injected content wins over today's disk hierarchy
  let contextFiles: ContextFile[] = []
  let contextFilesExact = false
  if (evidence.instructionFiles.size > 0) {
    contextFilesExact = true
    for (const f of evidence.instructionFiles.values()) {
      contextFiles.push({ path: f.path, content: f.content, global: f.path.startsWith(configDir + sep) })
    }
  } else if (cwd) {
    try {
      contextFiles = loadProjectContextFiles({ cwd, agentDir: configDir }).map((f) => ({
        path: f.path,
        content: f.content,
        global: f.path.startsWith(configDir + sep)
      }))
    } catch {
      contextFiles = []
    }
  }

  // skills: exact session listing wins over today's disk scan (disk scan also
  // resolves file paths for listed skills that still exist locally)
  const skillRoots = dedupeRoots([cwd ? join(cwd, ".claude/skills") : "", join(configDir, "skills")])
  const diskSkills = scanSkillRoots(skillRoots)
  const skillPath = new Map(diskSkills.map((s) => [s.name, s.filePath]))
  const skills: SessionContextInfo["skills"] = []
  let skillsExact = false
  if (evidence.skillListing) {
    skillsExact = true
    for (const s of parseSkillListing(evidence.skillListing)) {
      skills.push({ name: s.name, description: s.description, filePath: skillPath.get(s.name) ?? "" })
    }
  } else {
    skills.push(...diskSkills)
  }

  // system prompt
  const fallback = first
    ? null
    : buildFallbackPrompt(input, contextFiles, contextFilesExact, skills, skillsExact, skillRoots)
  const systemPrompt = first ? renderSnapshot(first) : (fallback?.text ?? "")

  const notes: string[] = []
  if (first) {
    const distinct = new Set(snapshots.map((s) => JSON.stringify(s.systemPrompt))).size
    notes.push(
      `system prompt: EXACT — \`prompt_snapshot\` attachment (record at line ${first.line} of this session file)`
    )
    if (distinct > 1) {
      notes.push(
        `prompt changed during the session (${distinct} distinct snapshots) — showing the first; per-request context uses the snapshot in effect`
      )
    }
    if (first.cliPrefix) {
      notes.push(
        "`cliPrefix` is stored separately in the snapshot and prepended here (it is sent as its own leading system block)"
      )
    }
    if (first.hostPrompt) {
      notes.push(
        `snapshot \`hostPrompt\`=${first.hostPrompt} is an opaque id — the host prompt text itself is not persisted`
      )
    }
    if (first.systemPrompt.some((s) => s.includes(DYNAMIC_BOUNDARY))) {
      notes.push("`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` kept verbatim (Claude Code's static/dynamic cache boundary)")
    }
    notes.push("prompt blocks are persisted as an array of text blocks — joined here with newlines")
  } else {
    notes.push(
      "Claude Code does not persist its base system prompt in session files (no `prompt_snapshot` attachment) — proprietary prompt not reconstructed; only recoverable context below"
    )
    if (fallback && fallback.agents > 0) {
      notes.push(
        fallback.agentsExact
          ? `agents: exact agent_listing attachment (${fallback.agents})`
          : `agents: discovered on disk as of today (${fallback.agents})`
      )
    }
    if (fallback && fallback.commands > 0) {
      notes.push(`slash commands: discovered on disk as of today (${fallback.commands})`)
    }
  }

  if (contextFilesExact) {
    notes.push(`context files: exact content from \`instructions\` attachment (${contextFiles.length} files)`)
  } else if (contextFiles.length > 0) {
    notes.push("context files: reconstructed from the cwd as of today (may differ from session date)")
  } else {
    notes.push("context files: none found")
  }
  notes.push(
    skillsExact
      ? `skills: exact skill_listing attachment (${skills.length})`
      : `skills: discovered on disk as of today (${skills.length})`
  )

  const tools: string[] = []
  const snapshotTools = first?.tools
  if (snapshotTools && snapshotTools.length > 0) {
    for (const t of snapshotTools) if (!tools.includes(t)) tools.push(t)
    const extras = observedTools.filter((t) => !tools.includes(t)).sort()
    tools.push(...extras)
    notes.push(
      `tools: ${tools.length - extras.length} recorded in prompt_snapshot (+${extras.length} observed in tool_use)`
    )
  } else {
    tools.push(...[...new Set(observedTools)].sort())
  }

  notes.push("per-request context tokens + messages are exact (usage.input + cache_read_input_tokens)")
  if (gitBranch) notes.push(`git branch: ${gitBranch}`)

  return {
    systemPrompt,
    contextFiles,
    skills,
    tools,
    reconstructed: true,
    notes
  }
}
