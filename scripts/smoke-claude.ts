/**
 * Claude Code adapter smoke test — runs against real sessions in ~/.claude/projects.
 *   bun run scripts/smoke-claude.ts
 */
import { discoverSessions, loadSession } from "../src/adapters/claude/index.ts";
import { sessionCurve } from "../src/engine/context-diff.ts";
import { formatTokens } from "../src/engine/tokens.ts";

const metas = discoverSessions();
console.log(`claude sessions: ${metas.length}`);
const top = metas.slice(0, 10);
for (const m of top) {
  console.log(
    `  ${m.startedAt}  ${m.project.padEnd(28)} msgs=${String(m.messageCount).padStart(4)} in=${formatTokens(m.tokens.input).padStart(8)} cache=${formatTokens(m.tokens.cacheRead).padStart(9)} ${Math.round(m.sizeBytes / 1024)}KB  ${m.name ?? ""}`,
  );
}

for (const meta of top.slice(0, 3)) {
  const s = loadSession(meta.path);
  console.log(`\n=== ${meta.project} ${meta.id.slice(0, 8)} "${meta.name ?? ""}" ===`);
  console.log(`  turns=${s.turns.length} assistantCalls=${s.assistantCalls.length} contextPoints=${s.contextPoints.length}`);
  console.log(`  model=${s.meta.model ?? "?"} tokens=${JSON.stringify(s.meta.tokens)}`);
  console.log(`  systemPrompt=${s.contextInfo.systemPrompt.length} chars (unavailable) · files=${s.contextInfo.contextFiles.length}`);
  console.log(`  tools=${s.contextInfo.tools.join(", ") || "none"}`);
  const curve = sessionCurve(s.contextPoints, []);
  for (const b of curve.slice(0, Math.min(5, curve.length))) {
    console.log(`  req#${b.requestIndex} ctx=${formatTokens(b.contextTokens)} in=${formatTokens(b.input)} cache=${formatTokens(b.cacheRead)} out=${formatTokens(b.output)}`);
  }
  if (curve.length > 5) {
    const last = curve[curve.length - 1]!;
    console.log(`  … last req#${last.requestIndex} ctx=${formatTokens(last.contextTokens)}`);
  }
  const p0 = s.contextPoints[0];
  if (p0) {
    const roles = new Map<string, number>();
    for (const m of p0.contextMessages) roles.set(m.role, (roles.get(m.role) ?? 0) + 1);
    console.log(`  req#0 before-context: ${[...roles.entries()].map(([r, c]) => `${r}×${c}`).join(" ")}`);
    const first = p0.contextMessages.find((m) => m.role === "user");
    console.log(`  first user: ${(first?.blocks[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
  }
  const t0 = s.turns[0];
  if (t0?.events.length) console.log(`  turn 1 events: ${t0.events.map((e) => e.detail).join(" | ")}`);
}
console.log("\nclaude smoke OK");
