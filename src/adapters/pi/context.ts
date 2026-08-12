/**
 * Context reconstruction for Pi sessions.
 * Uses the vendored Pi 0.83.0 pure functions so the rebuilt system prompt and
 * per-request context match what Pi actually sent (modulo files changed since).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type {
  ContextFile as ViewContextFile,
  ContextPoint,
  NormalizedMessage,
  SessionContextInfo,
  Turn,
  UsageTotals
} from "../types.ts"
import { buildSystemPrompt } from "../../vendor/pi/system-prompt.ts"
import type { Skill } from "../../vendor/pi/system-prompt.ts"
import { loadProjectContextFiles } from "../../vendor/pi/context-files.ts"
import type { ContextFile } from "../../vendor/pi/context-files.ts"
import { TOOL_PROMPT_SNIPPETS } from "../../vendor/pi/tool-snippets.ts"
import { buildSessionContext } from "../../vendor/pi/session-context.ts"
import { convertToLlm } from "../../vendor/pi/messages.ts"
import type { AgentMessage, SessionEntry } from "../../vendor/pi/types.ts"
import { getAgentDir } from "./index.ts"

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"]

/** Best-effort skills loaded from the agent dir + settings.json (name/description/filePath). */
export function loadSkills(agentDir = getAgentDir()): Skill[] {
  const skills: Skill[] = []
  // settings.json "skills" entries
  const settingsPath = join(agentDir, "settings.json")
  let configured: unknown[] = []
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { skills?: unknown[] }
      configured = settings.skills ?? []
    }
  } catch {
    configured = []
  }
  for (const entry of configured) {
    const path = typeof entry === "string" ? entry : (entry as { source?: string }).source
    if (!path || path.startsWith("npm:") || path.startsWith("github:") || path.startsWith("http")) {
      continue // remote/package skills can't be resolved cheaply
    }
    const clean = path.replace(/^\+/, "")
    const abs = join(agentDir, clean)
    const skill = readSkillFile(abs)
    if (skill) skills.push(skill)
  }
  // also scan the skills dir for loose SKILL.md files
  const skillsDir = join(agentDir, "skills")
  try {
    if (existsSync(skillsDir)) {
      for (const name of readdirSync(skillsDir)) {
        const skill = readSkillFile(join(skillsDir, name))
        if (skill) skills.push(skill)
      }
    }
  } catch {
    // ignore
  }
  return skills
}

function readSkillFile(path: string): Skill | null {
  try {
    if (existsSync(path) && path.endsWith(".md")) {
      const content = readFileSync(path, "utf8")
      const nameMatch = content.match(/^name:\s*(.+)$/m)
      const descriptionMatch = content.match(/^description:\s*(.+)$/m)
      return {
        name: nameMatch?.[1]?.trim() ?? basenameNoExt(path),
        description: descriptionMatch?.[1]?.trim() ?? "",
        filePath: path
      }
    }
    if (existsSync(path) && statIsDir(path)) {
      const skill = readSkillFile(join(path, "SKILL.md"))
      if (skill) return skill
    }
  } catch {
    return null
  }
  return null
}

function statIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function basenameNoExt(path: string): string {
  const base = path.split("/").pop() ?? path
  return base.replace(/\.md$/i, "")
}

/** Tools active in a session: defaults + any tool names observed in tool_use blocks. */
export function sessionTools(entries: SessionEntry[]): string[] {
  const seen = new Set<string>(DEFAULT_TOOLS)
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const content = entry.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; name?: string }
          if (b.type === "tool_use" && typeof b.name === "string") seen.add(b.name)
        }
      }
    }
  }
  return Array.from(seen)
}

/** Reconstruct the system prompt + context files + skills for a Pi session. */
export function buildSessionContextInfo(
  entries: SessionEntry[],
  cwd: string,
  options?: { tools?: string[]; appendSystemPrompt?: string }
): SessionContextInfo {
  const agentDir = getAgentDir()
  const tools = options?.tools ?? sessionTools(entries)
  const toolSnippets: Record<string, string> = {}
  const promptGuidelines: string[] = []
  for (const name of tools) {
    const t = TOOL_PROMPT_SNIPPETS[name]
    if (t?.snippet) toolSnippets[name] = t.snippet
    if (t?.guidelines) promptGuidelines.push(...t.guidelines)
  }
  const contextFiles = loadProjectContextFiles({ cwd, agentDir })
  const skills = loadSkills(agentDir)
  const systemPrompt = buildSystemPrompt({
    cwd,
    selectedTools: tools,
    toolSnippets,
    promptGuidelines,
    appendSystemPrompt: options?.appendSystemPrompt,
    contextFiles,
    skills
  })
  const viewFiles: ViewContextFile[] = contextFiles.map((f: ContextFile, i) => ({
    path: f.path,
    content: f.content,
    global: i === 0 && f.path.startsWith(agentDir)
  }))
  const notes: string[] = []
  if (tools.length > 4) notes.push(`${tools.length} tools active (${tools.join(", ")})`)
  return {
    systemPrompt,
    contextFiles: viewFiles,
    skills: skills.map((s) => ({ name: s.name, description: s.description, filePath: s.filePath })),
    tools,
    reconstructed: true,
    notes
  }
}

/** Real turn index for an entry: the turn whose entryStart..entryEnd range contains it. */
function turnIndexOf(turns: Turn[], entryIndex: number): number | null {
  for (const t of turns) {
    if (t.entryStart <= entryIndex && entryIndex <= t.entryEnd) return t.index
  }
  return null
}

/** Per-request context points: token curve + reconstructed context messages. */
export function buildContextPoints(
  entries: SessionEntry[],
  assistantCalls: NormalizedMessage[],
  turns: Turn[]
): ContextPoint[] {
  const points: ContextPoint[] = []
  let requestIndex = 0
  for (const call of assistantCalls) {
    // "before context" for this request = the session state just before the
    // assistant call (its parent entry), NOT including the response itself.
    const target = entries[call.entryIndex - 1] ?? entries[call.entryIndex]
    if (!target) continue
    const ctx = buildSessionContext(entries, target.id)
    const messages = ctx.messages
    const usage: UsageTotals = call.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    const contextMessages = messages.map((m: AgentMessage) => ({
      role:
        m.role === "assistant"
          ? ("assistant" as const)
          : m.role === "compactionSummary"
            ? ("compactionSummary" as const)
            : m.role === "branchSummary"
              ? ("branchSummary" as const)
              : m.role === "custom"
                ? ("custom" as const)
                : m.role === "toolResult"
                  ? ("toolResult" as const)
                  : ("user" as const),
      timestamp: typeof m.timestamp === "number" ? m.timestamp : 0,
      blocks:
        typeof m.content === "string"
          ? [{ kind: "text" as const, text: m.content }]
          : Array.isArray(m.content)
            ? m.content.map((b) => {
                const block = b as { type?: string; text?: string; name?: string }
                const kind = block.type === "thinking" ? ("thinking" as const) : ("text" as const)
                return {
                  kind,
                  text: block.text ?? "",
                  toolName: typeof block.name === "string" ? block.name : undefined
                }
              })
            : [],
      summary: typeof m.summary === "string" ? m.summary : undefined,
      tokensBefore: typeof m.tokensBefore === "number" ? m.tokensBefore : undefined,
      entryIndex: call.entryIndex,
      ...(m.customType ? { customType: m.customType as string } : {})
    }))
    // system prompt is rebuilt once per session (see buildSessionContextInfo)
    points.push({
      requestIndex,
      turnIndex: turnIndexOf(turns, call.entryIndex) ?? requestIndex,
      timestamp: call.timestamp,
      model: call.model ?? null,
      thinkingLevel: ctx.thinkingLevel ?? null,
      usage,
      contextTokens: usage.input + usage.cacheRead,
      contextMessages
    })
    requestIndex++
  }
  return points
}

/** Render the exact LLM-format context text for a context point (for diff view). */
export function contextMessagesToLlm(messages: AgentMessage[]): string {
  return convertToLlm(messages)
    .map((m) => {
      const text = (m.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
      return `<${m.role}>\n${text}\n</${m.role}>`
    })
    .join("\n\n")
}
