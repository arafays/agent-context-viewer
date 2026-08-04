# Agent Context Viewer — project instructions

TUI that shows how AI coding agents assemble context: system prompts,
AGENTS.md/CLAUDE.md files, per-turn context before/after snapshots,
compaction ("pruning") events, and full session transcripts.

## Stack

- **Bun** (mise-managed) + TypeScript + **OpenTUI** (React bindings via `@opentui/react`).
- No build step: `bun run start` (or `bun src/main.tsx`).
- Typecheck: `bun run typecheck` (tsc --noEmit).
- Formatting: fix manually (no formatter configured).

## Source layout

```
src/
  main.tsx              # Entry: createCliRenderer + createRoot(<App/>)
  app.tsx               # Screen router (home → list → detail → context/sysprompt/files)
  adapters/
    types.ts            # Normalized model: AgentSession, Turn, ContextPoint, etc.
    registry.ts         # Tool registry: discoverSessions/loadSession dispatch
    pi/                 # Pi adapter (context reconstructed from vendored pure functions)
    codex/              # Codex adapter (exact inline context — no reconstruction)
    claude/             # Claude Code adapter (exact per-request usage)
    opencode/           # opencode adapter (bun:sqlite against opencode.db)
  engine/
    tokens.ts           # Token formatting, tokenBar, relativeTime
    turns.ts            # TurnSummary, sessionTokenTotals
    context-diff.ts     # buildRequestSteps, sessionCurve, diff before/after messages
  ui/
    components.tsx      # Header, KeyHint, Spinner, useSelection
    home.tsx            # Two-pane tool picker + project list
    session-list.tsx    # Searchable session list
    session-detail.tsx  # Full transcript viewer with collapsible thinking
    context-view.tsx    # Token curve + before/after snapshot diff
    system-prompt-view.tsx
    context-files-view.tsx
  vendor/pi/            # Vendored Pi 0.83.0 pure functions (MIT) — do NOT edit by hand
    NOTE.md             # Attribution, file-to-source mapping
```

## Conventions

1. **Adapters** produce a normalized `AgentSession` (types.ts) and are registered in `registry.ts`.
   - `discoverSessions(tool)` → `SessionMeta[]`
   - `loadSession(meta)` → `AgentSession`
2. **Context reconstruction** (Pi, opencode, claude) uses vendored `buildSystemPrompt`,
   `loadProjectContextFiles`, and `buildSessionContext` from `vendor/pi/`. Codex stores
   everything inline, so `reconstructed: false`.
3. **Engine** (`context-diff.ts`) consumes precomputed `session.contextPoints` — each
   `ContextPoint.contextTokens` is the adapter's truth (input + cacheRead, or
   input + cacheRead + cacheWrite for Claude).
4. **UI screens** are pure functional components that receive everything via props
   (no async data fetching — adapters are synchronous). Navigation via `useKeyboard`.
5. **Typecheck must pass** before any commit. Run `bun run typecheck`.
6. **Keep deps minimal**: `@opentui/core`, `@opentui/react`, react, bun:sqlite. No other deps.

## Vendored Pi code

`src/vendor/pi/` is MIT-licensed code from `@earendil-works/pi-coding-agent` 0.83.0.
Do NOT edit these files by hand. If a re-sync is needed, see `src/vendor/pi/NOTE.md`.
The extractor script `scripts/extract-tool-snippets.ts` regenerates `src/vendor/pi/tool-snippets.ts`.

## Keybindings (user-facing TUI)

| Key       | Action              |
|-----------|---------------------|
| j/k       | scroll / move       |
| /         | search              |
| Enter     | open / select       |
| Tab/g/G   | switch tool         |
| c         | context view        |
| s         | system prompt       |
| f         | context files       |
| t         | toggle thinking     |
| d         | toggle snapshots    |
| ?         | help panel          |
| q/Esc     | back / quit         |

## Running

```sh
bun run start          # Launch TUI
bun run typecheck      # TypeScript check
bun run extract-tool-snippets  # Regen tool snippets from installed pi
```
