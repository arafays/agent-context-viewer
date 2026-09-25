/**
 * GENERATED FILE — do not edit by hand.
 * Per-tool prompt snippets/guidelines extracted from the installed
 * @earendil-works/pi-coding-agent@0.87.1 dist/core/tools/index.js (MIT, createAllToolDefinitions).
 * Regenerate with: bun run extract-tool-snippets
 */
export const TOOL_PROMPT_SNIPPETS: Record<string, { snippet?: string; guidelines?: string[] }> = {
  read: {
    snippet: "Read file contents",
    guidelines: ["Use read to examine files instead of cat or sed."]
  },
  bash: {
    snippet: "Execute bash commands (ls, grep, find, etc.)",
    guidelines: ["You can inspect PI_* environment variables for current model and session details."]
  },
  powershell: {
    snippet: "Execute PowerShell commands",
    guidelines: ["You can inspect PI_* environment variables for current model and session details."]
  },
  edit: {
    snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    guidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions."
    ]
  },
  write: {
    snippet: "Create or overwrite files",
    guidelines: ["Use write only for new files or complete rewrites."]
  },
  grep: {
    snippet: "Search file contents for patterns (respects .gitignore)"
  },
  find: {
    snippet: "Find files by glob pattern (respects .gitignore)"
  },
  ls: {
    snippet: "List directory contents"
  }
}
