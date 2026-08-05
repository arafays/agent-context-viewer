/**
 * Compile the TUI into standalone Bun executables for release.
 *
 * Targets are selected via env (used by .github/workflows/release.yml):
 *   BUN_TARGET  bun build --compile target, e.g. bun-linux-x64 / bun-linux-arm64
 *   ASSET       output filename, e.g. acv-linux-x64
 *   ACV_VERSION semver without the leading "v" (embedded via define)
 *
 * Per OpenTUI docs, `process.env.OPENTUI_LIBC` must be defined at build time
 * so only the glibc native package is embedded (Arch is glibc).
 */
import { mkdirSync } from "node:fs"

const version = (process.env.ACV_VERSION ?? "").replace(/^v/, "") || "0.0.0"
const target = process.env.BUN_TARGET ?? "bun-linux-x64"
const asset = process.env.ASSET ?? "acv-linux-x64"

mkdirSync("dist", { recursive: true })

const result = await Bun.build({
  entrypoints: ["src/main.tsx"],
  compile: {
    target: target as Bun.Build.CompileTarget,
    outfile: `dist/${asset}`,
  },
  define: {
    "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
    "process.env.ACV_VERSION": JSON.stringify(version),
    // fff (search) detects libc at build time for its native binary; Arch and
    // the release targets are glibc, so pin "gnu" so the right .so is embedded.
    "FFF_LIBC": JSON.stringify("gnu"),
  },
  minify: true,
})

if (!result.success) {
  console.error(result.logs)
  process.exit(1)
}

console.log(`built dist/${asset} (${target}) acv v${version}`)
