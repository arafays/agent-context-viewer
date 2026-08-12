/**
 * Context before/after diffing — the headline feature.
 * For each LLM request, compare its "before context" (session state before the
 * call) with the previous request's before-context: what got added, what got
 * pruned (compaction), and the token delta.
 */
import type { ContextPoint, NormalizedMessage } from "../adapters/types.ts"
export interface CompactionInfo {
  entryIndex: number
  tokensBefore: number
  summary: string
  readFiles: string[]
  modifiedFiles: string[]
}

export interface RequestStep {
  /** index into the points array */
  index: number
  point: ContextPoint
  isFirst: boolean
  added: NormalizedMessage[]
  pruned: NormalizedMessage[]
  tokenDelta: number
  /** compaction that fired between the previous request and this one */
  compaction: CompactionInfo | null
  /** true when this request's context was reset by compaction (fresh cache) */
  compactedAhead: boolean
}

/** Stable identity for prefix-matching two context message lists. */
function messageIdentity(m: NormalizedMessage): string {
  const text = m.blocks
    .filter((b) => b.kind === "text" || b.kind === "thinking" || b.kind === "reasoning")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim()
  return `${m.role}|${m.toolName ?? ""}|${m.toolCallId ?? ""}|${text.slice(0, 200)}`
}

function commonPrefixLen(before: NormalizedMessage[], after: NormalizedMessage[]): number {
  let i = 0
  while (i < before.length && i < after.length && messageIdentity(before[i]!) === messageIdentity(after[i]!)) {
    i++
  }
  return i
}

/**
 * Build request steps with added/pruned diffs.
 * @param points context points in order (one per LLM request)
 * @param compactions compaction events (with entryIndex) to surface on the curve
 */
export function buildRequestSteps(points: ContextPoint[], compactions: CompactionInfo[] = []): RequestStep[] {
  const steps: RequestStep[] = []
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!
    const prev = i > 0 ? points[i - 1] : undefined
    const isFirst = !prev
    let added: NormalizedMessage[] = []
    let pruned: NormalizedMessage[] = []
    if (prev) {
      const prefix = commonPrefixLen(prev.contextMessages, point.contextMessages)
      added = point.contextMessages.slice(prefix)
      pruned = prev.contextMessages.slice(prefix)
    } else {
      added = point.contextMessages
    }
    // find compaction between prev and this request
    let compaction: CompactionInfo | null = null
    if (compactions.length > 0) {
      const prevEntry = prev ? pointEntryIndex(prev) : -1
      for (const c of compactions) {
        if (c.entryIndex > prevEntry && c.entryIndex <= pointEntryIndex(point)) {
          compaction = c
          break
        }
      }
    }
    const prevTokens = prev ? prev.contextTokens : 0
    const curTokens = point.contextTokens
    steps.push({
      index: i,
      point,
      isFirst,
      added,
      pruned,
      tokenDelta: curTokens - prevTokens,
      compaction,
      compactedAhead: compaction !== null && point.usage.cacheRead === 0
    })
  }
  return steps
}

/** The entry index of the request's before-state (used to place compactions). */
function pointEntryIndex(p: ContextPoint): number {
  return p.contextMessages.length > 0 ? (p.contextMessages[p.contextMessages.length - 1]?.entryIndex ?? -1) : -1
}

export interface CurveBar {
  requestIndex: number
  turnIndex: number
  contextTokens: number
  input: number
  cacheRead: number
  output: number
  compacted: boolean
}

/** Token curve across all requests. */
export function sessionCurve(points: ContextPoint[], compactions: CompactionInfo[] = []): CurveBar[] {
  return points.map((p, i) => {
    const prev = i > 0 ? points[i - 1] : undefined
    const prevEntry = prev ? pointEntryIndex(prev) : -1
    const compacted = compactions.some((c) => c.entryIndex > prevEntry && c.entryIndex <= pointEntryIndex(p))
    return {
      requestIndex: p.requestIndex,
      turnIndex: p.turnIndex,
      contextTokens: p.contextTokens,
      input: p.usage.input,
      cacheRead: p.usage.cacheRead,
      output: p.usage.output,
      compacted
    }
  })
}
