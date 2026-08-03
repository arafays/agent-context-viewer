/**
 * Codex adapter smoke test — runs against real sessions in ~/.codex/sessions.
 *   bun run scripts/smoke-codex.ts
 */
import { discoverSessions, loadSession } from "../src/adapters/codex/index.ts";
import { buildRequestSteps, sessionCurve } from "../src/engine/context-diff.ts";
import { formatTokens } from "../src/engine/tokens.ts";

const metas = discoverSessions();
console.log(`codex sessions: ${metas.length}`);
for (const m of metas) {
  console.log(
    `  ${m.startedAt}  ${m.project}  cwd=${m.cwd}  msgs=${m.messageCount} (u=${m.userMessages} a=${m.assistantMessages} t=${m.toolResults})  ${m.sizeBytes}B`,
  );
}

for (const meta of metas) {
  const s = loadSession(meta.path);
  console.log(`\n=== ${meta.project} (${meta.id.slice(0, 8)}) ===`);
  console.log(`  turns=${s.turns.length} assistantCalls=${s.assistantCalls.length} contextPoints=${s.contextPoints.length}`);
  console.log(`  model=${s.meta.model ?? "?"} tokens=${JSON.stringify(s.meta.tokens)}`);
  console.log(`  systemPrompt=${s.contextInfo.systemPrompt.length} chars (exact, inline)`);
  console.log(`  contextFiles=${s.contextInfo.contextFiles.map((f) => f.path).join(", ") || "none"}`);
  console.log(`  skills=${s.contextInfo.skills.map((sk) => sk.name).join(", ") || "none"}`);
  console.log(`  tools=${s.contextInfo.tools.join(", ") || "none"}`);
  console.log(`  notes: ${s.contextInfo.notes.join(" | ")}`);

  const steps = buildRequestSteps(s.contextPoints, []);
  const curve = sessionCurve(s.contextPoints, []);
  for (const b of curve.slice(0, Math.min(6, curve.length))) {
    console.log(
      `  req#${b.requestIndex} ctx=${formatTokens(b.contextTokens)} in=${formatTokens(b.input)} cache=${formatTokens(b.cacheRead)}`,
    );
  }
  if (curve.length > 1) {
    const last = curve[curve.length - 1]!;
    console.log(`  … last req#${last.requestIndex} ctx=${formatTokens(last.contextTokens)}`);
  }
  // first request before-context composition
  const p0 = s.contextPoints[0];
  if (p0) {
    const roles = new Map<string, number>();
    for (const m of p0.contextMessages) roles.set(m.role, (roles.get(m.role) ?? 0) + 1);
    console.log(
      `  req#0 before-context: ${[...roles.entries()].map(([r, c]) => `${r}×${c}`).join(" ")} · sys=${p0.systemPrompt?.length ?? 0} chars`,
    );
    const first = p0.contextMessages.find((m) => m.role === "user");
    console.log(`  first user: ${(first?.blocks[0]?.text ?? "").slice(0, 90)}`);
  }
  // a turn with AGENTS.md event
  for (const t of s.turns) {
    if (t.events.length > 0) {
      console.log(`  turn ${t.index + 1} events: ${t.events.map((e) => e.detail).join(" | ")}`);
      break;
    }
  }
}
console.log("\ncodex smoke OK");
