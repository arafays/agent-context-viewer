/**
 * Smoke test for the Pi adapter — prints discovery + a full parse summary
 * for the most recent session and the known compaction session.
 * Usage: bun run scripts/smoke.ts
 */
import { discoverSessions, loadSession, getAgentDir, getSessionsDir } from "../src/adapters/pi/index.ts";
import { buildSessionContextInfo, buildContextPoints } from "../src/adapters/pi/context.ts";

const metas = discoverSessions();
console.log(`agentDir: ${getAgentDir()}`);
console.log(`sessionsDir: ${getSessionsDir()}`);
console.log(`discovered ${metas.length} Pi sessions\n`);

const byProject = new Map<string, number>();
for (const m of metas) byProject.set(m.project, (byProject.get(m.project) ?? 0) + 1);
console.log("per project:", Object.fromEntries(byProject));

const top = metas.slice(0, 5);
for (const m of top) {
  console.log(
    `- ${m.startedAt} | ${m.project} | ${m.model ?? "?"} | msgs=${m.messageCount} (u=${m.userMessages} a=${m.assistantMessages} t=${m.toolResults}) | ` +
      `tokens in=${m.tokens.input} cache=${m.tokens.cacheRead} | compaction=${m.compactionCount} | ${m.path.split("/").pop()}`,
  );
}

// full parse of the most recent session
if (metas.length > 0) {
  const s = loadSession(metas[0]!.path);
  console.log(`\n=== full parse of ${metas[0]!.path.split("/").pop()} ===`);
  console.log(`turns=${s.turns.length} assistantCalls=${s.assistantCalls.length} events=${s.events.length} name=${s.name ?? "—"}`);
  const info = buildSessionContextInfo(s.entries, s.meta.cwd);
  console.log(`system prompt: ${info.systemPrompt.length} chars, context files: ${info.contextFiles.map((f) => f.path).join(" | ")}`);
  console.log(`tools: ${info.tools.join(", ")}`);
  console.log(`skills: ${info.skills.map((sk) => sk.name).join(", ") || "none"}`);
  const points = buildContextPoints(s.entries, s.assistantCalls);
  console.log(`context points: ${points.length}`);
  for (const p of points.slice(0, 6)) {
    console.log(
      `  req#${p.requestIndex} turn#${p.turnIndex} ctx=${p.contextTokens.toLocaleString()} tokens ` +
        `(in=${p.usage.input.toLocaleString()} cache=${p.usage.cacheRead.toLocaleString()}) msgs=${p.contextMessages.length} model=${p.model ?? "?"}`,
    );
  }
  if (points.length > 0) {
    const last = points[points.length - 1]!;
    console.log(`  … last req#${last.requestIndex} ctx=${last.contextTokens.toLocaleString()} msgs=${last.contextMessages.length}`);
  }
}

// find and parse a compaction session
const comp = metas.find((m) => m.compactionCount > 0);
if (comp) {
  console.log(`\n=== compaction session: ${comp.path.split("/").pop()} ===`);
  const s = loadSession(comp.path);
  for (const turn of s.turns) {
    for (const ev of turn.events) {
      if (ev.kind === "compaction") {
        console.log(`  compaction: ${JSON.stringify((ev as { tokensBefore?: number }).tokensBefore)} tokens before, summary: ${String(ev.summary ?? "").slice(0, 140)}…`);
      }
    }
  }
}
