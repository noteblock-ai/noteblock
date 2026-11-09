// End-to-end check of Inspect page (app/main/page-devtools.mjs) in the real app, in hidden
// capture windows (no visible window, no host cursor or keys). Seeds a throwaway vault, launches
// Electron once with scripts/verify-devtools-main.mjs, and prints one result per check, with
// screenshots of the inspector windows (devtools-*.png) in the output folder.
// Run: pnpm build && node scripts/verify-devtools.mjs [screenshot dir]
// Not part of `pnpm check` (it launches the app).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "quire-devtools-shots-")));
fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), "quire-devtools-home-"));
const configDir = path.join(home, ".noteblock");
process.env.HOME = home;
process.env.QUIRE_CONFIG_DIR = configDir;
const { createVault } = await import("../core/index.mjs");
const vault = createVault(path.join(home, "Quire", "Verify"), { name: "Verify", seed: true });

const r = spawnSync(path.join(ROOT, "node_modules", ".bin", "electron"), ["."], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 240000,
  env: {
    ...process.env,
    HOME: home,
    QUIRE_CONFIG_DIR: configDir,
    QUIRE_VAULT: vault,
    QUIRE_CAPTURE: path.join(out, "devtools-run.png"),
    QUIRE_CAPTURE_DELAY: "1500",
    QUIRE_OPEN_PAGE: "Habits",
    QUIRE_TEST_SCRIPT: path.join(ROOT, "scripts", "verify-devtools-main.mjs"),
    QUIRE_VERIFY_OUT: out,
  },
});
const text = (r.stdout || "") + (r.stderr || "");
const results = text
  .split("\n")
  .filter((l) => l.startsWith("[verify] "))
  .map((l) => JSON.parse(l.slice(9)));
if (process.env.VERBOSE) for (const x of results) console.log(x.name, x.detail);
let failed = 0;
for (const x of results) {
  if (!x.ok) failed++;
  console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  " + x.detail}`);
}
for (const l of text.split("\n").filter((l) => /\[quire-test\] failed|\[quire\] inspect/.test(l))) console.log("  log: " + l.slice(0, 400));
if (r.status !== 0 || !results.length) {
  console.log(`exit code ${r.status}`);
  console.log(text.split("\n").filter((l) => !l.startsWith("[verify] ")).slice(-25).join("\n"));
  failed++;
}
console.log(`\n${failed ? failed + " failed" : "all passed"} · screenshots in ${out}`);
process.exit(failed ? 1 : 0);
