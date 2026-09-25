# Vendored Pi source (MIT)

This directory contains pure functions copied verbatim (with light TypeScript typing)
from the installed `@earendil-works/pi-coding-agent` package so this TUI can
reconstruct Pi sessions with exact fidelity.

- **Source version:** `0.87.1`
- **Source package:** `@earendil-works/pi-coding-agent` (npm)
- **Source repo:** https://github.com/earendil-works/pi (`packages/coding-agent`)
- **License:** MIT

## What was vendored and from where (in `dist/`)

| File here | Source | Notes |
|---|---|---|
| `session-context.ts` | `core/session-manager.js` | `parseSessionEntries`, `migrateSessionEntries`, `getLatestCompactionEntry`, `buildSessionPath`, `getSessionContextSettings`, `sessionEntryToContextMessages`, `buildContextEntries`, `projectContextEntry`, `buildSessionProjection`, `buildSessionContext`, `loadEntriesFromFile` (+ `parseSessionEntryLine`) — synced at 0.87.1 (`CURRENT_SESSION_VERSION` = 3 in both). **Omission:** dist's trailing `appendFileSync` repair in `loadEntriesFromFile` (rewrites a session file missing its final newline) is intentionally not ported — this viewer is read-only |
| `system-prompt.ts` | `core/system-prompt.js` + `core/skills.js` (`formatSkillsForPrompt`) | `buildSystemPrompt` — docs paths resolved against installed package dir at runtime (`getPiPackageDir`, realpathed so they match what the running pi prints). Sections joined with `"\n\n"` exactly like pi-ai's `getSystemMessageText` |
| `context-files.ts` | `core/resource-loader.js` (`loadProjectContextFiles`, `loadContextFileFromDir`, `findShadowedContextFile`) + `core/footer-data-provider.js` (`findGitPaths`) + `utils/paths.js` (`canonicalizePath`, `resolvePath`) | AGENTS.md/CLAUDE.md hierarchy discovery, incl. `AGENTS.override.md` + BOM stripping |
| `messages.ts` | `core/messages.js` | `createCustomMessage`, `createCompactionSummaryMessage`, `createBranchSummaryMessage`, `convertToLlm` (incl. the `system` role case), `bashExecutionToText`, summary prefixes/suffixes — synced at 0.87.1 |
| `paths.ts` | `utils/paths.js` + `.d.ts` | `PathInputOptions`, `canonicalizePath`, `normalizeWindowsShellPath`, `normalizePath`, `resolvePath` — synced at 0.87.1. Not ported (unused here): `getFileRevision`, `isLocalPath`, `getCwdRelativePath`, `formatPathRelativeToCwdOrAbsolute`, `markPathIgnoredByCloudSync` (spawns `xattr`/`setfattr`) |
| `types.ts` | `core/session-manager.d.ts` + `core/messages.d.ts` | Structural subset of pi's session/message types, incl. 0.87.1 additions: `UsageEntry`, `ContextEditEntry`, `CompactionEntry.systemMessage`, `ProjectedSessionEntry`/`SessionProjection`, `"system"` role |
| `tool-snippets.ts` | `core/tools/index.js` | **Generated** by `scripts/extract-tool-snippets.ts` — do not edit by hand. Extracts `promptSnippet`/`promptGuidelines` from `createAllToolDefinitions(cwd, {})` (falling back to a source scan for older versions) |

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
- `getPiPackageDir()` mirrors pi's own `getPackageDir()` (`PI_PACKAGE_DIR` env, then the
  mise npm install layouts, then `node_modules`) and returns the realpath, so the docs
  paths embedded in `<docs>` match the running pi's `import.meta.url`.
- `loadProjectContextFiles(cwd)` reads AGENTS.md files **as they exist today** — Pi does
  not snapshot them into the session file, so historical sessions show a "reconstructed,
  may differ from session date" caveat in the UI.
- Skills / SYSTEM.md / extension prompt snippets are loaded by the adapter (not vendored):
  see `src/adapters/pi/resources.ts` (trust.json, SYSTEM.md/APPEND_SYSTEM.md precedence,
  skill root discovery, SKILL.md frontmatter) and `src/adapters/pi/extension-prompt.ts`
  (best-effort static scrape of extension `promptSnippet`/`promptGuidelines`).
- **A/B verified**: an offline harness feeds pi's own `DefaultResourceLoader` +
  `buildSystemPrompt` (installed dist) and the adapter's loaders + vendored builder
  identical inputs and diffs the results. Final state: `EQUAL: true` and
  `SKILLS EQUAL: true` across 4 cwds (trusted project, untrusted home dir, two
  untrusted config dirs) — final prompt text byte-identical, skill list identical
  incl. order (skill roots are ordered by pi's `resourcePrecedenceRank`).

### Known micro-divergences (adapter side)

- **Skill ignore-files**: pi filters skill files through the `ignore` package
  (`.gitignore`-style rules under each skill root). Not replicated — adding the dep is
  out of scope; equal on any machine without ignore files in skill roots.
- **`disable-model-invocation: "true"` (quoted)**: pi YAML-parses to a string and
  checks `=== true` (so quoted stays false); our string parser can't tell quoted from
  unquoted and treats `"true"` as enabled. No skill on this machine uses the key.
- **Skill recursion depth**: `collectSkillEntries` caps recursion at depth 4; pi recurses
  unbounded. Safety net only — no skill tree on this machine reaches depth 4.
- **`settings.defaultTools`**: pi honours a `defaultTools` setting when picking the
  base tool set; the key is absent from every settings.json here, so the verified
  `["read","bash","edit","write"]` default is used and the setting is not read.
- **Extension tools never called**: pi activates *all* extension tools
  (`includeAllExtensionTools: true`), but a tool that was never called leaves no trace
  in the session file, so it can't be observed. The adapter discloses the omission in
  the notes instead of guessing.
- **`settings.skills` expansion + enable patterns**: pi expands a *directory* entry
  through `collectResourceFiles` (always mode "pi") and interprets `!`/`+`/`-` entries
  as enable/disable patterns (both `settings.skills` and package `pi.skills` manifests).
  We hand the directory to the mode-aware skill-root walk and ignore patterns —
  identical results for SKILL.md / root-`.md` layouts. No `settings.skills` entries
  exist on this machine, so the gap is unreachable here.
- **`.md` rule depends on how a root arrives (theoretical)**: package-manager
  discovery — what we mirror — is mode-aware (`pi` → root-level `.md` only,
  `agents` → nested `.md` only). A root that reaches pi's `loadSkills` as a plain
  *directory* (extension-contributed `skillPaths`) instead goes through
  `loadSkillsFromDirInternal`, which loads root-level `.md` for *any* directory and
  never nested non-SKILL `.md` — the opposite rule for `.agents/skills`. Divergence
  needs an extension passing such a dir as a skillPath; none does here (A/B equal on
  all 4 tested cwds).
- **MCP tool snippet source**: pi-mcp-adapter generates snippets at runtime from live
  server tool descriptions; we rebuild them statically from `~/.pi/agent/mcp-cache.json`
  with the adapter's own logic (`truncateAtWord(desc, 100)`, server-prefix
  sanitisation, both prefixed/unprefixed name shapes). A stale cache (server removed
  or description changed since last pi run) yields missing or stale snippets.
