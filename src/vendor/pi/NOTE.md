# Vendored Pi source (MIT)

This directory contains pure functions copied verbatim (with light TypeScript typing)
from the installed `@earendil-works/pi-coding-agent` package so this TUI can
reconstruct Pi sessions with exact fidelity.

- **Source version:** `0.83.0`
- **Source package:** `@earendil-works/pi-coding-agent` (npm)
- **Source repo:** https://github.com/earendil-works/pi (`packages/coding-agent`)
- **License:** MIT

## What was vendored and from where (in `dist/`)

| File here | Source | Notes |
|---|---|---|
| `session-context.ts` | `core/session-manager.js` | `parseSessionEntries`, `migrateSessionEntries`, `getLatestCompactionEntry`, `buildSessionPath`, `getSessionContextSettings`, `sessionEntryToContextMessages`, `buildContextEntries`, `buildSessionContext`, `loadEntriesFromFile` (+ `parseSessionEntryLine`) |
| `system-prompt.ts` | `core/system-prompt.js` + `core/skills.js` (`formatSkillsForPrompt`) | `buildSystemPrompt` — docs paths resolved against installed package dir at runtime |
| `context-files.ts` | `core/resource-loader.js` (`loadProjectContextFiles`, `loadContextFileFromDir`, `findShadowedContextFile`) + `core/footer-data-provider.js` (`findGitPaths`) + `utils/paths.js` (`canonicalizePath`, `resolvePath`) | AGENTS.md/CLAUDE.md hierarchy discovery |
| `messages.ts` | `core/messages.js` | `createCustomMessage`, `createCompactionSummaryMessage`, `createBranchSummaryMessage`, `convertToLlm`, `bashExecutionToText`, summary prefixes/suffixes |
| `tool-snippets.ts` | `core/tools/*.js` (`promptSnippet`/`promptGuidelines` per tool) | **Generated** by `scripts/extract-tool-snippets.ts` — do not edit by hand |

## Re-syncing after a Pi upgrade

```sh
bun run extract-tool-snippets   # regenerates tool-snippets.ts for the installed version
```

Then manually diff `session-context.ts` / `system-prompt.ts` / `context-files.ts` /
`messages.ts` against the new `dist/` and port any changes. The pure functions are
stable, but compaction/session-format changes (version bumps) land here first.

## Fidelity notes

- `buildSystemPrompt` output depends on the tool set active during a session. We use
  the session's own tool activity + the installed version's snippets, so reconstruction
  is exact for default tool sets and best-effort when custom tools were loaded.
- `loadProjectContextFiles(cwd)` reads AGENTS.md files **as they exist today** — Pi does
  not snapshot them into the session file, so historical sessions show a "reconstructed,
  may differ from session date" caveat in the UI.
