/** Token formatting + math helpers shared by the UI. */

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatTokensFull(n: number): string {
  return n.toLocaleString("en-US");
}

/** Total context tokens for a request = fresh input + cached prefix. */
export function contextTokens(input: number, cacheRead: number): number {
  return input + (cacheRead ?? 0);
}

/** Unicode bar for token curves (scaled 0..max → block heights). */
export function tokenBar(value: number, max: number, width = 24): string {
  if (max <= 0 || value <= 0) return "·".repeat(width);
  const full = Math.min(1, value / max);
  const filled = Math.round(full * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Human relative time, e.g. "2h ago", "3d ago", "just now". */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "?";
  const diff = now - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function shortDateTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
