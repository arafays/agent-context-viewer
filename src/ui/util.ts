import { homedir } from "node:os";

/** Shared text helpers for the UI. */

/** Replace the user's home-directory prefix with `~` for display. */
export function tildeHome(p: string): string {
  if (!p) return p;
  const home = homedir();
  if (!home) return p;
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

/**
 * Word-wrap `text` to `width` columns. Existing `\n` are preserved as line
 * breaks; over-long words are hard-broken. Returns an array of visual lines
 * (empty strings keep their own entry so blank lines render).
 */
export function wordWrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      out.push("");
      continue;
    }
    let line = raw;
    while (line.length > w) {
      // Prefer breaking after the last whitespace within the width window.
      let breakAt = line.lastIndexOf(" ", w);
      if (breakAt <= 0) breakAt = w; // no space — hard break
      out.push(line.slice(0, breakAt));
      line = line.slice(breakAt);
      // collapse a single leading space left by the break
      if (line.startsWith(" ")) line = line.slice(1);
    }
    if (line.length > 0 || out.length === 0) out.push(line);
    else out.push(""); // trailing empty after a break exactly at width
  }
  return out;
}

/** Hard-truncate to `width` with a trailing ellipsis. */
export function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return width > 1 ? text.slice(0, width - 1) + "…" : "…";
}