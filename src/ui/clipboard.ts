import type { CliRenderer } from "@opentui/core"

/** OSC 52 targets the terminal user's clipboard, including over SSH. */
export function copyText(renderer: CliRenderer, text: string): string {
  if (!text) return "Nothing to copy"
  try {
    if (!renderer.isOsc52Supported()) return "Clipboard unavailable in this terminal"
    return renderer.copyToClipboardOSC52(text) ? "Copy sent to clipboard" : "Clipboard copy failed"
  } catch {
    return "Clipboard copy failed"
  }
}
