/**
 * Vendored from @earendil-works/pi-coding-agent 0.87.1 (MIT):
 * - `dist/core/system-prompt.js` → `normalizeBuildSystemPromptOptions`, `buildRules`,
 *   `renderProjectContext`, `buildSystemPromptSections`, `buildSystemPromptState`,
 *   `buildSystemPrompt`
 * - `dist/core/skills.js` → `formatSkillsForPrompt`
 * - `@earendil-works/pi-ai` → `getSystemMessageText` (inlined as `joinSystemMessageText`)
 * - `dist/config.js` → `getReadmePath`/`getDocsPath`/`getExamplesPath` (`getPackageDir`)
 *
 * Docs paths are resolved against the installed pi package dir at runtime, using the
 * same realpath pi's own `getPackageDir()` reaches through `import.meta.url`.
 * See NOTE.md in this directory.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ContextFile } from "./context-files.ts"

/** Version of @earendil-works/pi-coding-agent these functions were copied from. */
export const VENDORED_PI_VERSION = "0.87.1"

export interface Skill {
  name: string
  description: string
  filePath: string
  disableModelInvocation?: boolean
}

export interface BuildSystemPromptOptions {
  customPrompt?: string
  forceSystemPrompt?: string
  selectedTools?: string[]
  toolSnippets?: Record<string, string>
  toolGuidelines?: Record<string, string[]>
  promptGuidelines?: string[]
  appendSystemPrompt?: string
  sections?: Record<string, string>
  cwd: string
  contextFiles?: ContextFile[]
  skills?: Skill[]
}

/** The ordered, independently replaceable sections of the structured system prompt. */
export type SystemPromptSections = Record<string, string>

/** The complete prompt state: a forced prompt is opaque `content`, otherwise `sections`. */
export interface SystemPromptState {
  content: string
  sections?: SystemPromptSections
}

interface NormalizedBuildSystemPromptOptions {
  customPrompt?: string
  forceSystemPrompt?: string
  selectedTools: string[]
  toolSnippets: Record<string, string>
  toolGuidelines: Record<string, string[]>
  promptGuidelines: string[]
  appendSystemPrompt: string
  sections: Record<string, string>
  cwd: string
  contextFiles: ContextFile[]
  skills: Skill[]
}

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/** Vendored `formatSkillsForPrompt` (dist/core/skills.js). */
export function formatSkillsForPrompt(skills: Skill[], fileReadTool = "read"): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation)
  if (visibleSkills.length === 0) {
    return ""
  }
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    fileReadTool === "read"
      ? "Use the read tool to load a skill's file when the task matches its description."
      : "Use bash to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>"
  ]
  for (const skill of visibleSkills) {
    lines.push("  <skill>")
    lines.push(`    <name>${escapeXml(skill.name)}</name>`)
    lines.push(`    <description>${escapeXml(skill.description)}</description>`)
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`)
    lines.push("  </skill>")
  }
  lines.push("</available_skills>")
  return lines.join("\n")
}

/**
 * Locate the installed @earendil-works/pi-coding-agent package directory.
 * Honors `PI_PACKAGE_DIR` (as pi's getPackageDir does), then scans the mise npm
 * install layouts, then node_modules. Returned realpath, so the docs paths embedded
 * in the prompt match what the running pi prints (its import.meta.url is realpathed).
 */
export function getPiPackageDir(): string | undefined {
  const envDir = process.env.PI_PACKAGE_DIR
  if (envDir) return envDir
  const home = homedir()
  const candidates = [
    join(home, ".local/share/mise/installs/npm-earendil-works-pi-coding-agent/latest"),
    join(home, ".local/share/mise/installs/npm-earendil-works-pi-coding-agent/0.87.1"),
    join(home, ".local/share/mise/installs/npm-earendil-works-pi-coding-agent/0.83.0")
  ]
  for (const base of candidates) {
    const pkg = join(base, "node_modules/@earendil-works/pi-coding-agent")
    if (existsSync(pkg)) return realpathPackageDir(pkg)
  }
  // generic: any version dir under the mise install root
  const installRoot = join(home, ".local/share/mise/installs")
  if (existsSync(installRoot)) {
    for (const entry of readdirSync(installRoot)) {
      if (!entry.startsWith("npm-earendil-works-pi-coding-agent")) continue
      const full = join(installRoot, entry, "node_modules/@earendil-works/pi-coding-agent")
      if (existsSync(full)) return realpathPackageDir(full)
    }
  }
  // last resort: node_modules next to this app
  const local = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent")
  if (existsSync(local)) return realpathPackageDir(local)
  return undefined
}

function realpathPackageDir(pkg: string): string {
  try {
    return realpathSync(pkg)
  } catch {
    return pkg
  }
}

/** Installed pi package version, or undefined when pi isn't installed. */
export function installedPiVersion(): string | undefined {
  const pkg = getPiPackageDir()
  if (!pkg) return undefined
  try {
    const parsed = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version?: string }
    return parsed.version
  } catch {
    return undefined
  }
}

export function getReadmePath(): string {
  return join(getPiPackageDir() ?? "", "README.md")
}
export function getDocsPath(): string {
  return join(getPiPackageDir() ?? "", "docs")
}
export function getExamplesPath(): string {
  return join(getPiPackageDir() ?? "", "examples")
}

/** Vendored `normalizeBuildSystemPromptOptions` (dist/core/system-prompt.js). */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
  return {
    customPrompt: input.customPrompt,
    forceSystemPrompt: input.forceSystemPrompt,
    selectedTools: [...(input.selectedTools ?? ["read", "bash", "edit", "write"])],
    toolSnippets: { ...(input.toolSnippets ?? {}) },
    toolGuidelines: Object.fromEntries(
      Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]])
    ),
    promptGuidelines: [...(input.promptGuidelines ?? [])],
    appendSystemPrompt: input.appendSystemPrompt ?? "",
    sections: { ...(input.sections ?? {}) },
    cwd: input.cwd,
    contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
    skills: (input.skills ?? []).map((skill) => ({ ...skill }))
  }
}

function renderProjectContext(contextFiles: ContextFile[]): string {
  return [
    "Project-specific instructions and guidelines:",
    ...contextFiles.map(
      ({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`
    )
  ].join("\n\n")
}

function buildRules(
  selectedTools: string[],
  toolGuidelines: Record<string, string[]>,
  promptGuidelines: string[]
): string {
  const rules: string[] = []
  const seen = new Set<string>()
  const addRule = (rule: string) => {
    const normalized = rule.trim()
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    rules.push(normalized)
  }
  const hasBash = selectedTools.includes("bash")
  const hasPowerShell = selectedTools.includes("powershell")
  const hasGrep = selectedTools.includes("grep")
  const hasFind = selectedTools.includes("find")
  const hasLs = selectedTools.includes("ls")
  if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
    if (hasBash && hasPowerShell) {
      addRule("Use bash or PowerShell for file operations like listing, searching, and finding files")
    } else if (hasPowerShell) {
      addRule("Use PowerShell for file operations like listing, searching, and finding files")
    } else {
      addRule("Use bash for file operations like ls, rg, find")
    }
  }
  for (const name of selectedTools) {
    for (const rule of toolGuidelines[name] ?? []) addRule(rule)
  }
  for (const rule of promptGuidelines) addRule(rule)
  addRule("Be concise in your responses")
  addRule("Show file paths clearly when working with files")
  return rules.map((rule) => `- ${rule}`).join("\n")
}

/** Build the ordered, independently replaceable sections of the structured system prompt. */
export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
  const options = normalizeBuildSystemPromptOptions(input)
  const {
    customPrompt,
    selectedTools,
    toolSnippets,
    toolGuidelines,
    promptGuidelines,
    appendSystemPrompt,
    sections: customSections,
    cwd,
    contextFiles,
    skills
  } = options
  for (const name of Object.keys(customSections)) {
    if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
      throw new Error(`Invalid system prompt section name: ${name}`)
    }
  }
  const promptSections: Record<string, string> = {}
  if (customPrompt) {
    promptSections.preamble = customPrompt
  } else {
    promptSections.preamble =
      "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files."
    const visibleTools = selectedTools.filter((name) => !!toolSnippets[name])
    const tools =
      visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)"
    promptSections.tools = `${tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`
    promptSections.rules = buildRules(selectedTools, toolGuidelines, promptGuidelines)
    promptSections.docs = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`
  }
  if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt
  if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles)
  const skillFileReadTool = ["read", "bash"].find((tool) => selectedTools.includes(tool))
  if (skillFileReadTool && skills.length > 0) {
    const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim()
    if (skillsPrompt) promptSections.skills = skillsPrompt
  }
  promptSections.cwd = cwd.replace(/\\/g, "/")
  for (const [name, content] of Object.entries(customSections)) {
    if (content) promptSections[name] = content
  }
  const sections: SystemPromptSections = { preamble: promptSections.preamble }
  for (const [name, content] of Object.entries(promptSections)) {
    if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`
  }
  return sections
}

/**
 * The complete prompt state for `input`. A forced prompt is opaque and lives in `content`
 * with no sections; otherwise `content` is empty and the structured sections carry the prompt.
 */
export function buildSystemPromptState(input: BuildSystemPromptOptions): SystemPromptState {
  if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt }
  return { content: "", sections: buildSystemPromptSections(input) }
}

/** Vendored `getSystemMessageText` (pi-ai): content + section values, non-empty, joined by blank lines. */
function joinSystemMessageText(state: SystemPromptState): string {
  const parts: string[] = [state.content]
  for (const text of Object.values(state.sections ?? {})) if (text) parts.push(text)
  return parts.filter((part) => part.length > 0).join("\n\n")
}

/** Build the system prompt text, rendered exactly as the transcript's system message replays it. */
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
  return joinSystemMessageText(buildSystemPromptState(input))
}
