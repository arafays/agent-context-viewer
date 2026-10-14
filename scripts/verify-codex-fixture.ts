import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverSessions, loadSession } from "../src/adapters/codex/index.ts"

const root = mkdtempSync(join(tmpdir(), "acv-codex-"))
const previous = process.env.CODEX_HOME
try {
  mkdirSync(join(root, "sessions"))
  const path = join(root, "sessions", "rollout-fixture.jsonl")
  const events = [
    { type: "session_meta", payload: { id: "fixture", cwd: "/fixture/project", base_instructions: { text: "Recorded prompt" } } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "one" } },
    { type: "turn_context", payload: { model: "fixture-model", effort: "high" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(1000) }] } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-one", output: "done" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } } } },
    { type: "event_msg", payload: { type: "task_complete" } }
  ]
  writeFileSync(path, events.map((event) => JSON.stringify({ timestamp: "2026-10-15T00:00:00Z", ...event }).replaceAll('\":', '\": ')).join("\n") + "\n")
  process.env.CODEX_HOME = root
  const meta = discoverSessions()[0]
  assert.ok(meta)
  assert.equal(meta.model, "fixture-model")
  assert.equal(meta.thinkingLevel, "high")
  assert.equal(meta.userMessages, 1)
  assert.equal(meta.assistantMessages, 1)
  assert.equal(meta.toolResults, 1)
  const session = loadSession(path)
  assert.equal(session.contextInfo.systemPromptSource, "stored")
  assert.equal(session.contextInfo.systemPrompt, "Recorded prompt")
  assert.equal(session.meta.thinkingLevel, "high")
  assert.equal(session.contextPoints[0]?.contextTokens, 100)
  assert.equal(session.meta.tokens.input, 60)
  assert.equal(session.meta.tokens.cacheRead, 40)
  console.log("Codex fixture checks passed")
} finally {
  if (previous === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previous
  rmSync(root, { recursive: true, force: true })
}
