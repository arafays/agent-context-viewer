/**
 * Full render-loop test: drives <App/> with fake stdin/stdout streams so
 * useEffect data-loading runs. Captures output frames after effects settle.
 * Usage: bun run scripts/render-loop-test.tsx
 */
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
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
(stdout as unknown as { isTTY: boolean }).isTTY = true;
const stdin = new FakeStdin();
let output = "";
stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString();
});

const { waitUntilExit, unmount } = render(<App />, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false });

const frames: string[] = [];
let lastLen = 0;
setInterval(() => {
  if (output.length !== lastLen) {
    frames.push(output);
    lastLen = output.length;
  }
}, 100);

const stage = (label: string) => {
  const final = frames[frames.length - 1] ?? output;
  const clean = final.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\]?\][0-9;]*[a-zA-Z]/g, "");
  require("node:fs").writeFileSync(`/tmp/acv-${label}.txt`, clean);
  console.error(`--- ${label}: frames=${frames.length} chars=${final.length}`);
};

setTimeout(() => stage("home"), 1500);
// Enter: open first project → SessionList
setTimeout(() => stdin.write("\r"), 1600);
setTimeout(() => stage("list"), 2800);
// Enter: open first session → SessionDetail
setTimeout(() => stdin.write("\r"), 2900);
setTimeout(() => stage("detail"), 4500);
// c: open ContextView (async context build)
setTimeout(() => stdin.write("c"), 4600);
setTimeout(() => stage("context"), 7000);
// s: system prompt
setTimeout(() => stdin.write("s"), 7100);
setTimeout(() => stage("sysprompt"), 8500);
// q back → detail, f → files
setTimeout(() => stdin.write("q"), 8600);
setTimeout(() => stdin.write("f"), 8700);
setTimeout(() => stage("files"), 10000);
// ? → help panel
setTimeout(() => stdin.write("?"), 10100);
setTimeout(() => stage("help"), 11200);

setTimeout(() => {
  console.error(`--- final frames: ${frames.length}, total chars: ${output.length}`);
  unmount();
  process.exit(0);
}, 12000);

setTimeout(() => {
  console.error("TIMEOUT");
  unmount();
  process.exit(1);
}, 15000);
