/**
 * opencode adapter sanity check against the real DB.
 *   bun run scripts/smoke-opencode.ts
 */
import { discoverSessions, loadSession } from "../src/adapters/opencode/index.ts";

const t0 = performance.now();
const metas = discoverSessions();
console.log(`opencode sessions: ${metas.length}  (discovery ${(performance.now() - t0).toFixed(0)}ms)`);

// recent + a compaction session + a huge session
const recent = metas[0];
const comp = metas.find((m) => m.compactionCount > 0);
const big = [...metas].sort((a, b) => b.tokens.input - a.tokens.input)[0];
for (const meta of [recent, comp, big].filter(Boolean)) {
  if (!meta) continue;
  const t1 = performance.now();
  const s = loadSession(meta);
  const dur = (performance.now() - t1).toFixed(0);
  console.log(`\n=== ${meta.id.slice(0, 8)} "${meta.name ?? ""}" [${meta.cwd}] (load ${dur}ms) ===`);
  console.log(`  turns=${s.turns.length} assistantCalls=${s.assistantCalls.length} contextPoints=${s.contextPoints.length}`);
  console.log(`  model=${meta.model ?? "—"} tokens=${JSON.stringify(meta.tokens)}`);
  console.log(`  systemPrompt=${s.contextInfo.systemPrompt.length} chars (${s.contextInfo.reconstructed ? "reconstructed" : "exact"}) · files=${s.contextInfo.contextFiles.length} · skills=${s.contextInfo.skills.map((k) => k.name).join(",") || "none"} · tools=${s.contextInfo.tools.join(",")}`);
  const pts = s.contextPoints;
  if (pts.length) {
    const first = pts[0];
    if (first) console.log(`  req#0 ctx=${fmt(first.contextTokens)} tokens · ${first.contextMessages.length} msgs in context`);
    const last = pts[pts.length - 1]!;
    console.log(`  last req#${last.requestIndex} ctx=${fmt(last.contextTokens)}`);
  }
  const ev = s.events;
  const kinds = new Map<string, number>();
  for (const e of ev) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  console.log(`  events=${ev.length} ${JSON.stringify(Object.fromEntries(kinds))}`);
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
