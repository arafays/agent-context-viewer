# Agent Context Viewer (acv)

A terminal UI that shows **how AI coding agents load context** — for every prompt it
reveals the *before* and *after* context, what was added, what was pruned by
compaction, which `AGENTS.md`/`CLAUDE.md` files were injected, and the full
reconstructed system prompt.

Built with **Bun + React + Ink**. Ships **Pi** (context reconstructed from vendored
Pi internals) and **Codex** (system prompt + AGENTS.md stored inline — exact, no
reconstruction). The architecture is adapter-based so other agents (Claude Code,
opencode, Cursor, …) plug in with a single module.

```
╭──────────────────────╮╭──────────────────────────────────────────────────────╮
│ AGENTS               ││  PROJECTS — Pi                                       │
│ ▶ Pi        59       ││ ▶ home/arafays/projects  2 sessions                  │
│             sessions ││     20,668,373 tokens · last 47m ago                 │
│   Codex        2     ││   home/arafays  10 sessions                          │
│             sessions ││     4,679,275 tokens · last 11d ago                  │
│   Claude Code   —    ││   …                                                  │
│   opencode      —    ││   home/arafays/.local/share/chezmoi  14 sessions     │
│   Command Code  —    ││     17,152,463 tokens · last 13d ago                 │
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
| Home | — | agent tools (Pi, Codex, …) + projects with session counts and token totals |
| Session list | `Enter` | searchable sessions: model, started, msgs, input/cache tokens, ⚒ compaction count |
| Transcript | `Enter` | full session: user prompts, thinking, tool calls + results, model changes, custom events, per-request token usage |
| Context view | `c` | token curve + before/after diff + context snapshot per request |
| System prompt | `s` | reconstructed system prompt (tools, guidelines, skills, context files) |
| Context files | `f` | the `AGENTS.md`/`CLAUDE.md` hierarchy that was loaded |
| Help | `?` | all keybindings |

## Keybindings

```
j / k        move / scroll            PgUp / PgDn   page scroll
↑ ↓          move                     Enter         open session / toggle snapshots
Tab or g / G switch agent tool (home) /             search / filter
c            context view             s             system prompt view
f            context files view       d / v         toggle context snapshots
t            toggle thinking blocks   ?             help
q / Esc      back / quit
```

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

## How context is reconstructed

Pi session files (`~/.pi/agent/sessions/<project-slug>/*.jsonl`) store every
message and event but **not** the system prompt. `acv` reconstructs it with the
exact same code Pi uses, vendored from `@earendil-works/pi-coding-agent@0.83.0`
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
  engine/
    turns.ts        turn summarization, token totals
    context-diff.ts before/after diff, compaction markers, token curve
    tokens.ts       token formatting, bars, relative time
  vendor/pi/        vendored Pi internals (MIT) — session-context, system-prompt,
                    context-files, messages, tool-snippets (generated)
  ui/               home, session-list, session-detail, context-view,
                    system-prompt-view, context-files-view, components
  app.tsx           screen routing + help
scripts/
  extract-tool-snippets.ts  regenerates vendor/pi/tool-snippets.ts from installed pi
  smoke.ts                  adapter sanity check against real sessions
  render-test.tsx           headless snapshot of every screen
  render-loop-test.tsx      drives the full UI with fake stdin/stdout
```

Adding an agent = implementing the adapter interface in `adapters/types.ts` and
registering it in `registry.ts` — the renderer is shared.

## Roadmap

- [x] Pi adapter with per-prompt before/after context
- [x] Codex adapter — exact context (system prompt inline), no reconstruction
- [ ] Claude Code (`~/.claude/projects/*/*.jsonl`)
- [ ] opencode (`~/.local/share/opencode/` SQLite)
- [ ] Codex (`~/.codex/sessions/` — system prompt stored inline)
- [ ] command-code (`~/.commandcode/projects/`)
- [ ] Cursor / VS Code Copilot (SQLite stores)

## License

MIT. The vendored `src/vendor/pi/*` files retain their original MIT attribution
(see `src/vendor/pi/NOTE.md`).
