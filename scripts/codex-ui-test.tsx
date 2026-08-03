/**
 * Drive the App UI through the Codex adapter: Tab → Codex → project → session
 * → context view → system prompt → files. Captures stage snapshots to /tmp/acv-cx-*.txt.
 *   bun run scripts/codex-ui-test.tsx
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
(Object.assign(stdout, { isTTY: true, columns: 110, rows: 40 }));
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
  writeFileSync(`/tmp/acv-cx-${label}.txt`, lines.slice(-42).join("\n"));
  console.error(`[${label}] frames chars=${output.length}`);
};

setTimeout(() => stage("home"), 2600);
setTimeout(() => stdin.write("G"), 2700); // G → next tool (codex)
setTimeout(() => stage("codex-tool"), 3800);
setTimeout(() => stdin.write("\r"), 3900); // open codex project
setTimeout(() => stage("codex-list"), 5000);
setTimeout(() => stdin.write("\r"), 5100); // open first codex session
setTimeout(() => stage("codex-detail"), 6400);
setTimeout(() => stdin.write("c"), 6500); // context view
setTimeout(() => stage("codex-context"), 7800);
setTimeout(() => stdin.write("s"), 7900); // system prompt
setTimeout(() => stage("codex-sysprompt"), 9200);
setTimeout(() => stdin.write("q"), 9300); // back
setTimeout(() => stdin.write("f"), 9400); // files
setTimeout(() => stage("codex-files"), 10800);
setTimeout(() => {
  console.error(`DONE total=${output.length}`);
  unmount();
  process.exit(0);
}, 11800);
