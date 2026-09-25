# Agent Context Viewer (acv)

A terminal UI that shows **how AI coding agents load context** — for every prompt it
reveals the *before* and *after* context, what was added, what was pruned by
compaction, which `AGENTS.md`/`CLAUDE.md` files were injected, and the full
reconstructed system prompt.

Built with **Bun + OpenTUI + React**. Ships **four** adapters:
- **Pi** — context reconstructed from vendored Pi internals (compaction-aware)
- **Codex** — system prompt + AGENTS.md stored inline (exact, no reconstruction)
- **Claude Code** — exact per-request usage/tokens; system prompt not persisted,
  context files reconstructed; commands shown as ⌘ lines
- **opencode** — exact per-request usage from SQLite (1548 sessions); compaction
  tracking with history cutoff (like Pi's firstKeptEntry); system prompt
  reconstructed from global + project AGENTS.md

The architecture is adapter-based; other agents (opencode, Cursor, …) plug in
with a single module.

```
╭──────────────────────╮╭──────────────────────────────────────────────────────╮
│ AGENTS               ││  PROJECTS — Pi                                       │
│ ▶ Pi        59       ││ ▶ home/arafays/projects  2 sessions                  │
│             sessions ││     20,668,373 tokens · last 47m ago                 │
│   Codex        2     ││   home/arafays  10 sessions                          │
│             sessions ││     4,679,275 tokens · last 11d ago                  │
│   Claude Code   —    ││   …                                                  │
│   opencode      —    ││   home/arafays/.local/share/chezmoi  14 sessions     │
│   Cursor        —    ││                                                      │
│   VS Code       —    ││   all Pi sessions  (59)                              │
│                      ││                                                      │
╰──────────────────────╯╰──────────────────────────────────────────────────────╯

 move j/k  tool Tab/g/G  search /  open Enter  quit q
```

## The headline screen: before/after context per prompt

Every LLM request in a session is one point on a token curve. Selecting a request
shows its context diff: messages that were **added** (green) and **pruned** (red),
plus the exact context snapshot the model saw.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ CONTEXT TOKENS PER REQUEST (input+cacheRead) — max 195.3k                    │
│ > #  0 ██░░░░░░░░░░░░░░░░░░░░░░░░  15.8k  in  15.8k  cache      0            │
│   #  2 ███░░░░░░░░░░░░░░░░░░░░░░░  20.4k  in   1.4k  cache  18.9k            │
│   #  3 ███░░░░░░░░░░░░░░░░░░░░░░░  22.3k  in   1.2k  cache  21.1k            │
│   #134 ░░░░░░░░░░░░░░░░░░░░░░░░░░  47.2k  in   4.0k  cache  43.2k  ⚒         │
╰──────────────────────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────╮
│ request #134 · ctx 47.2k tokens (−148.1k) · 51 messages in context · ⚒ …    │
│ +51 added  −321 pruned  model opencode/deepseek-v4-flash-free                │
│ ⚒ These are condensed memories from earlier in this session. …               │
│ user: …  compactionSummary: …  toolResult: …                                │
╰──────────────────────────────────────────────────────────────────────────────╯

 request j/k  snapshots d  system prompt s  scroll PgUp/PgDn  back q
```

You can see a real session grow from 15.8k tokens (first prompt) to 195k tokens,
then drop to 47k when a compaction event folds the history into a summary message.
Codex sessions need no reconstruction at all — the curve, the AGENTS.md injection,
even the exact system prompt are stored inline (`session_meta.base_instructions`
plus developer/user-role messages for permissions, AGENTS.md and skills), so the
before/after story is byte-exact.

## Screens

| Screen | Key | Shows |
| --- | --- | --- |
| Home | — | agent tools (Pi, Codex, Claude Code, opencode, …) + projects with session counts and token totals |
| Session list | `Enter` | searchable sessions: model, started, msgs, input/cache tokens, ⚒ compaction count |
| Fuzzy search | `/` | typo-tolerant content search over all sessions (fff), jump-to-turn on Enter |
| Transcript | `Enter` | full session: user prompts, thinking, tool calls + results, model changes, custom events, per-request token usage |
| Context view | `c` | token curve + before/after diff + context snapshot per request |
| System prompt | `s` | reconstructed system prompt (tools, guidelines, skills, context files) |
| Context files | `f` | the `AGENTS.md`/`CLAUDE.md` hierarchy that was loaded |
| Help | `?` | all keybindings |

## Keybindings

```
j / k        move / scroll            PgUp / PgDn   page scroll
↑ ↓          move                     Enter         open session / toggle snapshots
Tab or g / G switch agent tool (home) /             fuzzy search
c            context view             s             system prompt view
f            context files view       d / v         toggle context snapshots
t            toggle thinking blocks   ?             help
q / Esc      back / quit
```

## Fuzzy content search

Press `/` anywhere to open a **fuzzy content search** over every session (powered
by [fff](https://github.com/dmtrKovalenko/fff), a Rust-core fuzzy-search
library). It is typo-resistant, so `openroutr balnce` finds the session that
checked your OpenRouter balance.

- Searches **session content** (user prompts, assistant replies, thinking,
  tool calls/results) plus metadata — not just titles.
- Results are scoped to the current agent tool (on the home screen, the
  highlighted tool).
- `Enter` on a result opens the transcript **jumped to the matching turn**.
- The index is built once from a per-session text cache (`~/.cache/acv/`,
  rebuilt automatically when sessions change) and reuses it on later launches.

> opencode sessions index **user + assistant text** (not tool output), which
> keeps the 5GB DB fast to index while covering prompt/reply search.

## Install & run

```sh
mise use bun@latest          # runtime (already pinned in mise.toml)
bun install
bun run start                # or: bun src/main.tsx
```

The `acv` bin is defined in `package.json`:

```sh
bun link && acv
```

## Releases & AUR

A standalone **`acv` binary** (Bun + OpenTUI compiled into a single file, no
runtime needed) is published for **Linux x86_64 and aarch64** on every
`v*` git tag via `.github/workflows/release.yml`:

1. **build** — cross-compiles `dist/acv-linux-{x64,aarch64}`
   (`scripts/build-release.ts`, `bun run build:release`) and smoke-tests the
   native binary
2. **publish** — attaches the binaries + `SHA256SUMS.txt` to a GitHub Release
3. **aur** — regenerates `aur/agent-context-viewer-bin/PKGBUILD` with the new
   version and sha256sums, then pushes it to
   [AUR/agent-context-viewer-bin](https://aur.archlinux.org/packages/agent-context-viewer-bin)
   via `KSXGitHub/github-actions-deploy-aur` (`.SRCINFO` is auto-generated)

To cut a release:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

Install on Arch:

```sh
paru -S agent-context-viewer-bin
```

Manual install (any glibc Linux):

```sh
curl -fsSL -o acv https://github.com/arafays/agent-context-viewer/releases/latest/download/acv-linux-x64
chmod +x acv && sudo install -m755 acv /usr/local/bin/acv
acv
```

The workflow needs three repo secrets: `AUR_SSH_PRIVATE_KEY` (ed25519 key
whose public half is registered at <https://aur.archlinux.org/account/ARafayS> →
SSH Keys), `AUR_USERNAME`, and `AUR_EMAIL`.

## How context is reconstructed

Pi session files (`~/.pi/agent/sessions/<project-slug>/*.jsonl`) store every
message and event but **not** the system prompt. `acv` reconstructs it with the
exact same code Pi uses, vendored from `@earendil-works/pi-coding-agent@0.87.1`
(MIT, see `src/vendor/pi/NOTE.md`):

- `buildSystemPrompt` — base prompt + tool snippets + guidelines + skills + cwd
- `loadProjectContextFiles` — global `AGENTS.md` + per-level `AGENTS.md`/`CLAUDE.md`
  walking up from `cwd` (with git-worktree shadowing)
- `buildSessionContext` — compaction-aware message reconstruction (`firstKeptEntryId`,
  compaction summary messages)
- `sessionEntryToContextMessages` — entry → LLM message mapping

Per-request context size comes from the `usage` fields Pi records on every
assistant message (`input` + `cacheRead`). The before-context for request *N* is
the session state at the parent entry (i.e. what the model saw, excluding the
response itself).

**Caveat (Pi only):** `AGENTS.md` files are read as they exist *today*; if they changed
since the session ran, the reconstruction is a faithful snapshot of the current
files, not a time-travel. Tool snippets are static per Pi version.
**Codex is exact** — every view (system prompt, context files, per-request diff)
is read straight from the session file.

## Architecture

```
src/
  adapters/
    types.ts        normalized session model (ToolInfo, SessionMeta, Turn, ContextPoint…)
    registry.ts     tool registry + discovery/load dispatch
    pi/index.ts     discovery (fast header scan), tolerant JSONL parse, turn grouping, usage
    pi/context.ts   system-prompt reconstruction, per-request context points
    codex/index.ts  inline session parsing (exact): base_instructions, developer/user
                    messages (permissions/AGENTS.md/skills), token_count usage, turn_context
    claude/index.ts ~/.claude/projects/*.jsonl: per-request usage (input+cache_read+
                    cache_creation), block-grouped assistant calls, command wrappers,
                    ai-title names; system prompt not persisted → empty + note
    opencode/index.ts SQLite (~/.local/share/opencode/opencode.db): exact per-request
                    tokens from message.data; tool call/result/tool-type parts grouped
                    per request; compaction-aware cutoff for truthfully showing
                    +N/−M diff (history replaced by summary bulk)
  engine/
    turns.ts        turn summarization, token totals
    context-diff.ts before/after diff, compaction markers, token curve (uses each
                    point's own contextTokens — adapters define full-context metric)
    tokens.ts       token formatting, bars, relative time
    transcript-lines.ts  flatten sessions to single-line searchable units
                    (header `[tool] [project] [model] [date] [turn N] tag` + content)
    search-index.ts fff-backed content index: per-session cache files in
                    ~/.cache/acv/, fuzzy grep wrapper, stale cleanup
  vendor/pi/        vendored Pi internals (MIT) — session-context, system-prompt,
                    context-files, messages, tool-snippets (generated)
  ui/               home, session-list, session-detail, context-view,
                    system-prompt-view, context-files-view, search-panel,
                    components
  app.tsx           screen routing + help
scripts/
  extract-tool-snippets.ts  regenerates vendor/pi/tool-snippets.ts from installed pi
  smoke.ts                  adapter sanity check against real Pi sessions
  smoke-codex.ts            codex adapter sanity check
  smoke-claude.ts           claude adapter sanity check
  smoke-opencode.ts         opencode adapter sanity check (952 sessions)
  smoke-cursor.ts           cursor adapter sanity check (state.vscdb composers)
  smoke-vscode.ts           vscode adapter sanity check (Copilot chat sessions)
  all-tools-ui-test.tsx     drives the full UI across every available adapter
  render-test.tsx           headless snapshot of every screen
  render-loop-test.tsx      drives the full UI with fake stdin/stdout
  build-release.ts          compiles standalone acv binaries (bun build --compile)
```

Release pipeline: `.github/workflows/release.yml` (build → GitHub Release → AUR
publish), with the PKGBUILD template at `aur/agent-context-viewer-bin/`.

Adding an agent = implementing the adapter interface in `adapters/types.ts` and
registering it in `registry.ts` — the renderer is shared.

## Roadmap

- [x] Pi adapter with per-prompt before/after context
- [x] Codex adapter — exact context (system prompt inline), no reconstruction
- [x] Claude Code adapter — exact per-request usage; system prompt not persisted
- [x] opencode adapter — SQLite with 1548 sessions; exact per-request tokens,
  compaction tracking with history cutoff (truthful +N/−M diff)
- [x] Fuzzy content search across all sessions (fff), with jump-to-turn
- [x] Cursor / VS Code Copilot (VS Code: mutation-log chatSessions jsonl +
  session-store.db; Cursor: state.vscdb composer blobs)

## License

MIT. The vendored `src/vendor/pi/*` files retain their original MIT attribution
(see `src/vendor/pi/NOTE.md`).
