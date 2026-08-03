/**
 * GENERATED FILE — do not edit by hand.
 * Per-tool prompt snippets/guidelines extracted from the installed
 * @earendil-works/pi-coding-agent@0.83.0 dist/core/tools/*.js (MIT).
 * Regenerate with: bun run extract-tool-snippets
 */
export const TOOL_PROMPT_SNIPPETS: Record<string, { snippet?: string; guidelines?: string[] }> = {
  "read": {
    "snippet": "Read file contents",
    "guidelines": [
      "Use read to examine files instead of cat or sed."
    ]
  },
  "write": {
    "snippet": "Create or overwrite files",
    "guidelines": [
      "Use write only for new files or complete rewrites."
    ]
  },
  "edit": {
    "snippet": "Make precise file edits with exact text replacement, including multiple disjoint edits in one call"
  },
  "bash": {
    "snippet": "Execute bash commands (ls, grep, find, etc.)"
  },
  "grep": {
    "snippet": "Search file contents for patterns (respects .gitignore)"
  },
  "find": {
    "snippet": "Find files by glob pattern (respects .gitignore)"
  },
  "ls": {
    "snippet": "List directory contents"
  }
};
