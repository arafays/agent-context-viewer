# Agent Context Viewer

TUI showing how AI coding agents assemble context: system prompts, AGENTS.md/CLAUDE.md files,
per-turn context before/after, compaction ("pruning"), and full session transcripts.

## Stack & conventions

- **Bun** (mise-managed) + TypeScript + **Ink** (React for terminals). No build step: `bun run src/main.tsx`.
- Run: `bun run start`. Typecheck: `bun run typecheck`.
- `src/vendor/pi/*` is vendored verbatim (MIT) from the installed `@earendil-works/pi-coding-agent`
  dist — do NOT edit by hand; re-sync per `src/vendor/pi/NOTE.md`.
- Adapters (one per agent) live in `src/adapters/<tool>/` and produce the normalized model in `src/adapters/types.ts`.
- Keep deps minimal: ink, react only. Use Bun builtins (`Bun.file`, `bun:sqlite`) over node libs.
