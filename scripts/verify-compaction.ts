import { discoverSessions, loadSession } from "../src/adapters/pi/index.ts";
import { buildContextPoints } from "../src/adapters/pi/context.ts";
import { buildRequestSteps, sessionCurve } from "../src/engine/context-diff.ts";

const sessions = discoverSessions();
const comp = sessions.find((m) => m.compactionCount > 0)!;
console.log(`compaction session: ${comp.path.split("/").pop()}`);
const s = loadSession(comp.path);
const compactions = s.turns.flatMap((t) =>
  t.events.filter((e) => e.kind === "compaction").map((e) => ({
    entryIndex: t.entryEnd,
    tokensBefore: (e as { tokensBefore?: number }).tokensBefore ?? 0,
    summary: String(e.summary ?? ""),
    readFiles: [] as string[],
    modifiedFiles: [] as string[],
  })),
);
const points = s.contextPoints;
const steps = buildRequestSteps(points, compactions);
const curve = sessionCurve(points, compactions);
const cIdx = curve.findIndex((b) => b.compacted);
console.log(`curve: ${curve.length} bars, compacted at index ${cIdx}`);
for (const [i, b] of curve.entries()) {
  if (b.compacted) console.log(`  bar#${i}: req#${b.requestIndex} ctx=${b.contextTokens} COMPACTED`);
}
const st = steps[cIdx]!;
const c = st.compaction as { tokensBefore: number; summary: string };
console.log(`\nrequest #${st.point.requestIndex}:`);
console.log(`  before ctx tokens: ${c.tokensBefore.toLocaleString()} → after: ${st.point.contextTokens.toLocaleString()} (delta ${st.tokenDelta >= 0 ? "+" : ""}${st.tokenDelta.toLocaleString()})`);
console.log(`  +${st.added.length} added, −${st.pruned.length} pruned`);
console.log(`  messages before: ${st.pruned.length + st.added.length}... after: ${st.point.contextMessages.length}`);
console.log(`  summary: ${c.summary.slice(0, 100)}`);
console.log(`\nadded sample roles:`, st.added.slice(0, 5).map((m) => m.role));
console.log(`pruned sample roles:`, st.pruned.slice(0, 5).map((m) => m.role));
console.log("\nverify-compaction OK");
