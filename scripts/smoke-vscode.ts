/**
 * VS Code (Copilot Chat) adapter sanity check against the real chat stores.
 *   bun scripts/smoke-vscode.ts
 *
 * Prints discovery counts + samples (turns/usage/contextInfo/notes/context
 * points). Exits 0 even when no VS Code store exists on this machine.
 */
import { createMetaCache } from "../src/engine/meta-cache.ts";
import { discoverSessions, loadSession } from "../src/adapters/vscode/index.ts";

const t0 = performance.now();
const metas = discoverSessions();
console.log(`vscode sessions: ${metas.length}  (discovery ${(performance.now() - t0).toFixed(0)}ms)`);

// second pass through the sidecar meta cache (cold the very first time,
// warm afterwards — unchanged files skip replay entirely)
const cache = createMetaCache();
const t1 = performance.now();
const cached = discoverSessions(cache);
console.log(`cached pass: ${cached.length} sessions  (${(performance.now() - t1).toFixed(0)}ms)`);

if (metas.length === 0) {
  console.log("no VS Code / github.copilot-chat stores found — nothing to load (still OK)");
  process.exit(0);
}

const totals = metas.reduce(
  (acc, m) => {
    acc.userMessages += m.userMessages;
    acc.assistantMessages += m.assistantMessages;
    acc.toolResults += m.toolResults;
    acc.input += m.tokens.input;
    acc.output += m.tokens.output;
    return acc;
  },
  { userMessages: 0, assistantMessages: 0, toolResults: 0, input: 0, output: 0 }
);
console.log(
  `  user=${totals.userMessages} assistant=${totals.assistantMessages} toolInvocations=${totals.toolResults} ` +
    `tokens in=${fmt(totals.input)} out=${fmt(totals.output)}`
);
console.log(`  newest: ${metas[0]?.id.slice(0, 8)} "${metas[0]?.name ?? ""}" [${metas[0]?.cwd}]`);

const shown = new Set<string>();
const recent = metas[0];
const big = [...metas].sort((a, b) => b.messageCount - a.messageCount)[0];
const dbOnly = metas.find((m) => !m.path.endsWith(".jsonl"));
const withUsage = [...metas]
  .sort((a, b) => b.tokens.input - a.tokens.input)
  .find((m) => m.tokens.input > 0);

for (const meta of [recent, big, dbOnly, withUsage].filter(Boolean)) {
  if (!meta) continue;
  if (shown.has(meta.id)) continue;
  shown.add(meta.id);
  const t1 = performance.now();
  const s = loadSession(meta);
  const dur = (performance.now() - t1).toFixed(0);
  console.log(`\n=== ${meta.id.slice(0, 8)} "${meta.name ?? ""}" [${meta.cwd}] (load ${dur}ms) ===`);
  console.log(
    `  source=${meta.path.endsWith(".jsonl") ? "chatSessions jsonl" : "session-store.db"} ` +
      `turns=${s.turns.length} assistantCalls=${s.assistantCalls.length} contextPoints=${s.contextPoints.length}`
  );
  console.log(`  model=${meta.model ?? "—"} tokens=${JSON.stringify(meta.tokens)}`);
  const info = s.contextInfo;
  console.log(
    `  systemPrompt=${info.systemPrompt.length} chars (${info.reconstructed ? "reconstructed" : "exact"}) ` +
      `· files=${info.contextFiles.length} · skills=${info.skills.map((k) => k.name).join(",") || "none"} ` +
      `· tools=${info.tools.slice(0, 8).join(",") || "none"}${info.tools.length > 8 ? ", …" : ""}`
  );
  const pts = s.contextPoints;
  if (pts.length) {
    const first = pts[0];
    if (first) console.log(`  req#${first.requestIndex} ctx=${fmt(first.contextTokens)} tokens · ${first.contextMessages.length} msgs in context`);
    const last = pts[pts.length - 1];
    if (last) console.log(`  last req#${last.requestIndex} ctx=${fmt(last.contextTokens)} tokens`);
  } else {
    console.log("  contextPoints=0 (no per-request usage persisted for this session)");
  }
  const kinds = new Map<string, number>();
  for (const e of s.events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  console.log(`  events=${s.events.length} ${JSON.stringify(Object.fromEntries(kinds))}`);
  console.log(`  raw=${typeof s.raw === "object" && s.raw ? Object.keys(s.raw).join(",") : "—"}`);
  if (info.notes.length) {
    for (const n of info.notes) console.log(`  note: ${n}`);
  }
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
