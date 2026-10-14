import assert from "node:assert/strict"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import pkg from "../package.json"

const asset = process.env.ASSET ?? "acv-linux-x64"
assert.match(asset, /^acv-linux-(x64|aarch64)$/)
const binary = resolve("dist", asset)
assert.ok(statSync(binary).size > 1_000_000, "Expected standalone executable")
const expectedVersion = (process.env.ACV_VERSION ?? pkg.version).replace(/^v/, "")
// Run away from the repository so source files and node_modules cannot mask missing assets.
const cwd = mkdtempSync(join(tmpdir(), "acv-release-"))
try {
  for (const option of ["--version", "-v", "--help", "-h"]) {
    const result = Bun.spawnSync([binary, option], { cwd, env: { ...process.env, ACV_VERSION: "should-not-override-build" }, timeout: 15_000 })
    assert.equal(result.exitCode, 0, result.stderr.toString())
    const output = result.stdout.toString()
    assert.ok(output.includes(`acv ${expectedVersion}`), output)
    if (option === "--help" || option === "-h") {
      assert.ok(output.includes("Usage: acv"))
      assert.ok(output.includes("Cursor, VS Code"))
      assert.ok(output.includes("y copy"))
    }
  }
  const invalid = Bun.spawnSync([binary, "--invalid-option"], { cwd, timeout: 15_000 })
  assert.equal(invalid.exitCode, 2)
  assert.ok(invalid.stderr.toString().includes("Unknown option"))
  const nonInteractive = Bun.spawnSync([binary], { cwd, timeout: 15_000 })
  assert.equal(nonInteractive.exitCode, 2)
  assert.ok(nonInteractive.stderr.toString().includes("interactive terminal"))
  console.log(`Standalone ${asset} ${expectedVersion}: version, help, and argument checks passed`)
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
