import assert from "node:assert/strict"
import { TOOLS, discoverSessions, loadSession } from "../src/adapters/registry.ts"

// Read real stores without printing prompt or transcript contents.
for (const tool of TOOLS) {
  const metas = discoverSessions(tool.id)
  const indices = [0, 1, 2, Math.floor(metas.length / 2), metas.length - 2, metas.length - 1]
  const sample = [...new Set(indices)].flatMap((index) => metas[index] ? [metas[index]!] : [])
  for (const meta of sample) {
    const session = loadSession(meta)
    const info = session.contextInfo
    assert.equal(session.meta.tool, tool.id)
    assert.ok(session.meta.id)
    assert.ok(info.systemPromptSource, `${tool.id}: missing prompt provenance`)
    if (info.systemPromptSource === "unavailable") assert.equal(info.systemPrompt, "")
    else assert.ok(info.systemPrompt.trim(), `${tool.id}: empty available prompt`)
    assert.ok(Array.isArray(info.notes))
    assert.ok(Array.isArray(info.contextFiles))
    assert.ok(Array.isArray(session.turns))
    for (const point of session.contextPoints) {
      assert.ok(Number.isFinite(point.contextTokens) && point.contextTokens >= 0, `${tool.id}: invalid context size`)
      assert.ok(Array.isArray(point.contextMessages))
    }
    for (const value of Object.values(session.meta.tokens)) assert.ok(Number.isFinite(value) && value >= 0)
  }
  console.log(`${tool.id}: ${metas.length} discovered, ${sample.length} loaded and checked`)
}
