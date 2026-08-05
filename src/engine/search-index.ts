/**
 * Content search index over all sessions, backed by fff (`@ff-labs/fff-bun`).
 *
 * Each session is materialized to a text file under the cache dir
 * (`~/.cache/acv/<tool>/<project>/<sessionId>.txt`) in the single-line format
 * produced by sessionSearchLines(). A single FileFinder instance indexes the
 * cache dir, and `/` fuzzy-greps it.
 *
 * The index is built lazily from the cheap discovery-pass data (session meta
 * + message text), NOT from loadSession(), so opening the app never pays a
 * full-parse cost for every session.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, dirname } from "node:path";
import { FileFinder } from "@ff-labs/fff-bun";
import type { AgentSession, AgentTool, SessionMeta } from "../adapters/types.ts";
import { sessionSearchLines } from "./transcript-lines.ts";

const CACHE_ROOT = "acv";
/** grep files larger than this are skipped (fff default is 10MB). */
const MAX_FILE_SIZE = 2 * 1024 * 1024;

export interface SearchHit {
  tool: AgentTool;
  meta: SessionMeta;
  /** 1-based line number of the matching content line in the search file. */
  lineNo: number;
  /** matched line text (header or content). */
  line: string;
  /** true if the match was on a content line (vs a metadata/header line). */
  isContent: boolean;
  /** turn index encoded in the header line, when parseable. */
  turn: number;
}

export interface SearchIndex {
  ready: boolean;
  error?: string;
  /** build a textual search file for a session; returns lines written or 0. */
  writeSession(meta: SessionMeta, session: AgentSession): number;
  search(query: string, tool?: AgentTool): SearchHit[];
  getCachedText(meta: SessionMeta): string;
  finder?: FileFinder;
  destroy(): void;
}

function getCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() ? process.env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(base, CACHE_ROOT);
}

/** Deterministic per-session filename: <tool>/<project>/<sessionId>.txt */
function sessionFileName(meta: SessionMeta): string {
  const safeProject = (meta.project || meta.cwd || "misc").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "misc";
  const safeId = (meta.id || "session").replace(/[^\w.-]+/g, "_").slice(0, 120) || "session";
  return join(meta.tool, safeProject, `${safeId}.txt`);
}

/** Sanitize a sessionId for use in a path segment (matches sessionFileName). */
function sanitizeId(id: string): string {
  return (id || "session").replace(/[^\w.-]+/g, "_").slice(0, 120) || "session";
}

/** All files currently in the cache dir (tool/project/id.txt). */
function listCacheFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const tool of readdirSync(dir)) {
    const tdir = join(dir, tool);
    let tst;
    try { tst = statSync(tdir); } catch { continue; }
    if (!tst.isDirectory()) continue;
    for (const proj of readdirSync(tdir)) {
      const pdir = join(tdir, proj);
      let pst;
      try { pst = statSync(pdir); } catch { continue; }
      if (!pst.isDirectory()) continue;
      for (const f of readdirSync(pdir)) {
        if (f.endsWith(".txt")) out.push(join(tool, proj, f));
      }
    }
  }
  return out;
}

export interface BuildResult {
  index: SearchIndex;
  /** number of session files written (new or rebuilt). */
  written: number;
  /** number of stale cache files removed. */
  removed: number;
  error?: string;
}

/**
 * Build (or refresh) the search index for the given sessions and return a
 * ready SearchIndex. Runs synchronously; sessions are cheap to serialize
 * because they come from the discovery pass.
 */
export function buildSearchIndex(sessionsByTool: Record<AgentTool, SessionMeta[]>): BuildResult {
  const dir = getCacheDir();
  mkdirSync(dir, { recursive: true });

  const index: SearchIndex = {
    ready: false,
    writeSession(meta, session) {
      const file = join(dir, sessionFileName(meta));
      const lines = sessionSearchLines(meta, session.turns);
      if (lines.length === 0) return 0;
      const text = lines.map((l) => `${l.header}\n${l.content}\n`).join("");
      mkdirSync(dirname(file), { recursive: true });
      // write to a temp sibling then rename so fff's watcher sees one atomic
      // `created` event (avoids indexing a half-written file).
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, file);
      return lines.length;
    },
    search(query, tool) {
      const f = this.finder;
      if (!f) return [];
      const q = query.trim();
      if (!q) return [];
      const g = f.grep(q, { mode: "fuzzy", maxFileSize: MAX_FILE_SIZE, maxMatchesPerFile: 100, pageSize: 100 });
      if (!g.ok) return [];
      const hits: SearchHit[] = [];
      for (const m of g.value.items) {
        const meta = metaForFile(m.relativePath, sessionsByTool);
        if (!meta) continue;
        if (tool && meta.tool !== tool) continue;
        // In our format a message is a header line followed by a content line,
        // so odd line numbers are headers (with [turn N]), even are content.
        const isContent = m.lineNumber % 2 === 0;
        const turn = isContent
          ? turnFromHeader(grepHeaderFor(m.lineNumber, m.relativePath))
          : turnFromHeader(m.lineContent);
        hits.push({
          tool: meta.tool,
          meta,
          lineNo: m.lineNumber,
          line: m.lineContent,
          isContent,
          turn,
        });
      }
      // dedupe: one hit per session, keep the best (lowest lineNo = earliest turn,
      // which is what fff returns first anyway); sort by fff's order preserved.
      const seen = new Set<string>();
      return hits.filter((h) => {
        const key = `${h.meta.tool}:${h.meta.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    getCachedText(meta) {
      const file = join(dir, sessionFileName(meta));
      try { return readFileSync(file, "utf8"); } catch { return ""; }
    },
    destroy() {
      this.finder?.destroy();
      this.finder = undefined;
      this.ready = false;
    },
  };

  // 1. remove stale cache files — but only for tools that were actually
  //    enumerated in this pass. A caller that only discovered pi/claude (or
  //    that passes an explicitly-empty tool array) must not delete files for
  //    tools it didn't enumerate — that would nuke a live index.
  let removed = 0;
  const discoveredTools = new Set(Object.keys(sessionsByTool) as AgentTool[]);
  const wantedFiles = new Map<string, SessionMeta>();
  for (const tool of discoveredTools) {
    for (const meta of sessionsByTool[tool] ?? []) {
      const f = sessionFileName(meta);
      wantedFiles.set(f.slice(0, f.lastIndexOf(".txt")), meta);
    }
  }
  for (const rel of listCacheFiles(dir)) {
    const tool = rel.split("/")[0] as AgentTool;
    if (!discoveredTools.has(tool)) continue; // tool not enumerated → leave cache alone
    const key = rel.slice(0, rel.lastIndexOf(".txt"));
    if (!wantedFiles.has(key)) {
      try { rmSync(join(dir, rel), { force: true }); removed++; } catch { /* ignore */ }
    }
  }

  // 2. write missing sessions from discovery-pass searchText
  let written = 0;
  const metas = [...wantedFiles.values()];
  for (const meta of metas) {
    const file = join(dir, sessionFileName(meta));
    // fresh if the file exists and is non-empty
    let fresh = false;
    try {
      const st = statSync(file);
      fresh = st.size > 0;
    } catch { /* missing */ }
    if (!fresh) {
      // materialize from the discovery-pass searchText (adapters populate it).
      const text = meta.searchText ?? "";
      if (!text) continue;
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      try {
        writeFileSync(tmp, text, "utf8");
        renameSync(tmp, file);
        written++;
      } catch (e) {
        index.error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  // 3. create the fff index
  try {
    const finder = FileFinder.create({
      basePath: dir,
      disableWatch: true,
      disableMmapCache: true,
      aiMode: true,
    });
    if (finder.ok) {
      index.finder = finder.value;
      // warm: wait for the scan so the first grep is fast
      finder.value.waitForScan(5000).catch(() => {});
      index.ready = true;
    } else {
      index.error = finder.error;
    }
  } catch (e) {
    index.error = e instanceof Error ? e.message : String(e);
  }

  return { index, written, removed, error: index.error };
}

/** Extract the `[turn N]` index from a header line. */
function turnFromHeader(header: string): number {
  const m = header.match(/\[turn (\d+)\]/);
  return m ? Number(m[1]) : 0;
}

/**
 * Read the header line (the one before a content line) from a session's cache
 * file so we can recover the turn index of a content-line match.
 */
function grepHeaderFor(contentLineNo: number, rel: string): string {
  if (contentLineNo <= 1) return "";
  const file = join(getCacheDir(), rel);
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    return lines[contentLineNo - 2] ?? "";
  } catch {
    return "";
  }
}

function metaForFile(rel: string, sessionsByTool: Record<AgentTool, SessionMeta[]>): SessionMeta | null {
  // rel = tool/project/id.txt
  const parts = rel.split("/");
  if (parts.length < 3) return null;
  const tool = parts[0] as AgentTool;
  const id = (parts[parts.length - 1] ?? "").replace(/\.txt$/, "");
  const metas = sessionsByTool[tool] ?? [];
  for (const m of metas) if (sanitizeId(m.id) === id) return m;
  return null;
}
