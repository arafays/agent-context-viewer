/**
 * Pi adapter — reads sessions from ~/.pi/agent/sessions/<slug>/<ts>_<uuid>.jsonl
 * and reconstructs context using the vendored Pi pure functions.
 */
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  AgentSession,
  ContentBlockView,
  NormalizedMessage,
  SessionEventView,
  SessionMeta,
  Turn,
  UsageTotals,
} from "../types.ts";
import { buildContextPoints, buildSessionContextInfo } from "./context.ts";
import { loadEntriesFromFile, buildSessionContext } from "../../vendor/pi/session-context.ts";
import { SearchFileBuilder } from "../../engine/transcript-lines.ts";
import type { AgentMessage, FileEntry, SessionEntry } from "../../vendor/pi/types.ts";

const SESSION_HEADER_SCAN_BYTES = 64 * 1024;

export function getAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env;
  return join(homedir(), ".pi", "agent");
}

export function getSessionsDir(): string {
  const env = process.env.PI_CODING_AGENT_SESSIONS_DIR;
  if (env) return env;
  return join(getAgentDir(), "sessions");
}

/** Decode a session dir slug like `--home-arafays-projects--` into a display label. */
export function decodeSlug(slug: string): string {
  const inner = slug.replace(/^--/, "").replace(/--$/, "");
  const segments = inner.split("-").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return slug;
  const isHexish = /^[a-f0-9]{6,}$/i.test(last);
  return isHexish ? segments.slice(0, -1).join("/") || slug : inner.replace(/-/g, "/");
}

function parseHeaderLine(line: string): { id?: string; timestamp?: string; cwd?: string } | null {
  try {
    const obj = JSON.parse(line);
    if (obj?.type === "session") return obj;
    return null;
  } catch {
    return null;
  }
}

/** Fast header scan: read the first JSON line only (no full-file parse). */
export function readSessionHeaderFast(filePath: string): { id: string; timestamp: string; cwd: string } | null {
  try {
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(SESSION_HEADER_SCAN_BYTES);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const newline = text.indexOf("\n");
      const firstLine = newline === -1 ? text : text.slice(0, newline);
      const header = parseHeaderLine(firstLine);
      if (!header?.id) return null;
      return {
        id: header.id,
        timestamp: header.timestamp ?? "",
        cwd: header.cwd ?? "",
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Discover all Pi sessions across every project slug dir. */
export function discoverSessions(): SessionMeta[] {
  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) return [];
  const metas: SessionMeta[] = [];
  for (const slug of readdirSync(sessionsDir)) {
    const dir = join(sessionsDir, slug);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      let fst;
      try {
        fst = statSync(path);
      } catch {
        continue;
      }
      const header = readSessionHeaderFast(path);
      if (!header) continue;
      metas.push(metaFromHeader(path, slug, header, fst));
    }
  }
  metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return metas;
}

function metaFromHeader(
  path: string,
  slug: string,
  header: { id: string; timestamp: string; cwd: string },
  st: Stats,
): SessionMeta {
  const base: SessionMeta = {
    tool: "pi",
    id: header.id,
    path,
    cwd: header.cwd,
    project: decodeSlug(slug),
    startedAt: header.timestamp,
    updatedAt: st.mtime.toISOString(),
    sizeBytes: st.size,
    messageCount: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactionCount: 0,
    customTypes: [],
  };
  try {
    const entries = loadEntriesFromFile(path) as SessionEntry[];
    const stats = summarizeEntries(entries);
    const searchText = buildSearchText(base, entries);
    return { ...base, ...stats, ...(searchText ? { searchText } : {}) };
  } catch {
    return base;
  }
}

/**
 * Cheap searchable text for the fuzzy index, in the header/content line format
 * (`[tool] [project] [model] [date] [turn N] tag` / collapsed content). Built
 * during discovery's single parse pass so we never need loadSession for it.
 */
function buildSearchText(meta: SessionMeta, entries: SessionEntry[]): string {
  const b = SearchFileBuilder.start(meta);
  let turn = 0;
  let currentTag = "";
  let currentContent: string[] = [];
  const flush = () => {
    if (currentContent.length > 0) {
      b.emit(turn, currentTag, currentContent.join("\n"));
    }
    currentContent = [];
  };
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message as AgentMessage;
    const role = msg.role;
    const text = (() => {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .map((c) => {
            const cb = c as { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown };
            if (cb.type === "text") return cb.text ?? "";
            if (cb.type === "thinking") return cb.thinking ?? cb.text ?? "";
            if (cb.type === "tool_use") return `tool call: ${cb.name ?? "tool"} ${JSON.stringify(cb.input ?? "")}`;
            if (cb.type === "tool_result") {
              const inner = Array.isArray(cb.content)
                ? (cb.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n")
                : typeof cb.content === "string" ? cb.content : "";
              return inner;
            }
            return "";
          })
          .join("\n");
      }
      return "";
    })();
    if (role === "user" || role === "assistant") {
      flush();
      currentTag = role === "user" ? "user" : "assistant";
      currentContent = [text];
    } else if (role === "toolResult") {
      if (text) b.emit(turn, "tool result", text);
    } else if (msg.role === "bashExecution") {
      const cmd = typeof msg.command === "string" ? msg.command : "";
      const out = typeof msg.output === "string" ? msg.output : "";
      b.emit(turn, "bash exec", `$$ ${cmd}\n${out}`);
    }
    if (role === "user") turn++;
  }
  flush();
  return b.toString();
}

function summarizeEntries(entries: SessionEntry[]) {
  let messageCount = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;
  let compactionCount = 0;
  let model: string | undefined;
  let thinkingLevel: string | undefined;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const customTypes = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type === "message") {
      messageCount++;
      const role = entry.message.role;
      if (role === "user") userMessages++;
      else if (role === "assistant") {
        assistantMessages++;
        const u = entry.message.usage as
          | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
          | undefined;
        if (u) {
          tokens.input += u.input ?? 0;
          tokens.output += u.output ?? 0;
          tokens.cacheRead += u.cacheRead ?? 0;
          tokens.cacheWrite += u.cacheWrite ?? 0;
        }
        if (entry.message.model) model = `${entry.message.provider ?? ""}/${entry.message.model}`;
      } else if (role === "toolResult") toolResults++;
    } else if (entry.type === "model_change") {
      model = `${entry.provider}/${entry.modelId}`;
    } else if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "compaction") {
      compactionCount++;
    } else if (entry.type === "custom") {
      customTypes.set(entry.customType, (customTypes.get(entry.customType) ?? 0) + 1);
    }
  }
  return {
    messageCount,
    userMessages,
    assistantMessages,
    toolResults,
    compactionCount,
    model,
    thinkingLevel,
    tokens,
    customTypes: Array.from(customTypes.entries()).map(([type, count]) => ({ type, count })),
  };
}

// ---------------------------------------------------------------------------
// Full session parse
// ---------------------------------------------------------------------------

/** Backwards-compatible alias — the shared session type now lives in types.ts. */
export type PiSession = AgentSession;

type IndexedEntry = SessionEntry & { _index: number };

function blockView(block: { type?: string; [k: string]: unknown }): ContentBlockView {
  switch (block.type) {
    case "text":
      return { kind: "text", text: typeof block.text === "string" ? block.text : "" };
    case "thinking":
      return { kind: "thinking", text: typeof block.thinking === "string" ? block.thinking : "" };
    case "reasoning":
      return { kind: "reasoning", text: typeof block.text === "string" ? block.text : "" };
    case "tool_use":
    case "toolCall":
      return {
        kind: "tool_use",
        toolName: typeof block.name === "string" ? block.name : undefined,
        toolCallId: typeof block.id === "string" ? block.id : undefined,
        // Pi assistant toolCall blocks store args under `arguments`; Anthropic-style under `input`.
        input: block.input ?? block.arguments,
      };
    case "tool_result": {
      const content = block.content;
      const text = Array.isArray(content)
        ? content
            .map((c: { text?: string }) => (typeof c === "object" && c ? c.text ?? "" : String(c)))
            .join("\n")
        : typeof content === "string"
          ? content
          : "";
      return {
        kind: "tool_result",
        text,
        toolCallId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        isError: block.is_error === true,
      };
    }
    case "image":
      return { kind: "image" };
    default:
      return { kind: "unknown", text: JSON.stringify(block).slice(0, 500) };
  }
}

function messageBlocks(message: AgentMessage): ContentBlockView[] {
  const content = message.content;
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((c) => blockView(c as { type?: string; [k: string]: unknown }));
}

function toNormalizedMessage(entry: SessionMessageEntryLike): NormalizedMessage {
  const msg = entry.message;
  const usage = msg.usage as UsageTotals | undefined;
  return {
    role: msg.role === "toolResult" ? "toolResult" : msg.role === "assistant" ? "assistant" : "user",
    timestamp: entryTimestamp(entry, msg),
    blocks: messageBlocks(msg),
    provider: typeof msg.provider === "string" ? msg.provider : undefined,
    model: typeof msg.model === "string" ? msg.model : undefined,
    usage: usage
      ? {
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          total: usage.total ?? (usage.input ?? 0) + (usage.output ?? 0),
        }
      : undefined,
    stopReason: typeof msg.stopReason === "string" ? msg.stopReason : undefined,
    toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
    toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
    isError: msg.isError === true,
    customType: typeof msg.customType === "string" ? msg.customType : undefined,
    summary: typeof msg.summary === "string" ? msg.summary : undefined,
    tokensBefore: typeof msg.tokensBefore === "number" ? msg.tokensBefore : undefined,
    entryIndex: entry._index,
  };
}

type SessionMessageEntryLike = SessionEntry & {
  message: AgentMessage;
  _index: number;
  customType?: string;
  display?: boolean;
  details?: unknown;
};

function entryTimestamp(entry: SessionEntry, msg?: AgentMessage): number {
  if (typeof msg?.timestamp === "number") return msg.timestamp;
  const t = new Date(entry.timestamp).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Load and fully parse a Pi session file. */
export function loadSession(path: string): PiSession {
  const raw = loadEntriesFromFile(path) as FileEntry[];
  const header = raw[0];
  if (!header || header.type !== "session") {
    throw new Error(`Not a valid Pi session file: ${path}`);
  }
  const entries = raw.slice(1) as SessionEntry[];
  // annotate entry indices
  const indexed: IndexedEntry[] = entries.map((e, i) => ({ ...e, _index: i + 1 } as IndexedEntry));

  const turns: Turn[] = [];
  const events: SessionEventView[] = [];
  const assistantCalls: NormalizedMessage[] = [];
  let name: string | undefined;
  let currentModel: string | null = null;
  let currentThinking: string | null = null;
  let currentTurn: Turn | null = null;

  const ensureTurn = (timestamp: number): Turn => {
    if (!currentTurn) {
      const t: Turn = {
        index: turns.length,
        timestamp,
        userMessage: null,
        assistantCalls: [],
        toolResults: [],
        events: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        model: currentModel,
        thinkingLevel: currentThinking,
        entryStart: 0,
        entryEnd: 0,
      };
      currentTurn = t;
      turns.push(t);
      return t;
    }
    return currentTurn;
  };

  for (const entry of indexed) {
    if (entry.type === "message") {
      const msg = entry.message as AgentMessage;
      const ts = entryTimestamp(entry, msg);
      const norm = toNormalizedMessage(entry as SessionMessageEntryLike);
      if (msg.role === "user") {
        if (currentTurn) currentTurn.entryEnd = entry._index;
        currentTurn = {
          index: turns.length,
          timestamp: ts,
          userMessage: norm,
          assistantCalls: [],
          toolResults: [],
          events: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          model: currentModel,
          thinkingLevel: currentThinking,
          entryStart: entry._index,
          entryEnd: entry._index,
        };
        turns.push(currentTurn);
      } else if (msg.role === "assistant") {
        const turn = ensureTurn(ts);
        turn.assistantCalls.push(norm);
        if (norm.usage) {
          turn.usage.input += norm.usage.input;
          turn.usage.output += norm.usage.output;
          turn.usage.cacheRead += norm.usage.cacheRead;
          turn.usage.cacheWrite += norm.usage.cacheWrite;
          turn.usage.total += norm.usage.total;
        }
        if (norm.model) currentModel = norm.provider && norm.model ? `${norm.provider}/${norm.model}` : norm.model;
        if (!turn.model && norm.model) turn.model = norm.model;
        assistantCalls.push(norm);
        turn.entryEnd = entry._index;
      } else if (msg.role === "toolResult") {
        const turn = ensureTurn(ts);
        turn.toolResults.push(norm);
        turn.entryEnd = entry._index;
      } else if (msg.role === "bashExecution") {
        // Inline bash execution — surface like a tool result so it's readable.
        const turn = ensureTurn(ts);
        const cmd = typeof msg.command === "string" ? msg.command : "";
        const out = typeof msg.output === "string" ? msg.output : "";
        const exit = typeof msg.exitCode === "number" ? msg.exitCode : 0;
        const full = `$$ ${cmd}\n${out}${msg.cancelled ? "\n[cancelled]" : ""}`.trim();
        turn.events.push({
          kind: "custom",
          timestamp: ts,
          detail: `bash · exec${exit !== 0 ? " · error" : ""} — ${cmd.slice(0, 120)}`,
          customType: "bashExecution",
          body: full,
        });
        turn.entryEnd = entry._index;
      } else if (msg.role === "custom" || msg.role === "hookMessage") {
        // hook/custom messages participate in context; surface as events
        const turn = ensureTurn(ts);
        turn.events.push({
          kind: "custom",
          timestamp: ts,
          detail: `custom: ${msg.customType ?? "message"}`,
        });
        turn.entryEnd = entry._index;
      }
    } else if (entry.type === "model_change") {
      currentModel = `${entry.provider}/${entry.modelId}`;
      const turn = ensureTurn(entryTimestamp(entry));
      turn.model = currentModel;
      turn.events.push({
        kind: "model_change",
        timestamp: entryTimestamp(entry),
        detail: currentModel,
      });
      turn.entryEnd = entry._index;
    } else if (entry.type === "thinking_level_change") {
      currentThinking = entry.thinkingLevel;
      const turn = ensureTurn(entryTimestamp(entry));
      turn.thinkingLevel = currentThinking;
      turn.events.push({
        kind: "thinking_level_change",
        timestamp: entryTimestamp(entry),
        detail: currentThinking,
      });
      turn.entryEnd = entry._index;
    } else if (entry.type === "compaction") {
      const ts = entryTimestamp(entry);
      const turn = ensureTurn(ts);
      turn.events.push({
        kind: "compaction",
        timestamp: ts,
        detail: `compacted ${entry.tokensBefore} tokens → summary`,
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
      });
      turn.entryEnd = entry._index;
    } else if (entry.type === "custom") {
      const ts = entryTimestamp(entry);
      const turn = ensureTurn(ts);
      const dataStr =
        typeof entry.data === "string"
          ? entry.data.slice(0, 120)
          : JSON.stringify(entry.data ?? {}).slice(0, 120);
      turn.events.push({
        kind: "custom",
        timestamp: ts,
        detail: `${entry.customType}${dataStr ? ` — ${dataStr}` : ""}`,
        customType: entry.customType,
      });
      turn.entryEnd = entry._index;
    } else if (entry.type === "custom_message") {
      // custom_message participates in context and is user-visible (subagent
      // results/notifies, plannotator-complete, skill prompt catalogs). Surface
      // it as an event row so it shows up in the transcript.
      const ts = entryTimestamp(entry);
      const turn = ensureTurn(ts);
      const body = typeof entry.content === "string"
        ? entry.content
        : Array.isArray(entry.content)
          ? entry.content.map((c) => typeof c === "string" ? c : ((c as { text?: string })?.text ?? "")).join("\n")
          : "";
      const label = entry.customType ?? (body ? "message" : "custom");
      turn.events.push({
        kind: "custom",
        timestamp: ts,
        detail: `${label}${body ? ` — ${body.replace(/\s+/g, " ").trim().slice(0, 140)}` : ""}`,
        customType: entry.customType,
        body,
      });
      turn.entryEnd = entry._index;
    } else if (entry.type === "session_info") {
      name = entry.name?.trim() || name;
    } else if (entry.type === "label") {
      const turn = ensureTurn(entryTimestamp(entry));
      turn.events.push({ kind: "label", timestamp: entryTimestamp(entry), detail: "label" });
    }
  }
  if (currentTurn) currentTurn.entryEnd = entries.length;
  else if (turns.length === 0 && entries.length > 0) {
    // session with only non-message entries
    turns.push({
      index: 0,
      timestamp: 0,
      userMessage: null,
      assistantCalls: [],
      toolResults: [],
      events: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      model: currentModel,
      thinkingLevel: currentThinking,
      entryStart: 0,
      entryEnd: entries.length,
    });
  }

  const meta = metaFromHeader(path, basename(dirname(path)), header as { id: string; timestamp: string; cwd: string }, statSync(path));
  meta.messageCount = entries.filter((e) => e.type === "message").length;
  meta.model = currentModel ?? meta.model;
  meta.thinkingLevel = currentThinking ?? meta.thinkingLevel;

  // Precompute the reconstruction once, so every UI screen is adapter-agnostic.
  // systemPrompt + contextFiles are rebuilt from *current* AGENTS.md files
  // (Pi does not snapshot them) — see context.ts notes.
  const contextInfo = buildSessionContextInfo(entries, meta.cwd);
  const contextPoints = buildContextPoints(entries, assistantCalls);

  return {
    meta,
    turns,
    events: turns.flatMap((t) => t.events),
    assistantCalls,
    contextInfo,
    contextPoints,
    name,
    raw: { entries },
  } satisfies AgentSession;
}

/** Reconstructed context messages as of a specific assistant entry. */
export function contextMessagesAt(entries: SessionEntry[], entryIndex: number): AgentMessage[] {
  const target = entries[entryIndex];
  if (!target) return [];
  const ctx = buildSessionContext(entries, target.id);
  return ctx.messages;
}

export { buildSessionContext };
