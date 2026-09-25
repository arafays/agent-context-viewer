/**
 * Vendored from @earendil-works/pi-coding-agent 0.87.1 (MIT):
 * - `dist/core/resource-loader.js` → `loadProjectContextFiles`, `loadContextFileFromDir`, `findShadowedContextFile`
 * - `dist/core/footer-data-provider.js` → `findGitPaths`
 * - `dist/utils/paths.js` → `canonicalizePath`, `resolvePath`
 * See NOTE.md in this directory.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { canonicalizePath, resolvePath } from "./paths.ts"

export interface ContextFile {
  path: string
  content: string
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function loadContextFileFromDir(dir: string): ContextFile | null {
  const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]
  for (const filename of candidates) {
    const filePath = join(dir, filename)
    if (existsSync(filePath)) {
      try {
        if (!statSync(filePath).isFile()) {
          continue
        }
        return {
          path: filePath,
          content: stripBom(readFileSync(filePath, "utf-8"))
        }
      } catch {
        // unreadable file → try next candidate
      }
    }
  }
  return null
}

/**
 * Locate the git repo containing cwd. Mirrors findGitPaths from footer-data-provider.js.
 * Returns { repoDir, commonGitDir, headPath } or null.
 */
export function findGitPaths(cwd: string): { repoDir: string; commonGitDir: string; headPath: string } | null {
  let dir = cwd
  while (true) {
    const gitPath = join(dir, ".git")
    if (existsSync(gitPath)) {
      try {
        const st = statSync(gitPath)
        if (st.isFile()) {
          const content = readFileSync(gitPath, "utf8").trim()
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice(8).trim())
            const headPath = join(gitDir, "HEAD")
            if (!existsSync(headPath)) return null
            const commonDirPath = join(gitDir, "commondir")
            const commonGitDir = existsSync(commonDirPath)
              ? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
              : gitDir
            return { repoDir: dir, commonGitDir, headPath }
          }
        } else if (st.isDirectory()) {
          const headPath = join(gitPath, "HEAD")
          if (!existsSync(headPath)) return null
          return { repoDir: dir, commonGitDir: gitPath, headPath }
        }
      } catch {
        return null
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both
 * are the same tracked AGENTS.md/CLAUDE.md, so loading both loads it twice.
 */
function findShadowedContextFile(cwd: string): string | undefined {
  const gitPaths = findGitPaths(cwd)
  if (!gitPaths) return undefined
  const commonGitDir = canonicalizePath(gitPaths.commonGitDir)
  const worktreeRoot = canonicalizePath(gitPaths.repoDir)
  const mainRepoRoot = dirname(commonGitDir)
  if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return undefined
  if (canonicalizePath(join(mainRepoRoot, ".git")) !== commonGitDir) return undefined
  const worktreeContextFile = loadContextFileFromDir(worktreeRoot)
  return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined
}

/**
 * Load the project context files for a cwd: the global AGENTS.md in the agent dir,
 * then every AGENTS.md/CLAUDE.md walking up from cwd to the filesystem root.
 * This is the exact list Pi injects into <project_context> in the system prompt.
 */
export function loadProjectContextFiles(options: { cwd: string; agentDir: string }): ContextFile[] {
  const resolvedCwd = resolvePath(options.cwd)
  const resolvedAgentDir = resolvePath(options.agentDir)
  const contextFiles: ContextFile[] = []
  const seenPaths = new Set<string>()
  const globalContext = loadContextFileFromDir(resolvedAgentDir)
  if (globalContext) {
    contextFiles.push(globalContext)
    seenPaths.add(globalContext.path)
  }
  const ancestorContextFiles: ContextFile[] = []
  const shadowedContextFile = findShadowedContextFile(resolvedCwd)
  let currentDir = resolvedCwd
  while (true) {
    const contextFile = loadContextFileFromDir(currentDir)
    const isShadowed =
      shadowedContextFile !== undefined && canonicalizePath(contextFile?.path ?? "") === shadowedContextFile
    if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
      ancestorContextFiles.unshift(contextFile)
      seenPaths.add(contextFile.path)
    }
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }
  contextFiles.push(...ancestorContextFiles)
  return contextFiles
}
