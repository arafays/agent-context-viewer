# Agent Context Viewer

TUI showing how AI coding agents assemble context: system prompts, AGENTS.md/CLAUDE.md files,
per-turn context before/after, compaction ("pruning"), and full session transcripts.

## Stack & conventions

- **Bun** (mise-managed) + TypeScript + **OpenTUI** (`@opentui/core` + `@opentui/react`). No build step.
- Run: `bun run start`. Typecheck: `bun run typecheck`.
- `src/vendor/pi/*` is vendored verbatim (MIT) from the installed `@earendil-works/pi-coding-agent`
  dist — do NOT edit by hand; re-sync per `src/vendor/pi/NOTE.md`.
- Adapters (one per agent) live in `src/adapters/<tool>/` and produce the normalized `AgentSession`.
- Keep deps minimal: `@opentui/core`, `@opentui/react`, react, bun:sqlite only.
- Use Bun builtins (`Bun.file`, `bun:sqlite`) over node libs.
- Read `AGENTS.md` for the full project guide.
