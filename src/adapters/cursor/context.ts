/**
 * Build `SessionContextInfo` for one Cursor composer — honestly.
 *
 * What Cursor actually persists (verified against state.vscdb on this machine):
 *   - system prompt: NOT per-session. Request payloads live in content-addressed
 *     `agentKv:blob:<sha256>` rows with no composerId linkage, so a prompt cannot
 *     be attributed to a composer → shown empty, never reconstructed from disk.
 *   - `promptContextUsageTree` (40/145 composers): last request's context items
 *     with EXACT labels (rule/skill/tool paths) — but only labels, no contents.
 *   - `promptTokenBreakdown` (41/145): last request's token snapshot only.
 *   - observed tool names from the transcript's toolFormerData.
 *
 * Everything in `notes` is derived from those fields; nothing is invented.
 */
import type { SessionContextInfo } from "../types.ts"
import { type Bubble, bubbleUsage, type ComposerData, flattenTree, type UsageTreeNode } from "./schema.ts"

export interface CursorContextInput {
  composer: ComposerData | null
  /** ordered bubbles actually loaded by loadSession */
  bubbles: Bubble[]
  /** bubble rows whose JSON failed to parse (skipped) */
  skipped: number
  /** bubbles not referenced by fullConversationHeadersOnly, merged by timestamp */
  unreferenced: number
  /** where meta.cwd came from (workspace folder vs tracked git repo vs nothing) */
  cwdSource: "workspace" | "repo" | "none"
}

function skillNameFromLabel(label: string): string {
  const norm = label.replace(/\/+$/, "")
  if (norm.endsWith("/SKILL.md")) return norm.slice(0, -"/SKILL.md".length).split("/").pop() ?? norm
  if (norm.endsWith("SKILL.md")) return norm.split("/").slice(-2)[0] ?? norm
  return norm
}

function labelsOf(nodes: UsageTreeNode[], kind: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of nodes) {
    if (n.kind !== kind || typeof n.label !== "string" || !n.label) continue
    if (seen.has(n.label)) continue
    seen.add(n.label)
    out.push(n.label)
  }
  return out
}

export function buildCursorContextInfo(input: CursorContextInput): SessionContextInfo {
  const notes: string[] = []
  const treeNodes = flattenTree(input.composer?.promptContextUsageTree)
  const hasTree = treeNodes.length > 0

  // --- system prompt ------------------------------------------------------
  notes.push(
    "system prompt: not persisted per session — Cursor keeps request payloads only in content-addressed " +
      "agentKv:blob rows with no composerId link; shown empty here, nothing reconstructed from disk"
  )

  // --- context files (rules) ---------------------------------------------
  const ruleLabels = labelsOf(treeNodes, "rule")
  const rulePaths = ruleLabels.filter((l) => l.includes("/"))
  const inlineRules = ruleLabels.length - rulePaths.length
  if (rulePaths.length > 0) {
    notes.push(
      `context files: last request listed ${rulePaths.length} rule path(s) — ${rulePaths.join(", ")}${
        inlineRules > 0 ? ` (+${inlineRules} inline rules without paths)` : ""
      } (labels from promptContextUsageTree; contents are not stored per session)`
    )
  } else if (hasTree) {
    notes.push("context files: the last request's usage tree lists no rule paths")
  } else {
    notes.push("context files: promptContextUsageTree not persisted for this session")
  }

  const mcpLabels = labelsOf(treeNodes, "mcp_file_system_server")
  if (mcpLabels.length > 0) notes.push(`mcp: ${mcpLabels.join(", ")}`)
  const subagentLabels = labelsOf(treeNodes, "subagent_type")
  if (subagentLabels.length > 0) notes.push(`subagents: ${subagentLabels.join(", ")}`)

  // --- skills -------------------------------------------------------------
  const skillLabels = labelsOf(treeNodes, "skill")
  const skills = skillLabels.map((label) => ({
    name: skillNameFromLabel(label),
    description: "",
    filePath: label
  }))
  if (skillLabels.length > 0) {
    notes.push(
      `skills: ${skillLabels.length} named in the last request's usage tree (labels are SKILL.md paths; descriptions not persisted)`
    )
  }

  // --- tools --------------------------------------------------------------
  const definedTools = labelsOf(treeNodes, "tool_definition")
  const observedTools = new Set<string>()
  for (const b of input.bubbles) {
    const name = b.toolFormerData?.name
    if (name) observedTools.add(name)
  }
  const tools = [...new Set([...definedTools, ...observedTools])].sort()
  if (definedTools.length > 0) {
    notes.push(
      `tools: ${definedTools.length} in the last request's tool definitions + ${observedTools.size} observed in the transcript (definitions themselves not persisted)`
    )
  } else if (observedTools.size > 0) {
    notes.push(`tools: ${observedTools.size} observed in the transcript (no usage tree persisted for this session)`)
  } else {
    notes.push("tools: none recorded")
  }

  // --- tokens / context curve --------------------------------------------
  const breakdown = input.composer?.promptTokenBreakdown
  const recordedUsage = input.bubbles.some((b) => bubbleUsage(b) !== null)
  if (breakdown && typeof breakdown.totalUsedTokens === "number") {
    notes.push(
      `tokens: last request ~${breakdown.totalUsedTokens}${
        typeof breakdown.maxTokens === "number" ? `/${breakdown.maxTokens}` : ""
      } (promptTokenBreakdown snapshot); per-request usage is not stored, so the context curve is empty`
    )
  } else if (recordedUsage) {
    notes.push("tokens: per-bubble tokenCount values exist but no promptTokenBreakdown snapshot was stored")
  } else {
    notes.push("tokens: none persisted (bubble tokenCount fields are all 0; no promptTokenBreakdown)")
  }

  // --- summarization markers ---------------------------------------------
  let summaries = 0
  for (const n of treeNodes) if (n.kind === "summary_message") summaries++
  if (summaries > 0) {
    notes.push(
      `${summaries} summary_message marker(s) in the last request's context — in-context summarization happened, but timestamps/usage were not persisted, so no compaction events are reconstructed`
    )
  }

  // --- data-quality caveats ----------------------------------------------
  if (input.skipped > 0) notes.push(`${input.skipped} bubble row(s) skipped (unparseable or no renderable content)`)
  if (input.unreferenced > 0) {
    notes.push(
      `${input.unreferenced} bubble row(s) are not referenced by fullConversationHeadersOnly — merged in by timestamp (pruned/hidden history)`
    )
  }
  if (input.cwdSource === "repo") {
    notes.push("project: workspace folder not persisted for this session — path taken from trackedGitRepos[0].repoPath")
  } else if (input.cwdSource === "none") {
    notes.push("project: no workspace folder persisted for this session (listed under (root))")
  }
  if (input.composer?.modelConfig?.modelName === "default") {
    notes.push(
      `model: composerData.modelConfig.modelName is "default" (Cursor's placeholder — the real model id is not persisted)`
    )
  }

  return {
    systemPrompt: "",
    contextFiles: [],
    skills,
    tools,
    // The header renders "reconstructed — see notes for per-section provenance";
    // notes state plainly that nothing was reconstructed and why.
    reconstructed: true,
    notes
  }
}
