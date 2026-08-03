/**
 * Drive the App UI across every available adapter (Pi → Codex → Claude):
 * switch tool with g, open a project, open a session, open context view,
 * system prompt, files. Captures stage snapshots to /tmp/acv-all-*.txt.
 *   bun run scripts/all-tools-ui-test.tsx
 */
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";
import { App } from "../src/app.tsx";

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode() {}
  override resume(): this {
    return this;
  }
  override pause(): this {
    return this;
  }
  ref() {}
  unref() {}
}
const stdout = new PassThrough();
Object.assign(stdout, { isTTY: true, columns: 110, rows: 40 });
const stdin = new FakeStdin();
let output = "";
stdout.on("data", (c: Buffer) => (output += c.toString()));
const { unmount } = render(<App />, {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: stdin as unknown as NodeJS.ReadStream,
  exitOnCtrlC: false,
});

const clean = () => output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const stage = (label: string) => {
  const lines = clean().split("\n").filter((l) => l.trim().length > 0);
  writeFileSync(`/tmp/acv-all-${label}.txt`, lines.slice(-42).join("\n"));
  console.error(`[${label}] chars=${output.length}`);
};

let t = 2500;
const steps: Array<[number, () => void]> = [
  [t, () => stage("home")],
  [t + 100, () => stdin.write("G")], // → codex (forward)
  [t + 1200, () => stage("codex-tool")],
  [t + 1300, () => stdin.write("\r")], // open codex project
  [t + 2500, () => stage("codex-list")],
  [t + 2600, () => stdin.write("\r")], // open codex session
  [t + 3900, () => stage("codex-detail")],
  [t + 4000, () => stdin.write("q")], // back to list
  [t + 4100, () => stdin.write("q")], // back to home
  [t + 5200, () => stdin.write("G")], // → claude
  [t + 5300, () => stage("claude-tool")],
  [t + 5400, () => stdin.write("\r")], // open claude project
  [t + 6600, () => stage("claude-list")],
  [t + 6700, () => stdin.write("\r")], // open claude session
  [t + 8000, () => stage("claude-detail")],
  [t + 8100, () => stdin.write("c")], // context view
  [t + 9400, () => stage("claude-context")],
  [t + 9500, () => stdin.write("q")], // back
  [t + 9600, () => stdin.write("f")], // files
  [t + 10900, () => stage("claude-files")],
];
for (const [when, fn] of steps) setTimeout(fn, when);

setTimeout(() => {
  console.error(`DONE total=${output.length}`);
  unmount();
  process.exit(0);
}, t + 11900);
