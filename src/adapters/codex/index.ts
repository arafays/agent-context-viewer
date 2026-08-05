/**
 * Codex adapter — reads sessions from ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl.
 *
 * Codex stores EVERYTHING inline per session file, so nothing needs reconstruction:
 *   - session_meta.base_instructions.text  → the exact system prompt
 *   - developer-role messages              → permissions instructions, multi-agent mode
 *   - user-role messages                   → AGENTS.md, skills, real prompts (embedded!)
 *   - response_item (message/reasoning/tool calls) + event_msg token_count → per-request usage
 *   - turn_context                          → model, effort, sandbox per turn
 */
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SearchFileBuilder } from "../../engine/transcript-lines.ts";
import type {
  AgentSession,
  ContextFile,
  ContextPoint,
  NormalizedMessage,
  SessionContextInfo,
  SessionEventView,
  SessionMeta,
  Turn,
  UsageTotals,
} from "../types.ts";

const SCAN_BYTES = 64 * 1024;
const zeroUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

export function getSessionsDir(): string {
  const root = process.env.CODEX_HOME ? process.env.CODEX_HOME : join(homedir(), ".codex");
  return join(root, "sessions");
}

type RawEvent = {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
};

function parseLine(line: string): RawEvent | null {
  try {
    const o = JSON.parse(line) as RawEvent;
    if (o && typeof o === "object") return o;
  } catch {
    /* tolerate malformed lines */
  }
  return null;
}

function readFirstLine(path: string): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(SCAN_BYTES);
      const n = readSync(fd, buf, 0, SCAN_BYTES, 0);
      const text = buf.subarray(0, n).toString("utf8");
      const nl = text.indexOf("\n");
      return nl === -1 ? text : text.slice(0, nl);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function walkSessionFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkSessionFiles(full, out);
    else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
  }
}

/** Cheap per-file counters for discovery (no full parse). */
function countKinds(path: string): {
  messageCount: number;
  user: number;
  assistant: number;
  toolResults: number;
} {
  let messageCount = 0;
  let user = 0;
  let assistant = 0;
  let toolResults = 0;
  try {
    const text = readFileAll(path);
    for (const m of text.matchAll(/"type":"response_item"/g)) {
      messageCount++;
      const window = text.slice(m.index! - 200, m.index! + 200);
      if (/"role":"user"/.test(window)) user++;
      else if (/"role":"assistant"/.test(window)) assistant++;
      else if (/"type":"(?:custom_)?tool_call_output"/.test(window)) toolResults++;
    }
  } catch {
    /* ignore */
  }
  return { messageCount, user, assistant, toolResults };
}

function readFileAll(path: string): string {
  const fd = openSync(path, "r");
  try {
    const st = statSync(path);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function discoverSessions(): SessionMeta[] {
  const dir = getSessionsDir();
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  walkSessionFiles(dir, files);
  const metas: SessionMeta[] = [];
  for (const path of files) {
    try {
      const st = statSync(path);
      const header = parseLine(readFirstLine(path));
      const payload = header?.payload ?? {};
      const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
      const id =
        typeof payload.id === "string"
          ? payload.id
          : basename(path).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
      const counts = countKinds(path);
      const project = cwd.split("/").filter(Boolean).pop() ?? "unknown";
      const metaBase: SessionMeta = {
        tool: "codex",
        id,
        path,
        cwd,
        project,
        startedAt: typeof payload.timestamp === "string" ? payload.timestamp : st.mtime.toISOString(),
        updatedAt: st.mtime.toISOString(),
        sizeBytes: st.size,
        name: project,
        model: undefined,
        messageCount: counts.messageCount,
        userMessages: counts.user,
        assistantMessages: counts.assistant,
        toolResults: counts.toolResults,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compactionCount: 0,
        customTypes: [],
      };
      const searchText = buildSearchText(metaBase, readFileAll(path));
      metas.push({
        ...metaBase,
        ...(searchText ? { searchText } : {}),
      });
    } catch {
      /* skip unreadable */
    }
  }
  metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return metas;
}

/**
 * Searchable text for the fuzzy index, in the header/content line format.
 * Codex embeds AGENTS.md + skills as user-role messages; we skip those
 * (noise for content search) and keep real prompts + assistant replies.
 */
function buildSearchText(meta: SessionMeta, text: string): string {
  const b = SearchFileBuilder.start(meta);
  let turn = 0;
  for (const line of text.split("\n")) {
    const ev = parseLine(line);
    if (!ev) continue;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.type !== "response_item" || p.type !== "message") continue;
    const role = p.role as string | undefined;
    const blocks = (p.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
    const t = blocks.map((x) => (typeof x.text === "string" ? x.text : "")).join("\n").trim();
    if (!t) continue;
    if (role === "user" && !t.startsWith("# AGENTS.md instructions for") && !t.trimStart().startsWith("<skill>")) {
      b.emit(turn, "user", t);
    } else if (role === "assistant") {
      b.emit(turn, "assistant", t);
    } else if (role === "developer") {
      b.emit(turn, "developer", t);
    }
    if (role === "user") turn++;
  }
  return b.toString();
}

// ---------------------------------------------------------------------------
// full load
// ---------------------------------------------------------------------------

type ItemKind = "developer" | "user" | "assistant" | "reasoning" | "tool_call" | "tool_output";

interface Item {
  line: number;
  kind: ItemKind;
  text?: string;
  summary?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  timestamp: number;
}

interface RequestUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface CodexParse {
  meta: SessionMeta;
  items: Item[];
  turns: Array<{ index: number; startLine: number; endLine: number; turnId?: string; model?: string; effort?: string }>;
  requests: Array<{
    line: number; // token_count line
    usage: RequestUsage;
    model: string | null;
  }>;
  systemPrompt: string;
  basePath: string;
  git: { branch?: string; repo?: string };
  contextFiles: ContextFile[];
  skills: Array<{ name: string; description: string; filePath: string }>;
  modelProvider: string;
  events: SessionEventView[];
  modelPerTurn: Map<number, string>; // turn index -> model (from turn_context)
}

function isoToEpoch(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? fallback : t;
}

export function loadSession(path: string): AgentSession {
  const st = statSync(path);
  const fd = openSync(path, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }

  const events: SessionEventView[] = [];
  const items: Item[] = [];
  const turnSpans: Array<{ index: number; startLine: number; endLine: number; turnId?: string; model?: string; effort?: string }> = [];
  const requests: CodexParse["requests"] = [];
  const contextFiles: ContextFile[] = [];
  const skills: CodexParse["skills"] = [];
  const modelPerTurn = new Map<number, string>();

  let basePath = "";
  let systemPrompt = "";
  let git: { branch?: string; repo?: string } = {};
  let modelProvider = "";
  let id = basename(path).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
  let startedAt = st.mtime.toISOString();
  let model: string | null = null;
  let currentTurn: number | null = null;
  let lastTurnId = "";

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ev = parseLine(lines[i] ?? "");
    if (!ev) continue;
    const lineNo = i + 1;
    const ts = isoToEpoch(ev.timestamp, st.mtime.getTime());
    const p = (ev.payload ?? {}) as Record<string, unknown>;

    switch (ev.type) {
      case "session_meta": {
        id = typeof p.id === "string" ? p.id : id;
        if (typeof p.cwd === "string") basePath = p.cwd;
        if (typeof p.timestamp === "string") startedAt = p.timestamp;
        if (typeof p.model_provider === "string") modelProvider = p.model_provider;
        const bi = p.base_instructions as { text?: string } | undefined;
        if (bi && typeof bi.text === "string") systemPrompt = bi.text;
        const g = p.git as { branch?: string; repository_url?: string } | undefined;
        if (g) {
          git = { branch: g.branch, repo: g.repository_url };
        }
        break;
      }
      case "event_msg": {
        const kind = p.type as string | undefined;
        if (kind === "task_started") {
          currentTurn = turnSpans.length;
          turnSpans.push({
            index: currentTurn,
            startLine: lineNo,
            endLine: lineNo,
            turnId: typeof p.turn_id === "string" ? p.turn_id : undefined,
          });
        } else if (kind === "task_complete") {
          if (currentTurn !== null) turnSpans[currentTurn]!.endLine = lineNo;
        } else if (kind === "token_count") {
          const info = p.info as { last_token_usage?: Record<string, number>; total_token_usage?: Record<string, number> } | undefined;
          const u = info?.last_token_usage ?? info?.total_token_usage;
          if (u) {
            const input = num(u.input_tokens);
            const cacheRead = num(u.cached_input_tokens);
            requests.push({
              line: lineNo,
              usage: {
                input,
                output: num(u.output_tokens),
                cacheRead,
                cacheWrite: num(u.cache_write_input_tokens),
              },
              model,
            });
          }
        } else if (kind === "thread_settings_applied") {
          events.push({ kind: "custom", timestamp: ts, detail: "thread settings applied" });
        }
        break;
      }
      case "turn_context": {
        const m = typeof p.model === "string" ? p.model : null;
        if (m && currentTurn !== null) {
          modelPerTurn.set(currentTurn, m);
          if (m !== model) {
            model = m;
            events.push({ kind: "model_change", timestamp: ts, detail: m });
          }
        }
        if (currentTurn !== null) {
          const t = turnSpans[currentTurn]!;
          if (typeof p.effort === "string") t.effort = p.effort;
          if (typeof p.model === "string") t.model = p.model;
        }
        break;
      }
      case "response_item": {
        const rtype = p.type as string | undefined;
        const role = p.role as string | undefined;
        if (rtype === "message" && (role === "developer" || role === "user" || role === "assistant")) {
          const blocks = (p.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
          const text = blocks
            .map((b) => (typeof b.text === "string" ? b.text : ""))
            .join("\n")
            .trim();
          if (role === "developer") {
            items.push({ line: lineNo, kind: "developer", text, timestamp: ts });
            // permissions instructions / multi-agent mode → context note
          } else if (role === "user") {
            items.push({ line: lineNo, kind: "user", text, timestamp: ts });
            // AGENTS.md is embedded as a user message: "# AGENTS.md instructions for <path>"
            const am = text.match(/^# AGENTS\.md instructions for (.+)$/m);
            if (am && am[1]) {
              const content = text.slice(text.indexOf("\n") + 1).trim();
              contextFiles.push({
                path: am[1],
                content,
                global: am[1].startsWith(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")),
              });
            }
            // skills embedded as <skill><name>…</name></skill>
            for (const m of text.matchAll(/<skill>\s*<name>([^<]+)<\/name>[\s\S]*?<path>([^<]+)<\/path>/g)) {
              skills.push({ name: m[1]!.trim(), description: "", filePath: m[2]!.trim() });
            }
            for (const m of text.matchAll(/<skill>\s*<name>([^<]+)<\/name>/g)) {
              if (!skills.some((s) => s.name === m[1]!.trim())) {
                skills.push({ name: m[1]!.trim(), description: "", filePath: "" });
              }
            }
          } else {
            items.push({ line: lineNo, kind: "assistant", text, timestamp: ts });
          }
        } else if (rtype === "reasoning") {
          const summary = typeof p.summary === "string" ? p.summary : "";
          const content = p.content as Array<{ type?: string; text?: string }> | undefined;
          const full = content
            ?.map((b) => (typeof b.text === "string" ? b.text : ""))
            .join("\n")
            .trim();
          items.push({ line: lineNo, kind: "reasoning", text: full, summary, timestamp: ts });
        } else if (rtype === "custom_tool_call" || rtype === "function_call") {
          const input = p.input ?? p.arguments;
          items.push({
            line: lineNo,
            kind: "tool_call",
            toolName: typeof p.name === "string" ? p.name : "tool",
            toolCallId: typeof p.call_id === "string" ? p.call_id : `call-${lineNo}`,
            input,
            timestamp: ts,
          });
        } else if (rtype === "custom_tool_call_output" || rtype === "function_call_output") {
          items.push({
            line: lineNo,
            kind: "tool_output",
            toolCallId: typeof p.call_id === "string" ? p.call_id : undefined,
            output: p.output,
            isError: p.is_error === true || p.isError === true,
            timestamp: ts,
          });
        }
        break;
      }
      case "world_state":
      default:
        break;
    }
  }

  // ---- derive turns (items within each task_started span) ----
  const turns: Turn[] = [];
  const toolNames = new Set<string>();
  for (const item of items) {
    if (item.kind === "tool_call" && item.toolName) toolNames.add(item.toolName);
  }

  const turnOfItem = (line: number): number => {
    let idx = -1;
    for (const t of turnSpans) {
      if (line >= t.startLine && line <= t.endLine) idx = t.index;
    }
    // fallback: nearest preceding task_started
    if (idx === -1) {
      for (const t of turnSpans) {
        if (line >= t.startLine) idx = t.index;
      }
    }
    return idx;
  };

  const itemToMessage = (item: Item): NormalizedMessage => {
    const blocks: NormalizedMessage["blocks"] = [];
    if (item.kind === "tool_call") {
      blocks.push({
        kind: "tool_use",
        toolName: item.toolName,
        toolCallId: item.toolCallId,
        input: item.input,
      });
    } else if (item.kind === "tool_output") {
      blocks.push({
        kind: "tool_result",
        toolCallId: item.toolCallId,
        text: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        isError: item.isError,
      });
    } else if (item.kind === "reasoning") {
      blocks.push({ kind: "thinking", text: item.summary || item.text || "" });
    } else {
      blocks.push({ kind: "text", text: item.text ?? "" });
    }
    return {
      role:
        item.kind === "developer"
          ? "developer"
          : item.kind === "user"
            ? "user"
            : item.kind === "assistant"
              ? "assistant"
              : item.kind === "tool_call"
                ? "assistant"
                : "toolResult",
      timestamp: item.timestamp,
      blocks,
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      isError: item.isError,
      entryIndex: item.line,
    };
  };

  // group items per turn (for transcript)
  const perTurn: Item[][] = [];
  for (const item of items) {
    const idx = turnOfItem(item.line);
    if (idx === -1) continue;
    while (perTurn.length <= idx) perTurn.push([]);
    perTurn[idx]!.push(item);
  }

  for (let ti = 0; ti < perTurn.length; ti++) {
    const group = perTurn[ti] ?? [];
    const span = turnSpans[ti];
    const userItems = group.filter((g) => g.kind === "user");
    // pick the real prompt: last user message that isn't an AGENTS.md/skill injection
    const realPrompt =
      [...userItems]
        .reverse()
        .find(
          (g) =>
            !g.text?.startsWith("# AGENTS.md instructions for") && !g.text?.trimStart().startsWith("<skill>"),
        ) ?? userItems[userItems.length - 1];
    const userMessage = realPrompt ? itemToMessage(realPrompt) : null;
    const turn: Turn = {
      index: ti,
      timestamp: userMessage?.timestamp ?? (span ? isoToEpoch(undefined, st.mtime.getTime()) : 0),
      userMessage,
      assistantCalls: [],
      toolResults: [],
      events: [],
      usage: zeroUsage(),
      model: span?.model ?? modelPerTurn.get(ti) ?? null,
      thinkingLevel: span?.effort ?? null,
      entryStart: span?.startLine ?? 0,
      entryEnd: span?.endLine ?? 0,
    };
    for (const item of group) {
      if (item.kind === "tool_output") turn.toolResults.push(itemToMessage(item));
    }
    // AGENTS.md loaded this turn → surface as event
    for (const item of group) {
      if (item.kind === "user" && item.text?.startsWith("# AGENTS.md instructions for")) {
        turn.events.push({ kind: "custom", timestamp: item.timestamp, detail: "AGENTS.md loaded (inline in session)" });
      }
      if (item.kind === "developer" && item.text?.startsWith("<permissions instructions>")) {
        turn.events.push({ kind: "custom", timestamp: item.timestamp, detail: "permissions instructions loaded (inline)" });
      }
    }
    turns.push(turn);
  }

  // ---- assistantCalls + context points (one per token_count) ----
  const assistantCalls: NormalizedMessage[] = [];
  const contextPoints: ContextPoint[] = [];
  const allItemsByLine = items; // already in file order
  const itemsBefore = (line: number) => allItemsByLine.filter((it) => it.line < line);

  let requestIndex = 0;
  let prevRequestLine = 0;
  for (const req of requests) {
    // first output item (reasoning or assistant) after the previous request
    const firstOutput = allItemsByLine.find(
      (it) => it.line > prevRequestLine && (it.kind === "reasoning" || it.kind === "assistant"),
    );
    if (!firstOutput) {
      prevRequestLine = req.line;
      continue;
    }
    const before = itemsBefore(firstOutput.line);
    const contextMessages = before.map(itemToMessage);
    const contextTokens = req.usage.input + req.usage.cacheRead;
    const turnIndex = Math.max(0, turnOfItem(req.line));
    const usage: UsageTotals = { ...req.usage, total: req.usage.input + req.usage.output + req.usage.cacheRead + req.usage.cacheWrite };
    const modelStr = req.model ?? modelPerTurn.get(turnIndex) ?? null;

    // the request's output messages (assistant text + reasoning between firstOutput and req.line)
    const outItems = allItemsByLine.filter(
      (it) => it.line >= firstOutput.line && it.line <= req.line && (it.kind === "assistant" || it.kind === "reasoning"),
    );
    const outBlocks: NormalizedMessage["blocks"] = [];
    for (const o of outItems) {
      if (o.kind === "reasoning") outBlocks.push({ kind: "thinking", text: o.summary || o.text || "" });
      else outBlocks.push({ kind: "text", text: o.text ?? "" });
    }
    const call: NormalizedMessage = {
      role: "assistant",
      timestamp: firstOutput.timestamp,
      blocks: outBlocks,
      usage,
      model: modelStr ?? undefined,
      entryIndex: firstOutput.line,
    };
    assistantCalls.push(call);
    if (turns[turnIndex]) {
      turns[turnIndex]!.assistantCalls.push(call);
      turns[turnIndex]!.usage.input += usage.input;
      turns[turnIndex]!.usage.output += usage.output;
      turns[turnIndex]!.usage.cacheRead += usage.cacheRead;
      turns[turnIndex]!.usage.cacheWrite += usage.cacheWrite;
      turns[turnIndex]!.usage.total += usage.total;
    }

    contextPoints.push({
      requestIndex: requestIndex++,
      turnIndex,
      timestamp: firstOutput.timestamp,
      model: modelStr,
      thinkingLevel: turns[turnIndex]?.thinkingLevel ?? null,
      usage,
      contextTokens,
      systemPrompt,
      contextMessages,
    });
    prevRequestLine = req.line;
  }

  // ---- meta ----
  const project = basePath.split("/").filter(Boolean).pop() ?? "unknown";
  const meta: SessionMeta = {
    tool: "codex",
    id,
    path,
    cwd: basePath,
    project,
    startedAt,
    updatedAt: st.mtime.toISOString(),
    sizeBytes: st.size,
    name: project,
    model: (modelPerTurn.size > 0 ? [...modelPerTurn.values()][modelPerTurn.size - 1] : model) ?? undefined,
    thinkingLevel: undefined,
    messageCount: items.length,
    userMessages: items.filter((i) => i.kind === "user").length,
    assistantMessages: items.filter((i) => i.kind === "assistant").length,
    toolResults: items.filter((i) => i.kind === "tool_output").length,
    tokens: {
      input: assistantCalls.reduce((s, c) => s + (c.usage?.input ?? 0), 0),
      output: assistantCalls.reduce((s, c) => s + (c.usage?.output ?? 0), 0),
      cacheRead: assistantCalls.reduce((s, c) => s + (c.usage?.cacheRead ?? 0), 0),
      cacheWrite: assistantCalls.reduce((s, c) => s + (c.usage?.cacheWrite ?? 0), 0),
    },
    compactionCount: 0,
    customTypes: [],
  };

  const notes = [
    "system prompt stored inline (session_meta.base_instructions) — exact",
    "AGENTS.md, skills & permissions embedded as developer/user messages — exact",
    `model provider: ${modelProvider || "unknown"}${git.branch ? ` · branch ${git.branch}` : ""}`,
  ];
  if (git.repo) notes.push(`repo: ${git.repo}`);
  const contextInfo: SessionContextInfo = {
    systemPrompt,
    contextFiles,
    skills,
    tools: [...toolNames].sort(),
    reconstructed: false,
    notes,
  };

  return {
    meta,
    turns,
    events: [...events, ...turns.flatMap((t) => t.events)],
    assistantCalls,
    contextInfo,
    contextPoints,
    name: project,
    raw: { items, requests },
  } satisfies AgentSession;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
