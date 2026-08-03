/**
 * Headless render test — snapshots each screen via ink's renderToString.
 * Usage: bun run scripts/render-test.ts
 */
import React from "react";
import { renderToString } from "ink";
import { discoverSessions, loadSession } from "../src/adapters/pi/index.ts";
import { buildContextPoints, buildSessionContextInfo } from "../src/adapters/pi/context.ts";
import { buildRequestSteps, sessionCurve } from "../src/engine/context-diff.ts";
import { Home, groupByProject } from "../src/ui/home.tsx";
import { SessionList } from "../src/ui/session-list.tsx";
import { SessionDetail } from "../src/ui/session-detail.tsx";
import { ContextView } from "../src/ui/context-view.tsx";
import { SystemPromptView } from "../src/ui/system-prompt-view.tsx";
import { ContextFilesView } from "../src/ui/context-files-view.tsx";
import type { AgentTool } from "../src/adapters/types.ts";

const sessions = discoverSessions();
console.error(`discovered ${sessions.length} sessions`);
const byTool = { pi: sessions } as Record<AgentTool, typeof sessions>;

// home
const home = renderToString(<Home sessionsByTool={byTool} onOpenProject={() => {}} onOpenAll={() => {}} onQuit={() => {}} />);
console.log("========== HOME ==========");
console.log(home);

// list
const project = groupByProject(sessions)[0]!.project;
console.log(`\n========== SESSION LIST (${project}) ==========`);
const list = renderToString(
  <SessionList tool="pi" project={project} sessions={sessions.filter((s) => s.project === project)} onOpen={() => {}} onBack={() => {}} />,
);
console.log(list);

// detail (first session)
const s = loadSession(sessions[0]!.path);
console.log(`\n========== SESSION DETAIL (${s.meta.id.slice(0, 8)}) ==========`);
const detail = renderToString(<SessionDetail session={s.meta} onOpenContext={() => {}} onOpenSystemPrompt={() => {}} onOpenFiles={() => {}} onBack={() => {}} />);
console.log(detail);

// context view (compaction session if available)
const comp = sessions.find((m) => m.compactionCount > 0);
const target = comp ? loadSession(comp.path) : s;
console.log(`\n========== CONTEXT VIEW (${target.meta.id.slice(0, 8)}, ${target.assistantCalls.length} requests) ==========`);
const ctx = renderToString(<ContextView session={target} onOpenSystemPrompt={() => {}} onBack={() => {}} />);
console.log(ctx);

// system prompt
console.log(`\n========== SYSTEM PROMPT (first 60 lines) ==========`);
const sys = renderToString(<SystemPromptView session={s} onBack={() => {}} />);
console.log(sys.split("\n").slice(0, 60).join("\n"));

// context files
console.log(`\n========== CONTEXT FILES ==========`);
const files = renderToString(<ContextFilesView session={s} onBack={() => {}} />);
console.log(files.split("\n").slice(0, 40).join("\n"));

// engine sanity: diff around compaction
const compactions = target.turns.flatMap((t) =>
  t.events.filter((e) => e.kind === "compaction").map((e) => ({ entryIndex: t.entryEnd, tokensBefore: (e as { tokensBefore?: number }).tokensBefore ?? 0, summary: String(e.summary ?? ""), readFiles: [] as string[], modifiedFiles: [] as string[] })),
);
const points = target.contextPoints;
const steps = buildRequestSteps(points, compactions);
const curve = sessionCurve(points, compactions);
const cIdx = curve.findIndex((b) => b.compacted);
if (cIdx >= 0) {
  const st = steps[cIdx]!;
  console.error(`\n[engine] req#${st.point.requestIndex}: +${st.added.length} added, -${st.pruned.length} pruned, delta=${st.tokenDelta}, compaction=${st.compaction?.tokensBefore}`);
}
const info = s.contextInfo;
console.error(`[engine] system prompt: ${info.systemPrompt.length} chars; files: ${info.contextFiles.length}; skills: ${info.skills.length}`);
console.error("render-test OK");
