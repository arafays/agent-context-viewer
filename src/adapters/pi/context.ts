/**
 * Context reconstruction for Pi sessions.
 * Uses the vendored Pi 0.87.1 pure functions so the rebuilt system prompt and
 * per-request context match what Pi actually sent (modulo files changed since).
 */

import type { ContextFile } from "../../vendor/pi/context-files.ts"
import { loadProjectContextFiles } from "../../vendor/pi/context-files.ts"
import { convertToLlm } from "../../vendor/pi/messages.ts"
import { buildSessionContext } from "../../vendor/pi/session-context.ts"
import { buildSystemPrompt, installedPiVersion, VENDORED_PI_VERSION } from "../../vendor/pi/system-prompt.ts"
import { TOOL_PROMPT_SNIPPETS } from "../../vendor/pi/tool-snippets.ts"
import type { AgentMessage, SessionEntry } from "../../vendor/pi/types.ts"
import type {
  ContextPoint,
  NormalizedMessage,
  SessionContextInfo,
  Turn,
  UsageTotals,
  ContextFile as ViewContextFile
} from "../types.ts"
import { collectExtensionToolBits, describeScannedPackages, loadMcpToolSnippets } from "./extension-prompt.ts"
import { getAgentDir } from "./index.ts"
import { loadPiSkills, loadPromptSources } from "./resources.ts"

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"]

/**
 * Tools active in a session: defaults + any tool names observed in tool calls.
 *
 * pi stores assistant tool calls as `toolCall` content blocks (never `tool_use`)
 * and records the name on each `toolResult` message, so both are observed —
 * `tool_use` is kept as a fallback for foreign/hand-edited session files.
 */
export function sessionTools(entries: SessionEntry[]): string[] {
  const seen = new Set<string>(DEFAULT_TOOLS)
  for (const entry of entries) {
    if (entry.type !== "message") continue
    const message = entry.message
    if (message.role === "assistant") {
      const content = message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; name?: string }
          if ((b.type === "toolCall" || b.type === "tool_use") && typeof b.name === "string") seen.add(b.name)
        }
      }
    } else if (message.role === "toolResult") {
      const name = message.toolName
      if (typeof name === "string") seen.add(name)
    }
  }
  return Array.from(seen)
}

/**
 * Reconstruct the system prompt + context files + skills for a Pi session.
 *
 * Mirrors what `agent-session` feeds `buildSystemPrompt`: per-tool snippet map +
 * per-tool guideline map (never a flattened guideline list), SYSTEM.md as
 * `customPrompt`, APPEND_SYSTEM.md as `appendSystemPrompt`, the full skill set,
 * and extension-tool contributions discovered from installed pi packages.
 */
export function buildSessionContextInfo(
  entries: SessionEntry[],
  cwd: string,
  options?: { tools?: string[]; appendSystemPrompt?: string }
): SessionContextInfo {
  const agentDir = getAgentDir()
  const tools = options?.tools ?? sessionTools(entries)

  const extensions = collectExtensionToolBits(agentDir, cwd)
  const mcpSnippets = loadMcpToolSnippets(agentDir)
  const toolSnippets: Record<string, string> = {}
  const toolGuidelines: Record<string, string[]> = {}
  const uncoveredTools: string[] = []
  const mcpSnippetTools: string[] = []
  for (const name of tools) {
    const builtin = TOOL_PROMPT_SNIPPETS[name]
    const snippet = builtin?.snippet ?? extensions.toolSnippets[name] ?? mcpSnippets[name]
    const guidelines = builtin?.guidelines ?? extensions.toolGuidelines[name]
    if (snippet) toolSnippets[name] = snippet
    if (guidelines?.length) toolGuidelines[name] = guidelines
    if (!snippet) uncoveredTools.push(name)
    else if (!builtin && !(name in extensions.toolSnippets)) mcpSnippetTools.push(name)
  }

  const contextFiles = loadProjectContextFiles({ cwd, agentDir })
  const { skills, roots } = loadPiSkills(cwd, agentDir)
  const promptSources = loadPromptSources(cwd, agentDir)
  const appendSystemPrompt = options?.appendSystemPrompt ?? promptSources.appendSystemPrompt

  const systemPrompt = buildSystemPrompt({
    cwd,
    selectedTools: tools,
    toolSnippets,
    toolGuidelines,
    promptGuidelines: [],
    customPrompt: promptSources.customPrompt,
    appendSystemPrompt,
    contextFiles,
    skills
  })

  const viewFiles: ViewContextFile[] = contextFiles.map((f: ContextFile, i) => ({
    path: f.path,
    content: f.content,
    global: i === 0 && f.path.startsWith(agentDir)
  }))

  const notes: string[] = []
  const installed = installedPiVersion()
  if (installed && installed !== VENDORED_PI_VERSION) {
    notes.push(`vendored prompt builder is pi ${VENDORED_PI_VERSION}, installed pi is ${installed} — prompt may drift`)
  }
  for (const file of promptSources.files) notes.push(`prompt source: ${file}`)
  notes.push(`${skills.length} skills loaded (${roots.length} sources)`)
  if (uncoveredTools.length > 0) {
    notes.push(
      `no prompt snippet found for: ${uncoveredTools.join(", ")} — pi omits tools that have none; snippets built at runtime or by since-removed packages can't be verified here`
    )
  }
  if (tools.length > DEFAULT_TOOLS.length) notes.push(`${tools.length} tools active (${tools.join(", ")})`)
  if (mcpSnippetTools.length > 0) {
    notes.push(
      `mcp tool snippets rebuilt from mcp-cache.json (last time pi queried the server): ${mcpSnippetTools.join(", ")}`
    )
  }
  if (Object.keys(extensions.toolSnippets).length > 0) {
    notes.push(`extension tools scanned: ${describeScannedPackages(extensions, agentDir)}`)
  }
  // pi activates every registered extension tool, but a tool that was never
  // called is unobservable from the session file — disclose the gap instead of
  // pretending the reconstructed <tools>/rules sections include them.
  const uncalledExtensionTools = [
    ...new Set([...Object.keys(extensions.toolSnippets), ...Object.keys(extensions.toolGuidelines)])
  ]
    .filter((name) => !tools.includes(name))
    .sort()
  if (uncalledExtensionTools.length > 0) {
    notes.push(
      `pi also activates these extension tools, never called in this session (their snippets/rules omitted): ${uncalledExtensionTools.join(", ")}`
    )
  }

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
