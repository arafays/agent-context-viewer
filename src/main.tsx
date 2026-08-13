import { createCliRenderer } from "@opentui/core";
import { createApp } from "./app.ts";
import pkg from "../package.json";

/**
 * Version is baked in at compile time via `process.env.ACV_VERSION` (see
 * scripts/build-release.ts). In dev it falls back to package.json.
 */
const version = process.env.ACV_VERSION ?? pkg.version;

if (Bun.argv.includes("--version") || Bun.argv.includes("-v")) {
  console.log(`acv ${version}`);
  process.exit(0);
}

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
  console.log(
    [
      `acv ${version} — ${pkg.description}`,
      "",
      "Usage: acv [options]",
      "",
      "Options:",
      "  -v, --version  print version and exit",
      "  -h, --help     show this help and exit",
      "",
      "Browse AI-agent session context (Pi, Codex, Claude, opencode) in a TUI.",
      "j/k scroll · / search · Enter open · c context · s system prompt · f files · q quit",
    ].join("\n"),
  );
  process.exit(0);
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createApp(renderer);
