/**
 * Extracts per-tool `promptSnippet` / `promptGuidelines` from the installed
 * @earendil-works/pi-coding-agent dist and regenerates
 * `src/vendor/pi/tool-snippets.ts`.
 *
 * Source of truth: pi's own `dist/core/tools/index.js` → `createAllToolDefinitions(cwd, {})`,
 * which is what `agent-session` registers tools from. A static file-glob regex is no longer
 * enough since pi 0.87 defines snippets as exported `*ToolSystemPromptContribution` objects.
 * Falls back to reading `dist/core/tools/<name>.js` files directly when the import fails.
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

/** Fallback for old (pre-contribution) tool files: read name/promptSnippet/promptGuidelines literally. */
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

const TOOL_FILES = ["read", "write", "edit", "edit-diff", "bash", "grep", "find", "ls", "powershell"];

/** Preferred path: ask pi's own factory for every registered tool definition. */
async function extractFromDist(pkgDir: string): Promise<ToolSnippet[]> {
  const indexJs = join(pkgDir, "dist/core/tools/index.js");
  if (!existsSync(indexJs)) throw new Error(`missing ${indexJs}`);
  const mod: {
    createAllToolDefinitions?: (
      cwd: string,
      options: Record<string, unknown>,
    ) => Record<string, { promptSnippet?: string; promptGuidelines?: string[] }>;
  } = await import(indexJs);
  if (typeof mod.createAllToolDefinitions !== "function") {
    throw new Error("dist/core/tools/index.js has no createAllToolDefinitions export");
  }
  const defs = mod.createAllToolDefinitions(process.cwd(), {});
  return Object.entries(defs).map(([name, def]) => ({
    name,
    ...(def.promptSnippet ? { snippet: def.promptSnippet } : {}),
    ...(def.promptGuidelines?.length ? { guidelines: [...def.promptGuidelines] } : {}),
  }));
}

function extractFromFiles(toolsDir: string): ToolSnippet[] {
  const out: ToolSnippet[] = [];
  for (const name of TOOL_FILES) {
    const filePath = join(toolsDir, `${name}.js`);
    if (!existsSync(filePath)) continue;
    const extracted = extractFromFile(filePath);
    if (extracted?.snippet || extracted?.guidelines?.length) out.push(extracted);
  }
  return out;
}

async function main(): Promise<void> {
  const pkgDir = findPiPackageDir();
  if (!pkgDir) {
    console.error("Could not locate installed @earendil-works/pi-coding-agent package.");
    process.exit(1);
  }
  const version = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version?: string }).version;

  let snippets: ToolSnippet[];
  let via: string;
  try {
    snippets = await extractFromDist(pkgDir);
    via = "createAllToolDefinitions";
  } catch (err) {
    console.warn(`createAllToolDefinitions failed (${String(err)}); falling back to file scan`);
    snippets = extractFromFiles(join(pkgDir, "dist/core/tools"));
    via = "file scan";
  }

  const entries: Record<string, { snippet?: string; guidelines?: string[] }> = {};
  for (const { name, snippet, guidelines } of snippets) {
    if (!snippet && !guidelines?.length) continue;
    entries[name] = {
      ...(snippet ? { snippet } : {}),
      ...(guidelines?.length ? { guidelines } : {}),
    };
  }

  const out = `/**
 * GENERATED FILE — do not edit by hand.
 * Per-tool prompt snippets/guidelines extracted from the installed
 * @earendil-works/pi-coding-agent@${version} dist/core/tools/index.js (MIT, ${via}).
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

await main();
