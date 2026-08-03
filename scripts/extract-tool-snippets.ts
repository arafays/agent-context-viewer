/**
 * Extracts per-tool `promptSnippet` / `promptGuidelines` from the installed
 * @earendil-works/pi-coding-agent dist and regenerates
 * `src/vendor/pi/tool-snippets.ts`.
 *
 * Usage: bun run extract-tool-snippets
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function findPiPackageDir(): string | undefined {
  const home = homedir();
  const installRoot = join(home, ".local/share/mise/installs");
  if (!existsSync(installRoot)) return undefined;
  for (const entry of readdirSync(installRoot)) {
    if (!entry.startsWith("npm-earendil-works-pi-coding-agent")) continue;
    const entryPath = join(installRoot, entry);
    // layout: <install>/<name>/<version>/node_modules/@earendil-works/pi-coding-agent
    for (const versionDir of readdirSync(entryPath)) {
      const pkg = join(entryPath, versionDir, "node_modules/@earendil-works/pi-coding-agent");
      if (existsSync(pkg)) return pkg;
    }
  }
  return undefined;
}

interface ToolSnippet {
  name: string;
  snippet?: string;
  guidelines?: string[];
}

function extractFromFile(filePath: string): ToolSnippet | null {
  const src = readFileSync(filePath, "utf8");
  const nameMatch = src.match(/name:\s*"([^"]+)"/);
  const snippetMatch = src.match(/promptSnippet:\s*"([^"]+)"/);
  if (!nameMatch && !snippetMatch) return null;
  const guidelines: string[] = [];
  // matches promptGuidelines: ["a", "b", ...] possibly multi-line
  const gMatch = src.match(/promptGuidelines:\s*\[([\s\S]*?)\]/);
  if (gMatch) {
    const group = gMatch[1] ?? "";
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(group))) {
      const g = m[1];
      if (g) guidelines.push(g.replace(/\\"/g, '"'));
    }
  }
  return {
    name: nameMatch?.[1] ?? filePath.split("/").pop()!.replace(".js", ""),
    snippet: snippetMatch?.[1],
    guidelines,
  };
}

const TOOL_FILES = ["read", "write", "edit", "edit-diff", "bash", "grep", "find", "ls"];

function main(): void {
  const pkgDir = findPiPackageDir();
  if (!pkgDir) {
    console.error("Could not locate installed @earendil-works/pi-coding-agent package.");
    process.exit(1);
  }
  const toolsDir = join(pkgDir, "dist/core/tools");
  const version = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version?: string }).version;

  const entries: Record<string, { snippet?: string; guidelines?: string[] }> = {};
  for (const name of TOOL_FILES) {
    const filePath = join(toolsDir, `${name}.js`);
    if (!existsSync(filePath)) continue;
    const extracted = extractFromFile(filePath);
    if (extracted?.snippet || extracted?.guidelines?.length) {
      entries[extracted.name] = {
        ...(extracted.snippet ? { snippet: extracted.snippet } : {}),
        ...(extracted.guidelines?.length ? { guidelines: extracted.guidelines } : {}),
      };
    }
  }

  const out = `/**
 * GENERATED FILE — do not edit by hand.
 * Per-tool prompt snippets/guidelines extracted from the installed
 * @earendil-works/pi-coding-agent@${version} dist/core/tools/*.js (MIT).
 * Regenerate with: bun run extract-tool-snippets
 */
export const TOOL_PROMPT_SNIPPETS: Record<string, { snippet?: string; guidelines?: string[] }> = ${JSON.stringify(
    entries,
    null,
    2,
  )};
`;

  const outPath = join(process.cwd(), "src/vendor/pi/tool-snippets.ts");
  writeFileSync(outPath, out);
  console.log(`Wrote ${outPath} (${Object.keys(entries).length} tools) from pi@${version}`);
}

main();
