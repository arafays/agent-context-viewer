# Agent Context Viewer — Plan

**Project folder:** `~/projects/agent-context-viewer/` (new git repo, managed via **mise**)
**Stack:** TypeScript + **Bun** (mise-managed) + **Ink** (React for terminals)

## Context

A terminal UI that shows **how AI coding agents assemble context**: for each prompt, the "before context" and "after context", what was added, what was pruned, which system prompt was loaded, which `AGENTS.md`/`CLAUDE.md` files were injected, and the full transcript of every session.

**v1 scope (user-confirmed):**

- Only **Pi** (`@earendil-works/pi-coding-agent` 0.83.0, installed via mise) — richest, and the priority.
- Headline feature: **context before/after per turn**.
- Architecture must support adding opencode / Claude Code ("cloud") / codex / Cursor / VS Code later.
- "cloud" = **Claude Code** (confirmed).

## Verified facts (this machine)

- Pi sessions: `~/.pi/agent/sessions/<slug>/<ts>_<uuid>.jsonl` — JSONL typed events:
  `session` (v3 header: id/timestamp/cwd), `message` (roles user/assistant/toolResult), `model_change`, `thinking_level_change`, `compaction` (summary, tokensBefore, firstKeptEntryId, details incl. `om.folded` observations), `custom` (plannotator, `om.observations.recorded`, `om.reflections.recorded`), `custom_message`, `label`, `branch_summary`.
  - Assistant messages carry authoritative `usage`: `{input, cacheRead, cacheWrite, output}` → **context size per turn = input + cacheRead**.
  - System prompt is **not persisted** → reconstruct at view time.
  - Real compaction example: `~/.pi/agent/sessions/--home-arafays-.local-share-chezmoi--/2026-07-12T23-29-23-516Z_*.jsonl` (tokensBefore 112367, `om.folded`).
- Pi's npm package (`@earendil-works/pi-coding-agent`) only exports the public API (`.`, `./rpc-entry`). The pure context functions live in `dist/core/*.js` and are **MIT licensed** (github.com/earendil-works/pi) → **vendor them**.
- Context assembly (from installed source):
  - `core/system-prompt.js` `buildSystemPrompt()`: base prompt + tool list (per-tool `promptSnippet`) + guidelines + append + `<project_context>` `<project_instructions path="...">` blocks + skills + cwd.
  - `core/resource-loader.js` `loadProjectContextFiles(cwd, agentDir)`: global `~/.pi/agent/AGENTS.md` first, then walk cwd → root loading `AGENTS.md` (with shadowing) — this answers "which agents.md was added".
  - `core/session-manager.js` `buildSessionContext(entries, leafId)` → `{messages, thinkingLevel, model}` — compaction-aware exact context messages; `sessionEntryToContextMessages` maps compaction → summary message.
  - Tool snippets: `promptSnippet`/guidelines in `dist/core/tools/*.js` (bash, read, write, edit, grep, find, ls) → extractable.
- Environment: Arch/CachyOS, `~/.pi/agent/AGENTS.md` exists; settings in `~/.pi/agent/settings.json` (skills, defaultModel, subagents, observational-memory thresholds).

## Architecture

```
agent-context-viewer/
├── mise.toml                     # bun (mise use bun@latest), node for scripts
├── package.json                  # ink, react (minimal deps); type: module
├── tsconfig.json
├── src/
│   ├── main.tsx                  # Ink entry
│   ├── app.tsx                   # state machine: Home → SessionList → SessionDetail → ContextView
│   ├── adapters/
│   │   ├── types.ts              # normalized model (see below)
│   │   ├── registry.ts           # tool → adapter; discovery of installed agents
│   │   └── pi/
│   │       ├── index.ts          # session discovery + JSONL parsing → normalized Session
│   │       └── context.ts        # system-prompt reconstruction + context snapshots
│   ├── vendor/pi/                # vendored MIT functions from installed pi 0.83.0
│   │   ├── session-context.ts    # buildSessionContext, buildContextEntries, sessionEntryToContextMessages,
│   │   │                         #   buildSessionPath, parseSessionEntries, loadEntriesFromFile, migrateSessionEntries
│   │   ├── system-prompt.ts      # buildSystemPrompt (verbatim)
│   │   ├── context-files.ts      # loadProjectContextFiles + findShadowedContextFile
│   │   ├── messages.ts           # createCustomMessage / createCompactionSummaryMessage / createBranchSummaryMessage
│   │   ├── tool-snippets.ts      # extracted promptSnippet + promptGuidelines per builtin tool
│   │   └── NOTE.md               # source version, license, re-sync steps
│   ├── engine/
│   │   ├── turns.ts              # group entries into turns; per-turn token math
│   │   ├── context-diff.ts       # before/after per turn: added/pruned + compaction markers
│   │   └── tokens.ts             # formatting (k/M, bars)
│   ├── ui/
│   │   ├── home.tsx              # tool picker (pi only in v1; registry-driven)
│   │   ├── session-list.tsx      # per-project; date, model, token totals, compaction badge, search
│   │   ├── session-detail.tsx    # full transcript viewer (thinking toggle, tool blocks, model changes)
│   │   ├── context-view.tsx      # HEADLINE: token curve + per-turn snapshot + before/after diff
│   │   ├── system-prompt-view.tsx
│   │   ├── context-files-view.tsx# AGENTS.md hierarchy loaded for the session
│   │   └── components/           # List, Spinner, TokenBar, Diff, Markdown-ish renderer
│   └── util/                     # slug decoding (--path--), time, paths, lazy file reading
├── scripts/
│   └── extract-tool-snippets.ts  # reads installed pi dist/core/tools/*.js → vendor/pi/tool-snippets.ts
└── README.md
```

## Normalized model (`adapters/types.ts`)

```ts
type AgentTool = "pi" | "opencode" | "claude" | "codex" | "cursor" | "vscode";

interface SessionMeta { tool; id; path; cwd; startedAt; name?; projectPath; fileSize }
interface MessageBlock { role; kind: "text"|"thinking"|"tool_use"|"tool_result"|"reasoning"|"image";
                         text?; toolName?; toolCallId?; isError?; usage? }
interface Turn { index; userBlocks; assistantBlocks; toolCalls+results; usage?; model?; thinkingLevel? }
interface ContextSnapshot { turnIndex; totalTokens; systemPrompt?; contextMessages[]; compacted? }
```

Keep raw entries too (fidelity); normalize only for rendering.

## Headline feature — context before/after per turn

For each assistant turn N in a Pi session:

- **before(N)** = exact context messages when request N was sent = vendored `buildSessionContext(entries up to N)` + system prompt = vendored `buildSystemPrompt({cwd, contextFiles: loadProjectContextFiles(cwd), skills, toolSnippets, ...})`.
- **after(N)** = before(N+1).
- **diff(N)** = messages added (new user msg, tool results), compaction events (`tokensBefore`, summary) → rendered green/red.
- **token curve**: `usage.input + usage.cacheRead` per assistant message (authoritative, from the file) — bar chart over turns showing context growth, cache reuse, and prune drops.

**Reconstruction caveat:** system prompt + AGENTS.md contents are rebuilt from _current_ files (session doesn't snapshot them). Label these views "reconstructed — AGENTS.md may differ from session date". Token counts and messages are authoritative.

## Reuse

- **Pi's own pure functions (vendored, MIT)** — exact context reconstruction, no drift.
- `dist/core/export-html/` — future HTML export.
- `~/.pi/agent/settings.json` — skills, models, observational-memory thresholds (for context-files & pruning explanation).
- bun:sqlite — future opencode.db adapter.

## Steps

- [x] 1. Scaffold: `mkdir ~/projects/agent-context-viewer`, `mise use bun@latest`, `bun init`-style package.json (ink, react), tsconfig, .gitignore, git init.
- [x] 2. Vendor Pi functions from installed `@earendil-works/pi-coding-agent@0.83.0` dist (with MIT header + NOTE.md): session-context, system-prompt, context-files, messages; write `scripts/extract-tool-snippets.ts` and generate `tool-snippets.ts`.
- [x] 3. Pi adapter: session discovery (walk `~/.pi/agent/sessions/*/`, decode cwd slug, fast header scan for id/timestamp/cwd), tolerant JSONL parsing, entry → turn grouping, usage totals, per-session meta (model, thinking level, compaction count, custom events).
- [x] 4. Engine: `turns.ts` (turn boundaries, token math), `context-diff.ts` (before/after snapshot + diff + compaction markers).
- [x] 5. UI: Home (tool picker) → SessionList (search, metadata) → SessionDetail (transcript) → ContextView (curve + snapshot + diff) + SystemPromptView + ContextFilesView. Keybindings: `j/k` scroll, `Enter` open, `Tab` tool switch, `s` system prompt, `f` context files, `c` context view, `q`/`Esc` back, `/` search.
- [x] 6. Polish: large-session lazy reading, malformed-line tolerance, help panel, loading states, README with screenshots/usage.
- [x] 7. First additional adapter: **Codex** (`~/.codex/sessions/**/rollout-*.jsonl`) — exact context
      (system prompt inline via `session_meta.base_instructions`, AGENTS.md/skills/permissions as
      developer/user messages, per-request usage from `token_count`, model from `turn_context`).
      Screens consume the shared `AgentSession` (`contextInfo` + `contextPoints` precomputed at load).
  - [x] claude (`~/.claude/projects/*.jsonl`) — exact per-request usage; system
        prompt not persisted by Claude Code (turn_duration only) → honest note +
        reconstructed context files; assistant entries grouped by identical usage
        (Claude emits one entry per content block); commands shown as ⌘ lines
  - [ ] opencode (`~/.local/share/opencode/` SQLite)
  - [ ] cursor / vscode (SQLite stores)

## Verification

- `cd ~/projects/agent-context-viewer && mise install && bun run start`; browse the ~8 Pi project dirs / 20+ sessions on this box.
- Open a session with compaction (`~/.pi/agent/sessions/--home-arafays-.local-share-chezmoi--/2026-07-12T23-29-23-516Z_*.jsonl`) → confirm the prune story (tokensBefore 112367, om.folded observations) renders.
- Cross-check reconstructed context token totals vs `usage.input + cacheRead` from the file.
- Sanity: start a fresh `pi` session, compare its rendered system prompt (tools, guidelines, AGENTS.md blocks) with the reconstructed one.
- `bun run typecheck` / lint clean.
