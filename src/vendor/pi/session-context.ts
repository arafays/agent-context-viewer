/**
 * Vendored from @earendil-works/pi-coding-agent 0.87.1 `dist/core/session-manager.js` (MIT).
 * Pure functions only (no SessionManager class / I/O side effects beyond reading a file).
 * Verified line-by-line against 0.87.1 dist (.js runtime + .d.ts types).
 *
 * Deliberate omission: dist `loadEntriesFromFile()` ends with an `appendFileSync`
 * repair that rewrites a session file when its last line lacks a trailing newline.
 * This is a read-only viewer, so the write side effect is intentionally not ported.
 * See NOTE.md in this directory.
 */
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, readSync } from "node:fs"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "./messages.ts"
import { normalizePath, resolvePath } from "./paths.ts"
import type {
  AgentMessage,
  CompactionEntry,
  ContextEditEntry,
  FileEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionProjection
} from "./types.ts"

export const CURRENT_SESSION_VERSION = 3

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8)
    if (!byId.has(id)) return id
  }
  return randomUUID()
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
  const ids = new Set<string>()
  let prevId: string | null = null
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 2
      continue
    }
    entry.id = generateId(ids)
    entry.parentId = prevId
    prevId = entry.id
    if (entry.type === "compaction") {
      const comp = entry as { firstKeptEntryIndex?: number; firstKeptEntryId?: string }
      if (typeof comp.firstKeptEntryIndex === "number") {
        const targetEntry = entries[comp.firstKeptEntryIndex]
        if (targetEntry && targetEntry.type !== "session") {
          comp.firstKeptEntryId = targetEntry.id
        }
        delete comp.firstKeptEntryIndex
      }
    }
  }
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 3
      continue
    }
    if (entry.type === "message") {
      const msgEntry = entry as { message?: AgentMessage }
      if (msgEntry.message && msgEntry.message.role === "hookMessage") {
        msgEntry.message.role = "custom"
      }
    }
  }
}

/** Run all necessary migrations to bring entries to current version. Mutates in place. */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
  const header = entries.find((e) => e.type === "session") as SessionHeader | undefined
  const version = header?.version ?? 1
  if (version >= CURRENT_SESSION_VERSION) return false
  if (version < 2) migrateV1ToV2(entries)
  if (version < 3) migrateV2ToV3(entries)
  return true
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
  migrateToCurrentVersion(entries)
}

/** Parse a session JSONL string into entries, skipping malformed lines. */
export function parseSessionEntries(content: string): FileEntry[] {
  const entries: FileEntry[] = []
  const lines = content.trim().split("\n")
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      entries.push(entry)
    } catch {
      // Skip malformed lines
    }
  }
  return entries
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type === "compaction") {
      return entry
    }
  }
  return null
}

function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
  if (byId) return byId
  const index = new Map<string, SessionEntry>()
  for (const entry of entries) {
    index.set(entry.id, entry)
  }
  return index
}

function buildSessionPath(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>
): SessionEntry[] {
  const index = buildEntryIndex(entries, byId)
  let leaf: SessionEntry | undefined
  if (leafId === null) {
    return []
  }
  if (leafId) {
    leaf = index.get(leafId)
  }
  leaf ??= entries[entries.length - 1]
  if (!leaf) {
    return []
  }
  const path: SessionEntry[] = []
  let current: SessionEntry | undefined = leaf
  while (current) {
    path.push(current)
    current = current.parentId ? index.get(current.parentId) : undefined
  }
  path.reverse()
  return path
}

function getSessionContextSettings(path: SessionEntry[]): {
  thinkingLevel: string
  model: { provider: string; modelId: string } | null
} {
  let thinkingLevel = "off"
  let model: { provider: string; modelId: string } | null = null
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId }
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      // dist assigns unconditionally (no provider/model guard); values may be
      // undefined in hand-edited files — cast to satisfy the SessionContext type.
      model = { provider: entry.message.provider as string, modelId: entry.message.model as string }
    }
  }
  return { thinkingLevel, model }
}

/**
 * Project one selected session entry into LLM/runtime messages.
 * Plain custom entries are display/state entries and do not participate in context.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
  if (entry.type === "message") {
    const message = entry.message
    // Session files are parsed without validation; old versions, forks, or
    // hand-edited files can contain messages with null/missing content.
    if (message.role === "system" && message.content == null) return [{ ...message, content: "" }]
    if (
      (message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
      message.content == null
    ) {
      return [{ ...message, content: [] }]
    }
    return [message]
  }
  if (entry.type === "custom_message") {
    return [createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp)]
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)]
  }
  if (entry.type === "compaction") {
    const summary = createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)
    return entry.systemMessage ? [entry.systemMessage, summary] : [summary]
  }
  return []
}

/**
 * Build the active, compaction-aware session entry list.
 *
 * This follows the current leaf path. If the path contains compaction entries,
 * the latest compaction is represented by the compaction entry itself, followed
 * by the kept entries starting at firstKeptEntryId and all entries after the
 * compaction entry. Older summarized entries are omitted.
 */
export function buildContextEntries(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>
): SessionEntry[] {
  const path = buildSessionPath(entries, leafId, byId)
  let compaction: SessionEntry | null = null
  for (const entry of path) {
    if (entry.type === "compaction") {
      compaction = entry
    }
  }
  if (!compaction) {
    return path
  }
  const compactionIdx = path.findIndex((entry) => entry.id === compaction!.id)
  if (compactionIdx < 0) {
    return path
  }
  const contextEntries: SessionEntry[] = [compaction]
  let foundFirstKept = false
  for (let i = 0; i < compactionIdx; i++) {
    const entry = path[i]
    if (!entry) continue
    if (entry.id === compaction!.firstKeptEntryId) {
      foundFirstKept = true
    }
    if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) {
      contextEntries.push(entry)
    }
  }
  contextEntries.push(...path.slice(compactionIdx + 1))
  return contextEntries
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
function projectContextEntry(entry: SessionEntry, edit: ContextEditEntry | undefined): AgentMessage[] {
  const messages = sessionEntryToContextMessages(entry)
  if (!edit) return messages
  const replacement = edit.replacement
  if (replacement === null) return []
  return messages.map((message) => {
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "toolResult" &&
      message.role !== "custom"
    ) {
      return message
    }
    const content =
      (message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string"
        ? [{ type: "text", text: replacement.content }]
        : replacement.content
    return { ...message, content }
  })
}

/** Build provenance-preserving, compaction-aware model context. */
export function buildSessionProjection(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>
): SessionProjection {
  const path = buildSessionPath(entries, leafId, byId)
  const { thinkingLevel, model } = getSessionContextSettings(path)
  const contextEntries = buildContextEntries(entries, leafId, byId)
  const edits = new Map<string, ContextEditEntry>()
  for (const entry of contextEntries) {
    if (entry.type === "context_edit") edits.set(entry.targetId, entry)
  }
  const projectedEntries = contextEntries.map((sourceEntry, index) => ({
    sourceEntry,
    // buildContextEntries() may retain an older compaction entry because its
    // raw ID lies inside the newest retained range. Only the newest compaction
    // at index zero contributes a checkpoint and summary.
    messages:
      sourceEntry.type === "compaction" && index > 0 ? [] : projectContextEntry(sourceEntry, edits.get(sourceEntry.id))
  }))
  return {
    entries: projectedEntries,
    messages: projectedEntries.flatMap((entry) => entry.messages),
    thinkingLevel,
    model
  }
}

/** Build the finalized model context from the canonical session projection. */
export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>
): SessionContext {
  const { messages, thinkingLevel, model } = buildSessionProjection(entries, leafId, byId)
  return { messages, thinkingLevel, model }
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024

function parseSessionEntryLine(line: string): FileEntry | null {
  if (!line.trim()) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * Load all entries from a session file, tolerating malformed lines and
 * validating that the first line is a session header.
 */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
  const resolvedFilePath = normalizePath(filePath)
  if (!existsSync(resolvedFilePath)) return []
  const entries: FileEntry[] = []
  const fd = openSync(resolvedFilePath, "r")
  try {
    const decoder = new StringDecoder("utf8")
    const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE)
    let pending = ""
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      pending += decoder.write(buffer.subarray(0, bytesRead))
      let lineStart = 0
      let newlineIndex = pending.indexOf("\n", lineStart)
      while (newlineIndex !== -1) {
        const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex))
        if (entry) entries.push(entry)
        lineStart = newlineIndex + 1
        newlineIndex = pending.indexOf("\n", lineStart)
      }
      pending = pending.slice(lineStart)
    }
    pending += decoder.end()
    const finalEntry = parseSessionEntryLine(pending)
    if (finalEntry) entries.push(finalEntry)
  } finally {
    closeSync(fd)
  }
  if (entries.length === 0) return entries
  const header = entries[0]!
  // Validate session header before repairing the file.
  if (header.type !== "session" || typeof header.id !== "string") {
    return []
  }
  // Deliberate omission vs dist: dist appends a trailing "\n" here via
  // appendFileSync when the file's last line lacked one. This viewer never
  // mutates session files (read-only), so that repair is not ported.
  return entries
}

/** Default session dir for a cwd (mirrors getDefaultSessionDirPath, no mkdir). */
export function defaultSessionDirPath(cwd: string, agentDir: string): string {
  const resolvedCwd = resolvePath(cwd)
  const resolvedAgentDir = resolvePath(agentDir)
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
  return join(resolvedAgentDir, "sessions", safePath)
}
