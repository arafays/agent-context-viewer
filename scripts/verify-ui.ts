import assert from "node:assert/strict"
import { mock } from "bun:test"
import { BoxRenderable, TextAttributes } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { AgentSession, NormalizedMessage, SessionMeta } from "../src/adapters/types.ts"
import type { SearchIndex } from "../src/engine/search-index.ts"
import type { AppCtx, ScreenInstance } from "../src/ui/screen.ts"
import { clearChildren } from "../src/ui/framework.ts"
import { defaultTheme } from "../src/ui/theme.ts"

const meta: SessionMeta = {
  tool: "pi", id: "session-one", path: "/fixture/one", cwd: "/project", project: "/project",
  name: "Investigate search", model: "test-model", startedAt: "2026-10-14", updatedAt: "2026-10-14",
  sizeBytes: 1, messageCount: 30, userMessages: 1, assistantMessages: 1, toolResults: 0,
  tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, compactionCount: 0, customTypes: []
}
const messages: NormalizedMessage[] = Array.from({ length: 30 }, (_, i) => ({
  role: "user", timestamp: i, entryIndex: i, blocks: [{ kind: "text", text: `Message ${i} full content\n${"readable content\n".repeat(40)}END ${i}` }]
}))
const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110 }
const session: AgentSession = {
  meta, events: [], assistantCalls: [],
  turns: [{ index: 1, timestamp: 1, userMessage: messages[0] ?? null, assistantCalls: [], toolResults: [], events: [], usage, model: "test-model", thinkingLevel: null, entryStart: 0, entryEnd: 30 }],
  contextInfo: { systemPrompt: "fixture prompt", contextFiles: [{ path: "/project/AGENTS.md", content: "read me\n".repeat(80) }], tools: [], skills: [], notes: [], reconstructed: false },
  contextPoints: [messages, messages.slice(0, 2)].map((contextMessages, requestIndex) => ({ requestIndex, turnIndex: 1, timestamp: 1, model: "test-model", thinkingLevel: null, usage, contextTokens: 100, contextMessages }))
}
let query = ""
const index: SearchIndex = {
  ready: true, search: (q) => { query = q; return [{ tool: "pi", meta, lineNo: 1, line: "match", isContent: true, turn: 1 }] },
  writeSession: () => 0, getCachedText: () => "", destroy: () => {}
}
mock.module("../src/adapters/registry.ts", () => ({
  TOOLS: [{ id: "pi", name: "Pi", available: true }], availableTools: () => ["pi"], loadSession: () => session
}))
mock.module("../src/engine/session-store.ts", () => ({
  discoverSession: () => null,
  sessionStoreRuntime: { runPromise: async () => ({ metas: [meta, { ...meta, id: "session-two", name: "Second session", path: "/fixture/two" }], error: null }) }
}))
mock.module("../src/engine/search-index.ts", () => ({ buildSearchIndex: () => ({ index }) }))
const { createSearchPanel } = await import("../src/ui/search-panel.ts")
const { createSessionList } = await import("../src/ui/session-list.ts")
const { createContextView } = await import("../src/ui/context-view.ts")
const { createContextFilesView } = await import("../src/ui/context-files-view.ts")
const { createSystemPromptView } = await import("../src/ui/system-prompt-view.ts")
const { createSessionDetail } = await import("../src/ui/session-detail.ts")
const { createReader } = await import("../src/ui/reader.ts")
const { createApp } = await import("../src/app.ts")

for (const [width, height] of [[80, 24], [120, 40], [60, 20]] as const) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true })
  try {
    const box = new BoxRenderable(setup.renderer, { width, height, flexDirection: "column" })
    setup.renderer.root.add(box)
    let screen: ScreenInstance = createSearchPanel()
    let closed = false
    const noop = () => {}
    const ctx: AppCtx = {
      renderer: setup.renderer, theme: defaultTheme(), cols: width, rows: height,
      sessionsByTool: { pi: [meta, { ...meta, id: "other", project: "/other", name: "Other project" }], codex: [], claude: [], cursor: [], vscode: [], opencode: [] },
      discovery: { pi: "done", codex: "done", claude: "done", cursor: "done", vscode: "done", opencode: "done" },
      searchIndex: index, sessionCache: new Map(), openSession: noop, openProject: noop, openAll: noop, goHome: noop,
      openContext: noop, openSysprompt: noop, openFiles: noop, backToDetail: noop, backFromDetail: noop, openSearch: noop,
      closeSearch: () => { closed = true }, quit: noop, rerender: () => { clearChildren(box); screen.render(box, ctx) }
    }
    setup.renderer.keyInput.on("keypress", (key) => screen.handleKey(key, ctx))
    screen.render(box, ctx)
    await setup.mockInput.typeText("jkqQ")
    await setup.renderOnce()
    assert.equal(query, "jkqQ")
    assert.equal(closed, false)
    setup.mockInput.pressEscape()
    assert.equal(closed, true)
    screen = createSessionList("pi", "/project")
    screen.render(box, ctx)
    await setup.renderOnce()
    let frame = setup.captureCharFrame()
    assert(frame.includes("Investigate search"))
    assert(!frame.includes("Other project"))
    screen = createContextView(session)
    screen.render(box, ctx)
    setup.mockInput.pressTab()
    setup.mockInput.pressKey("END")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("Message 29 full content"))
    setup.mockInput.pressKey("END")
    await setup.renderOnce()
    assert(setup.captureCharFrame().includes("END 29"))
    setup.mockInput.pressEscape()
    setup.mockInput.pressTab()
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressTab()
    setup.mockInput.pressKey("END")
    await setup.renderOnce()
    assert(setup.captureCharFrame().includes("− user:"))
    for (const view of [createContextFilesView(session), createSystemPromptView(session)]) {
      screen = view
      screen.render(box, ctx)
      setup.mockInput.pressKey("END")
      await setup.renderOnce()
      assert(setup.captureCharFrame().includes("read me") || setup.captureCharFrame().includes("fixture prompt"))
      const textSpans = setup.captureSpans().lines.flatMap((line) => line.spans)
      assert(textSpans.some((span) => (span.text.includes("read me") || span.text.includes("fixture prompt")) && !(span.attributes & TextAttributes.DIM)))
    }
    for (const source of ["stored", "reconstructed", "fragments", "unavailable"] as const) {
      screen = createSystemPromptView({ ...session, contextInfo: {
        ...session.contextInfo, systemPromptSource: source,
        systemPrompt: source === "unavailable" ? "" : "fixture prompt"
      } })
      screen.render(box, ctx)
      await setup.renderOnce()
      const promptFrame = setup.captureCharFrame()
      assert(promptFrame.includes(source === "stored" ? "exact" : source === "fragments" ? "persisted context fragments" : source))
      assert(promptFrame.includes("session-one"))
      assert(promptFrame.includes("/fixture/one"))
      setup.mockInput.pressKey("END")
      await setup.renderOnce()
      assert(setup.captureCharFrame().includes(source === "unavailable" ? "No system prompt text" : "fixture prompt"))
    }
    screen = createSessionDetail(session, meta)
    clearChildren(box)
    screen.render(box, ctx)
    await setup.renderOnce()
    assert(setup.captureCharFrame().includes("session info"))
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    assert(setup.captureCharFrame().includes("Session: session-one"), setup.captureCharFrame())
    assert(setup.captureCharFrame().includes("Storage: /fixture/one"))
    setup.mockInput.pressEscape()
    let copied = ""
    const originalCopy = setup.renderer.copyToClipboardOSC52.bind(setup.renderer)
    const originalSupport = setup.renderer.isOsc52Supported.bind(setup.renderer)
    setup.renderer.isOsc52Supported = () => true
    setup.renderer.copyToClipboardOSC52 = (text) => { copied = text; return true }
    const fullCommand = "printf 'héllo 🌍'\n" + "echo unwrapped-command\n".repeat(50)
    screen = createReader({ title: "bash command", body: fullCommand }, noop)
    clearChildren(box)
    screen.render(box, ctx)
    setup.mockInput.pressKey("END")
    setup.mockInput.pressKey("y")
    await setup.renderOnce()
    assert.equal(copied, fullCommand)
    assert(setup.captureCharFrame().includes("Copy sent to clipboard"))
    screen = createSystemPromptView(session)
    screen.render(box, ctx)
    setup.mockInput.pressKey("y")
    await setup.renderOnce()
    assert.equal(copied, "fixture prompt")
    assert(setup.captureCharFrame().includes("Copy sent to clipboard"))
    setup.renderer.isOsc52Supported = () => false
    copied = ""
    setup.mockInput.pressKey("y")
    await setup.renderOnce()
    assert.equal(copied, "")
    assert(setup.captureCharFrame().includes("Clipboard unavailable"))
    setup.renderer.isOsc52Supported = () => true
    setup.renderer.copyToClipboardOSC52 = () => { throw new Error("clipboard unavailable") }
    setup.mockInput.pressKey("y")
    await setup.renderOnce()
    assert(setup.captureCharFrame().includes("Clipboard copy failed"))
    setup.renderer.copyToClipboardOSC52 = originalCopy
    setup.renderer.isOsc52Supported = originalSupport
  } finally { setup.renderer.destroy() }
  const app = await createTestRenderer({ width, height, kittyKeyboard: true })
  try {
    createApp(app.renderer)
    await new Promise((resolve) => setTimeout(resolve, 20))
    app.mockInput.pressEnter()
    app.mockInput.pressArrow("down")
    await app.renderOnce()
    const before = app.captureCharFrame()
    assert(before.includes("▶ Second session"))
    app.mockInput.pressEnter()
    app.mockInput.pressArrow("down")
    await app.renderOnce()
    const detail = app.captureCharFrame()
    app.mockInput.pressKey("c")
    app.mockInput.pressKey("s")
    app.mockInput.pressEscape()
    await app.renderOnce()
    assert.equal(app.captureCharFrame(), detail)
    app.mockInput.pressEscape()
    await app.renderOnce()
    assert.equal(app.captureCharFrame(), before)
    app.mockInput.pressKey("/")
    await app.mockInput.typeText("jkq")
    await app.renderOnce()
    const filteredList = app.captureCharFrame()
    assert(filteredList.includes("jkq"))
    app.mockInput.pressEnter()
    app.mockInput.pressKey("f")
    app.mockInput.pressEscape()
    app.mockInput.pressEscape()
    await app.renderOnce()
    assert.equal(app.captureCharFrame(), filteredList)
    app.mockInput.pressEscape()
    app.mockInput.pressKey("?")
    await app.renderOnce()
    assert(app.captureCharFrame().includes("Esc / Enter close"))
    app.mockInput.pressEscape()
    app.mockInput.pressEnter()
    app.mockInput.pressKey("/")
    await app.mockInput.typeText("jkqQ")
    await app.renderOnce()
    assert(app.captureCharFrame().includes("jkqQ"))
  } finally { app.renderer.destroy() }
  console.log(`UI checks passed at ${width}×${height}`)
}
