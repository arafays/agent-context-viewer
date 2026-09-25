/**
 * Replay engine for VS Code's ObjectMutationLog JSONL format used by the
 * Copilot Chat transcript store (`User/workspaceStorage/<hash>/chatSessions/*.jsonl`
 * and `User/globalStorage/emptyWindowChatSessions/*.jsonl`).
 *
 * Format facts (verified against real files + microsoft/vscode
 * `objectMutationLog.ts` / `chatSessionOperationLog.ts`):
 *  - Each line is one JSON operation: `{ kind, k, v, i? }`.
 *    - `kind` is 0|1|2|3 as a number or a string (both occur in the wild).
 *    - `k` is the path array from the state root to the target.
 *    - `v` is the value; `i` is the push index (kind 2 only).
 *  - kind 0 = "Initial": `v` is the full state object (always the 1st line).
 *  - kind 1 = "Set": `k`'s parent slot is assigned `v`.
 *  - kind 2 = "Push": the array at `k` is truncated to index `i`
 *    (`arr.length = i`, only when `i` is defined) and `v` (an array) is
 *    pushed. This is how `requests` / `response` arrays grow over time —
 *    replaying it yields the current array state.
 *  - kind 3 = "Delete": the element at `k` is removed.
 *
 * The replay is fully defensive: malformed lines/ops are skipped and counted,
 * never thrown — a partial transcript is better than no transcript.
 */

export interface ReplayResult {
  /** replayed state object, or null when the file never provided an Initial op */
  state: Record<string, unknown> | null
  /** lines that were not valid JSON or had an unusable shape */
  malformedLines: number
  /** operations applied successfully */
  appliedOps: number
}

interface RawOp {
  kind?: unknown
  k?: unknown
  v?: unknown
  i?: unknown
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null
}

/** Walk `path` to its parent container; returns the parent + last segment. */
function parentOf(
  root: Record<string, unknown>,
  path: unknown[]
): { parent: Record<string, unknown> | unknown[]; key: string | number } | null {
  if (path.length === 0) return null
  let cur: unknown = root
  for (let d = 0; d < path.length - 1; d++) {
    const seg = path[d]
    if (cur && typeof cur === "object" && seg !== null && seg !== undefined) {
      cur = (cur as Record<string | number, unknown>)[seg as string | number]
    } else {
      return null
    }
  }
  const last = path[path.length - 1]
  if (cur === null || typeof cur !== "object") return null
  if (typeof last === "number") {
    if (!Array.isArray(cur)) return null
    return { parent: cur, key: last }
  }
  if (typeof last === "string") return { parent: cur as Record<string, unknown>, key: last }
  return null
}

/** Apply one operation to the state. Returns true when applied cleanly. */
function applyOp(state: Record<string, unknown>, op: RawOp): boolean {
  const kindRaw = op.kind
  const kind = typeof kindRaw === "number" ? kindRaw : typeof kindRaw === "string" ? Number(kindRaw) : NaN
  const path = asArray(op.k)
  if (Number.isNaN(kind)) return false

  if (kind === 0) return false // Initial handled by the caller (replaces state)

  if (!path) return false

  if (kind === 1) {
    // Set: assign v at path
    const at = parentOf(state, path)
    if (!at) return false
    const { parent, key } = at
    if (Array.isArray(parent)) {
      if (typeof key !== "number" || key < 0) return false
      parent[key] = op.v
      return true
    }
    parent[key as string] = op.v
    return true
  }

  if (kind === 2) {
    // Push: truncate array at path to index i (when defined), then push v
    let cur: unknown = state
    for (const seg of path) {
      if (cur && typeof cur === "object") cur = (cur as Record<string | number, unknown>)[seg as string | number]
      else return false
    }
    if (!Array.isArray(cur)) return false
    const arr = cur
    const values = asArray(op.v)
    if (!values) return false // a non-array push value is unusable for us
    const idx = typeof op.i === "number" ? op.i : typeof op.i === "string" ? Number(op.i) : null
    if (idx !== null && !Number.isNaN(idx)) {
      if (idx < 0 || idx > arr.length) return false // corrupt index — refuse to guess
      arr.length = idx
    }
    for (const item of values) arr.push(item)
    return true
  }

  if (kind === 3) {
    // Delete: remove element at path
    const at = parentOf(state, path)
    if (!at) return false
    const { parent, key } = at
    if (Array.isArray(parent)) {
      if (typeof key !== "number" || key < 0 || key >= parent.length) return false
      parent.splice(key, 1)
      return true
    }
    if (!(key in parent)) return false
    delete (parent as Record<string, unknown>)[key as string]
    return true
  }

  return false
}

/**
 * Replay a chat-session mutation log into its current state object.
 * Never throws; malformed input is skipped and counted.
 */
export function replayMutationLog(text: string): ReplayResult {
  let state: Record<string, unknown> | null = null
  let malformedLines = 0
  let appliedOps = 0
  const lines = text.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let op: RawOp
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        malformedLines++
        continue
      }
      op = parsed as RawOp
    } catch {
      malformedLines++
      continue
    }
    const kindRaw = op.kind
    const kind = typeof kindRaw === "number" ? kindRaw : typeof kindRaw === "string" ? Number(kindRaw) : NaN
    if (Number.isNaN(kind)) {
      malformedLines++
      continue
    }
    if (kind === 0) {
      // Initial: full state snapshot (later Initial ops, if any, replace it)
      if (op.v && typeof op.v === "object" && !Array.isArray(op.v)) {
        state = op.v as Record<string, unknown>
        appliedOps++
      } else {
        malformedLines++
      }
      continue
    }
    if (!state) {
      // operations before any Initial are unusable
      malformedLines++
      continue
    }
    if (applyOp(state, op)) appliedOps++
    else malformedLines++
  }
  return { state, malformedLines, appliedOps }
}
