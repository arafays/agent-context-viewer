/**
 * Vendored from @earendil-works/pi-coding-agent 0.83.0 `dist/utils/paths.js` (MIT).
 * Only the helpers used by the vendored session/context code. See NOTE.md.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a path to its canonical (real) form, following symlinks.
 * Falls back to the raw path if resolution fails (e.g. the target does
 * not exist yet).
 */
export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function normalizePath(input: string, options: { trim?: boolean; expandTilde?: boolean } = {}): string {
  let normalized = options.trim ? input.trim() : input;
  if (options.expandTilde ?? true) {
    const home = homedir();
    if (normalized === "~") return home;
    if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
      return join(home, normalized.slice(2));
    }
  }
  if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
  }
  return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd()): string {
  const normalized = normalizePath(input);
  const normalizedBaseDir = normalizePath(baseDir);
  return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}
