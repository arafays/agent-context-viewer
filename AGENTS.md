# Agent Context Viewer — project instructions

TUI that shows how AI coding agents assemble context: system prompts,
AGENTS.md/CLAUDE.md files, per-turn context before/after snapshots,
compaction ("pruning") events, and full session transcripts.

## Package manager / runner: use `aube`

Run everything through **aube** (jdx.dev's pnpm-style Node package manager,
pronounced "ohb", mise-managed). It reads/writes `yarn.lock`, `pnpm-lock.yaml`,
or `package-lock.json` and auto-installs deps when a script is stale — so
`aube run <script>` is the single command for running anything in `package.json`
(CI pins the installed lockfile with `aube install --frozen-lockfile`). If the
legacy `bun.lock` is still around, `aube import` converts it; scripts that need
Bun specifically (e.g. `bun:sqlite`, standalone builds) are invoked inside the
script itself, not via a separate runner.

## Stack

- **Bun** runtime (mise-managed) + TypeScript 7 + **OpenTUI** (`@opentui/core` + `@opentui/react`), all driven via `aube run`.
- No build step to run the TUI: `aube run start` (or `bun src/main.tsx` directly).
- Typecheck: `aube run typecheck` (tsc --noEmit). Biome for format + lint
  (`aube run format` / `format:check` / `lint`).
- `aube install` runs a `prepare` script (`effect-tsgo patch --typescript --no-oxlint`)
  that patches the installed TypeScript — a fresh install can mutate
  `node_modules/typescript`.

## Source layout

```
src/
  main.tsx              # Entry: createCliRenderer + createRoot(<App/>)
  app.tsx               # Screen router (home → list → detail → context/sysprompt/files)
  adapters/
    types.ts            # Normalized model: AgentSession, Turn, ContextPoint, etc.
    registry.ts         # Tool registry: TOOLS[] + discoverSessions/loadSession dispatch
    pi/  codex/  claude/  opencode/   # One module per agent (see README "How context is reconstructed")
  engine/
    tokens.ts           # Token formatting, tokenBar, relativeTime
    turns.ts            # TurnSummary, sessionTokenTotals
    context-diff.ts     # buildRequestSteps, sessionCurve, diff before/after messages
    transcript-lines.ts # Sessions → single-line searchable units ([tool] [proj] [model] [date] [turn N] tag)
    search-index.ts     # fff-backed content index (~/.cache/acv/), fuzzy grep wrapper
    meta-cache.ts       # ~/.cache/acv/meta/ JSON sidecars keyed by source path (size+mtime guard, CURRENT_VERSION)
    session-store.ts    # Cache-first async discovery: paints UI immediately, streams tool lists in
  ui/
    components.tsx      # Header, KeyHint, Spinner, useSelection
    home.tsx            # Two-pane tool picker + project list
    session-list.tsx    # Session list
    session-detail.tsx  # Full transcript viewer with collapsible thinking
    search-panel.tsx    # Fuzzy content search overlay (fff), jump-to-turn on Enter
    context-view.tsx    # Token curve + before/after snapshot diff
    system-prompt-view.tsx
    context-files-view.tsx
    reader.tsx          # Focused block reader (bash/custom event payloads)
    overlay.ts          # overlayOpen flag — gates keys while a modal is up
    theme.ts            # Palette from real ANSI colors (WCAG checked), light/dark aware
    util.ts
  vendor/pi/            # Vendored Pi 0.83.0 pure functions (MIT) — do NOT edit by hand
    NOTE.md             # Attribution, file-to-source mapping
```

## Conventions

1. **Adapters** produce a normalized `AgentSession` (types.ts) and are registered in `registry.ts` (`TOOLS`, `available` flag, `storage` paths).
   - `discoverSessions(tool)` → `SessionMeta[]`
   - `loadSession(meta)` → `AgentSession`
   - Discovery also populates `meta.searchText` (cheap, structured header/content
     lines via `SearchFileBuilder` in `engine/transcript-lines.ts`) so the fuzzy
     index never needs a full `loadSession`.
2. **Context reconstruction** (Pi, opencode, claude) uses vendored `buildSystemPrompt`,
   `loadProjectContextFiles`, and `buildSessionContext` from `vendor/pi/`. Codex stores
   everything inline, so `reconstructed: false`.
3. **Engine** (`context-diff.ts`) consumes precomputed `session.contextPoints` — each
   `ContextPoint.contextTokens` is the adapter's truth (input + cacheRead, or
   input + cacheRead + cacheWrite for Claude).
4. **UI screens** are pure functional components that receive everything via props
   (no async data fetching — adapters are synchronous; async discovery lives in
   `engine/session-store.ts`). Navigation via `useKeyboard`.
5. **Typecheck must pass** before any commit. Run `aube run typecheck`.
6. **Keep deps minimal**: `@opentui/core`, `@opentui/react`, react, `@ff-labs/fff-bun`,
   effect (runtime), plus devDeps `@biomejs/biome`, `@effect/{language-service,tsgo}`,
   typescript. `bun:sqlite` is a Bun builtin (opencode adapter).
7. **Fuzzy search**: `engine/search-index.ts` materializes each session to a text
   file in `~/.cache/acv/<tool>/<project>/<id>.txt` (header line + content line
   per message — odd lines headers with `[turn N]`, even content), indexes the
   dir with `FileFinder`, and greps `mode: "fuzzy"`. Never pass an empty array
   for a tool you didn't discover — the stale-file cleanup treats enumerated
   tools as authoritative.

## Vendored Pi code

`src/vendor/pi/` is MIT-licensed code from `@earendil-works/pi-coding-agent` 0.83.0.
Do NOT edit these files by hand. If a re-sync is needed, see `src/vendor/pi/NOTE.md`.
The extractor script `scripts/extract-tool-snippets.ts` regenerates `src/vendor/pi/tool-snippets.ts`.

## Scripts (`scripts/`) and smoke tests

Run smoke tests against the real local agent stores (Pi/, Codex/, ~/.claude/, opencode.db):

```sh
aube run scripts/smoke.ts            # Pi adapter
aube run scripts/smoke-codex.ts      # Codex adapter
aube run scripts/smoke-claude.ts     # Claude adapter
aube run scripts/smoke-opencode.ts   # opencode adapter (SQLite)
aube run scripts/verify-compaction.ts  # compaction curve sanity check (Pi)
aube run scripts/build-release.ts    # standalone acv binary (env: BUN_TARGET/ASSET/ACV_VERSION); needs OPENTUI_LIBC=glibc
aube run extract-tool-snippets       # regen tool-snippets.ts from installed pi (script not in scripts/ package script)
```

CI (`.github/workflows/release.yml`) is tag-driven (`v*`): build standalone
linux-x64/aarch64 binaries (`aube install --frozen-lockfile --os="*" --cpu="*"`
for cross-compile), attach to GitHub Release, regenerate + push `aur/agent-context-viewer-bin/PKGBUILD`.

## Keybindings (user-facing TUI)

| Key     | Action             |
| ------- | ------------------ |
| j/k     | scroll / move      |
| /       | fuzzy search (fff) |
| Enter   | open / select      |
| Tab/g/G | switch tool        |
| c       | context view       |
| s       | system prompt      |
| f       | context files      |
| t       | toggle thinking    |
| d       | toggle snapshots   |
| ?       | help panel         |
| q/Esc   | back / quit        |

## Running

```sh
aube install              # runs prepare: effect-tsgo patch --typescript --no-oxlint
aube run start            # Launch TUI
aube run typecheck        # TypeScript check
aube run format           # biome format --write src
aube run lint             # biome check src
```

# Development

- always load `effect` skill
- to update ui load `opentui` skill
