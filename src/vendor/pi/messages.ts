/**
 * Vendored from @earendil-works/pi-coding-agent 0.87.1 `dist/core/messages.js` (MIT).
 * Verified line-by-line against 0.87.1 dist (.js runtime + .d.ts types).
 * See NOTE.md in this directory.
 */
import type { AgentMessage, ContentBlock } from "./types.ts"

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`
export const BRANCH_SUMMARY_SUFFIX = `</summary>`

/** Convert a BashExecutionMessage to user message text for LLM context. */
export function bashExecutionToText(msg: {
  command?: string
  output?: string
  cancelled?: boolean
  exitCode?: number | null
  truncated?: boolean
  fullOutputPath?: string
}): string {
  let text = `Ran \`${msg.command}\`\n`
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``
  } else {
    text += "(no output)"
  }
  if (msg.cancelled) {
    text += "\n\n(command cancelled)"
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`
  }
  return text
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): AgentMessage {
  return {
    role: "branchSummary",
    summary,
    fromId,
    timestamp: new Date(timestamp).getTime()
  } as unknown as AgentMessage
}

export function createCompactionSummaryMessage(summary: string, tokensBefore: number, timestamp: string): AgentMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore,
    timestamp: new Date(timestamp).getTime()
  } as unknown as AgentMessage
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
  customType: string,
  content: ContentBlock[] | string | null | undefined,
  display: boolean | undefined,
  details: unknown,
  timestamp: string
): AgentMessage {
  return {
    role: "custom",
    customType,
    content,
    display,
    details,
    timestamp: new Date(timestamp).getTime()
  } as unknown as AgentMessage
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 * Used to render the exact text a model saw for each context message.
 */
export function convertToLlm(messages: AgentMessage[]): Array<{
  role: "system" | "user" | "assistant" | "toolResult"
  content: ContentBlock[]
  timestamp?: number
}> {
  return messages
    .map((m) => {
      switch (m.role) {
        case "bashExecution":
          // Skip messages excluded from context (!! prefix)
          if (m.excludeFromContext) return undefined
          return {
            role: "user" as const,
            content: [{ type: "text", text: bashExecutionToText(m as never) }],
            timestamp: m.timestamp as number
          }
        case "custom": {
          // dist passes content through untouched (its type forbids null); our
          // loose AgentMessage.content allows null, so cast instead of adding a
          // `?? []` fallback that would diverge from dist behavior.
          const content =
            typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as ContentBlock[])
          return {
            role: "user" as const,
            content,
            timestamp: m.timestamp as number
          }
        }
        case "branchSummary":
          return {
            role: "user" as const,
            content: [{ type: "text", text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
            timestamp: m.timestamp as number
          }
        case "compactionSummary":
          return {
            role: "user" as const,
            content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX }],
            timestamp: m.timestamp as number
          }
        case "system":
        case "user":
        case "assistant":
        case "toolResult":
          return m as never
        default:
          return undefined
      }
    })
    .filter((m) => m !== undefined)
}
