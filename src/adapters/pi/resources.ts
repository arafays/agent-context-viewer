/**
 * Pi prompt *inputs* that live outside the session file: project/user trust,
 * SYSTEM.md / APPEND_SYSTEM.md, and the skill set pi would have loaded.
 *
 * Mirrors pi 0.87.1's *precedence* order, not insertion order —
 * `resourcePrecedenceRank` (dist/core/package-manager.js) sorts resolved skill
 * paths so that "first wins" dedupe picks what pi picks:
 *  0. settings.json `skills` entries  (project `<cwd>/.pi`, trusted only)
 *  1. <cwd>/.pi/skills + ancestor .agents/skills up to git root (trusted only)
 *  2. settings.json `skills` entries  (user `~/.pi/agent`)
 *  3. ~/.pi/agent/skills, then ~/.agents/skills
 *  4. package skills (`npm:` packages; project packages before user packages)
 * Dedupe: realpath first-seen wins, then name collision → first wins — so the
 * order above decides both collision winners and <available_skills> listing order.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { canonicalizePath, resolvePath as normalizeResolvePath } from "../../vendor/pi/paths.ts"
import type { Skill } from "../../vendor/pi/system-prompt.ts"
import { getAgentDir } from "./index.ts"

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

/**
 * pi trusts a project only when trust.json says so (default trust is "ask").
 * Mirrors `findNearestTrustEntry` (dist/core/trust-manager.js): the key is
 * `canonicalizePath(resolvePath(cwd))` and lookup walks up parent directories
 * until the nearest entry with a real decision (null values = deleted → keep
 * walking; no entry anywhere → not trusted).
 */
export function isProjectTrusted(cwd: string, agentDir = getAgentDir()): boolean {
  const trust = readJson<Record<string, boolean | null>>(join(agentDir, "trust.json"))
  if (!trust) return false
  let current = canonicalizePath(normalizeResolvePath(cwd))
  for (;;) {
    const value = trust[current]
    if (value === true || value === false) return value
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export interface PromptSources {
  /** SYSTEM.md content → pi's `customPrompt` (replaces preamble/tools/rules/docs). */
  customPrompt?: string
  /** APPEND_SYSTEM.md content → pi's `appendSystemPrompt` (its own <addendum> section). */
  appendSystemPrompt?: string
  /** Files actually used, for the notes line. */
  files: string[]
}

function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) {
    try {
      if (existsSync(p) && statSync(p).isFile()) return p
    } catch {
      // unreadable → try next
    }
  }
  return undefined
}

/** SYSTEM.md / APPEND_SYSTEM.md: project file wins when the project is trusted, else the agent dir. */
export function loadPromptSources(cwd: string, agentDir = getAgentDir()): PromptSources {
  const trusted = isProjectTrusted(cwd, agentDir)
  const files: string[] = []
  const systemPath = firstExisting(
    trusted ? [join(cwd, ".pi/SYSTEM.md"), join(agentDir, "SYSTEM.md")] : [join(agentDir, "SYSTEM.md")]
  )
  const appendPath = firstExisting(
    trusted
      ? [join(cwd, ".pi/APPEND_SYSTEM.md"), join(agentDir, "APPEND_SYSTEM.md")]
      : [join(agentDir, "APPEND_SYSTEM.md")]
  )
  const sources: PromptSources = { files }
  if (systemPath) {
    files.push(systemPath)
    sources.customPrompt = stripBom(readFileSync(systemPath, "utf8"))
  }
  if (appendPath) {
    files.push(appendPath)
    sources.appendSystemPrompt = stripBom(readFileSync(appendPath, "utf8"))
  }
  return sources
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

interface SkillEntry {
  /** Directory containing SKILL.md (skill root). */
  dir?: string
  /** Direct `.md` child of the root dir (pi's `includeRootFiles` branch). */
  file?: string
}

/** pi discovers `.agents/skills` roots with mode "agents", everything else with mode "pi". */
function skillCollectMode(root: string): "pi" | "agents" {
  return root.endsWith(join(".agents", "skills")) ? "agents" : "pi"
}

/**
 * Collect skill entries under `root`, mirroring `collectSkillEntries`
 * (dist/core/package-manager.js): a SKILL.md at the root wins outright (no
 * recursion, no other entries); otherwise direct `.md` children are loaded as
 * skills — at the ROOT only for mode "pi", at every level BUT the root for
 * mode "agents" — and subdirectories are recursed for SKILL.md. Skips dot-dirs
 * and node_modules; depth cap is a deliberate safety net (pi recurses unbounded).
 */
function collectSkillEntries(root: string, mode: "pi" | "agents", depth = 0): SkillEntry[] {
  if (depth > 4) return []
  if (!isDir(root)) {
    // pi's loadSkills accepts a direct `.md` file path as a skill entry.
    try {
      if (root.endsWith(".md") && statSync(root).isFile()) return [{ file: root }]
    } catch {
      // unreadable → no entries
    }
    return []
  }
  if (existsSync(join(root, "SKILL.md"))) return [{ dir: root }]
  const out: SkillEntry[] = []
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return out
  }
  const includeMd = mode === "pi" ? depth === 0 : depth > 0
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue
    const child = join(root, name)
    if (isDir(child)) {
      out.push(...collectSkillEntries(child, mode, depth + 1))
      continue
    }
    if (includeMd && name.endsWith(".md")) {
      try {
        if (statSync(child).isFile()) out.push({ file: child })
      } catch {
        // unreadable → skip
      }
    }
  }
  return out
}

/** Skill dirs contributed by installed pi packages (settings.json `packages`). */
function packageSkillDirs(agentDir: string): string[] {
  const settings = readJson<{ packages?: unknown[] }>(join(agentDir, "settings.json"))
  const out: string[] = []
  for (const entry of settings?.packages ?? []) {
    if (typeof entry !== "string" || !entry.startsWith("npm:")) continue
    const name = entry.slice("npm:".length)
    const pkgDir = join(agentDir, "npm/node_modules", name)
    const pkg = readJson<{ pi?: { skills?: string[] } }>(join(pkgDir, "package.json"))
    for (const rel of pkg?.pi?.skills ?? []) {
      const dir = join(pkgDir, rel)
      if (isDir(dir)) out.push(dir)
    }
  }
  return out
}

/**
 * Explicit `settings.skills` entries (local paths only; remote ones can't be read cheaply).
 * pi expands a DIRECTORY entry into its `.md` files (`collectResourceFiles` → mode "pi")
 * and treats `!`/`+`/`-` entries as enable/disable patterns; we hand the directory to the
 * skill-root walk instead and ignore patterns — identical results for SKILL.md /
 * root-`.md` layouts, which is all this machine uses (settings.skills is empty here).
 */
function configuredSkillDirs(agentDir: string): string[] {
  const settings = readJson<{ skills?: unknown[] }>(join(agentDir, "settings.json"))
  const out: string[] = []
  for (const entry of settings?.skills ?? []) {
    const raw = typeof entry === "string" ? entry : (entry as { source?: string }).source
    if (!raw || raw.startsWith("npm:") || raw.startsWith("github:") || raw.startsWith("http")) continue
    const clean = raw.replace(/^\+/, "")
    const abs = resolve(agentDir, clean)
    // pi passes both shapes through to loadSkills: a directory loads its
    // SKILL.md / root .md children, a `.md` file loads exactly that file.
    if (existsSync(abs) && (abs.endsWith(".md") || isDir(abs))) out.push(abs)
  }
  return out
}

/** Project `.agents/skills` dirs, walking from cwd up to the git repo root. */
function projectAgentsSkillDirs(cwd: string): string[] {
  const out: string[] = []
  let cur = resolve(cwd)
  for (let i = 0; i < 32; i++) {
    const dir = join(cur, ".agents/skills")
    if (isDir(dir)) out.push(dir)
    if (existsSync(join(cur, ".git"))) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return out
}

/**
 * Candidate skill roots in pi's precedence order (`resourcePrecedenceRank`):
 * project settings → project auto-discovered (trusted only) → user settings →
 * user auto-discovered → package skills. Lower rank loads first, so it wins
 * name collisions and leads the `<available_skills>` listing.
 */
export function skillRoots(cwd: string, agentDir = getAgentDir()): string[] {
  const trusted = isProjectTrusted(cwd, agentDir)
  const projectDir = join(cwd, ".pi")
  const userAgentsSkills = join(homedir(), ".agents/skills")
  return [
    // rank 0 + 1: project resources (settings entries and auto-discovered dirs)
    ...(trusted
      ? [
          ...configuredSkillDirs(projectDir),
          join(projectDir, "skills"),
          // pi's collectAncestorAgentsSkillDirs walks cwd → git root but never
          // claims ~/.agents/skills itself (it is a rank-3 user root instead).
          ...projectAgentsSkillDirs(cwd).filter((dir) => resolve(dir) !== userAgentsSkills)
        ]
      : []),
    // rank 2 + 3: user settings entries, then ~/.pi/agent/skills and ~/.agents/skills
    ...configuredSkillDirs(agentDir),
    join(agentDir, "skills"),
    userAgentsSkills,
    // rank 4: package skills (pi collects project packages before user ones)
    ...(trusted ? packageSkillDirs(projectDir) : []),
    ...packageSkillDirs(agentDir)
  ]
}

export interface PiSkills {
  skills: Skill[]
  /** Skill root directories that contributed at least one skill (for notes). */
  roots: string[]
}

/** Load the skill set pi would have assembled for this cwd. */
export function loadPiSkills(cwd: string, agentDir = getAgentDir()): PiSkills {
  const roots = skillRoots(cwd, agentDir)

  const skills: Skill[] = []
  const usedRoots: string[] = []
  const seenDirs = new Set<string>()
  const seenNames = new Set<string>()
  for (const root of roots) {
    let rootUsed = false
    for (const entry of collectSkillEntries(root, skillCollectMode(root))) {
      const target = entry.file ?? (entry.dir !== undefined ? join(entry.dir, "SKILL.md") : undefined)
      if (target === undefined) continue
      let real: string
      try {
        real = realpathSync(target)
      } catch {
        real = target
      }
      if (seenDirs.has(real)) continue
      seenDirs.add(real)
      const skill = readSkill(target)
      if (!skill || seenNames.has(skill.name)) continue
      seenNames.add(skill.name)
      skills.push(skill)
      rootUsed = true
    }
    if (rootUsed) usedRoots.push(root)
  }
  return { skills, roots: usedRoots }
}

/**
 * Minimal frontmatter parser for SKILL.md (the `yaml` package is not a dependency):
 * `key: value`, quoted values, and `|` / `>` block scalars.
 */
function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {}
  const rest = content.slice(3)
  const newline = rest.startsWith("\r") ? 1 : 0
  const endMatch = rest.slice(newline).match(/\r?\n---[ \t]*(\r?\n|$)/)
  if (!endMatch || endMatch.index === undefined) return {}
  const fmStart = newline + 1
  const fmEnd = newline + endMatch.index + endMatch[0].length
  const block = rest.slice(fmStart, fmEnd)
  const out: Record<string, string> = {}
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    if (key === undefined) continue
    let value = (m[2] ?? "").trim()
    if (/^[|>][-+]?$/.test(value)) {
      // YAML block scalar: keep relative indentation, apply chomping (clip by default).
      const foldedStyle = value.startsWith(">")
      const chomping = value.endsWith("-") ? "strip" : value.endsWith("+") ? "keep" : "clip"
      const collected: string[] = []
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1] ?? "")) {
        i++
        const next = lines[i]
        if (next !== undefined) collected.push(next)
      }
      if (collected.length === 0) {
        value = ""
      } else {
        const indent = Math.min(...collected.map((l) => l.length - l.trimStart().length))
        const stripped = collected.map((l) => l.slice(indent))
        value = foldedStyle ? stripped.join(" ") : stripped.join("\n")
        if (chomping !== "strip") value += "\n"
      }
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1)
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Parse one skill file into a Skill; returns null when description is
 * missing/empty. Mirrors `loadSkillFromFile` (dist/core/skills.js): name comes
 * from frontmatter without extra trimming, falling back to the PARENT DIRECTORY
 * name (for root-level `.md` entries that is the skill root itself).
 */
function readSkill(file: string): Skill | null {
  try {
    if (!existsSync(file)) return null
    const fm = parseFrontmatter(stripBom(readFileSync(file, "utf8")))
    const description = fm.description ?? ""
    if (!description.trim()) return null // pi drops skills without a description
    const name = fm.name || basename(dirname(file))
    const skill: Skill = { name, description, filePath: file }
    if (fm["disable-model-invocation"] === "true") skill.disableModelInvocation = true
    return skill
  } catch {
    return null
  }
}
