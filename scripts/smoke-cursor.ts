/**
 * Cursor adapter sanity check against the real store (read-only).
 *   bun scripts/smoke-cursor.ts
 *
 * Prints discovery timing/count, then per-sample: transcript shape,
 * contextInfo + every provenance note, and a couple of real content previews.
 */
import { closeCursorStores } from "../src/adapters/cursor/db.ts"
import { discoverSessions, loadSession } from "../src/adapters/cursor/index.ts"
import type { SessionMeta } from "../src/adapters/types.ts"

const t0 = performance.now()
const metas = discoverSessions()
console.log(`cursor sessions: ${metas.length}  (discovery ${(performance.now() - t0).toFixed(0)}ms)`)

if (metas.length === 0) {
  console.log("no sessions found — Cursor store missing or no composer has local message rows")
  closeCursorStores()
  process.exit(0)
}

const byMsgs = [...metas].sort((a, b) => b.messageCount - a.messageCount)
const samples: SessionMeta[] = []
for (const m of [metas[0], byMsgs[0], metas.find((x) => x.userMessages >= 3), metas.find((x) => !x.cwd)]) {
  if (m && !samples.includes(m)) samples.push(m)
}

for (const meta of samples) {
  const t1 = performance.now()
  const s = loadSession(meta)
  const dur = (performance.now() - t1).toFixed(0)
  console.log(`\n=== ${meta.id.slice(0, 8)} "${meta.name ?? "(untitled)"}" [${meta.cwd || "(no cwd)"}] (load ${dur}ms) ===`)
  console.log(
    `  turns=${s.turns.length} assistantCalls=${s.assistantCalls.length} contextPoints=${s.contextPoints.length} events=${s.events.length}`
  )
  console.log(
    `  msgs total=${meta.messageCount} user=${meta.userMessages} assistant=${meta.assistantMessages} tools=${meta.toolResults} · tokens=${JSON.stringify(meta.tokens)} · compactionCount=${meta.compactionCount}`
  )
  console.log(
    `  model=${meta.model ?? "—"} project=${meta.project || "(root)"} started=${meta.startedAt} updated=${meta.updatedAt}`
  )

  const info = s.contextInfo
  console.log(
    `  systemPrompt=${info.systemPrompt.length} chars (${info.reconstructed ? "reconstructed" : "exact"}) · contextFiles=${info.contextFiles.length} · skills=${info.skills.length} · tools=${info.tools.length}`
  )
  console.log(`  tools: ${info.tools.slice(0, 14).join(", ")}${info.tools.length > 14 ? ", …" : ""}`)
  console.log(`  skills: ${info.skills.map((k) => `${k.name} (${k.filePath})`).join(", ") || "none"}`)
  for (const note of info.notes) console.log(`  note: ${note}`)

  const first = s.turns[0]
  const prompt = first?.userMessage?.blocks
    .map((b) => b.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (prompt) console.log(`  first prompt: ${prompt.slice(0, 160)}`)
  const toolBlock = s.assistantCalls.flatMap((c) => c.blocks).find((b) => b.kind === "tool_use")
  if (toolBlock) {
    console.log(`  first tool: ${toolBlock.toolName}(${JSON.stringify(toolBlock.input ?? null).slice(0, 90)})`)
  }

  const roles = { user: 0, assistant: 0, toolResult: 0 }
  for (const t of s.turns) {
    if (t.userMessage) roles.user++
    roles.assistant += t.assistantCalls.length
    roles.toolResult += t.toolResults.length
  }
  console.log(`  rendered: ${JSON.stringify(roles)}`)
}

const searchHead = metas[0]?.searchText?.split("\n").slice(0, 4).join(" ⏎ ") ?? ""
console.log(`\nsearchText (first units): ${searchHead.slice(0, 240)}`)
closeCursorStores()
console.log("\nOK")
