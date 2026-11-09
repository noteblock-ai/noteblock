// End-to-end check of per-page origins in the real app, in hidden capture windows (no visible
// window, no host cursor). Makes a throwaway HOME with a seeded vault plus a few test pages
// (a spinner embed, a holder page, a freezer for the floating note) and the "Bad stuff" folder,
// then launches Electron twice with one profile:
//   1. seed: writes keys into the OLD shared quire://vault localStorage, as an older Quire left it
//   2. test: scripts/verify-origins-main.mjs — processes, isolation, recovery cards, features,
//      migration — printing one result per check, with screenshots to QUIRE_VERIFY_OUT.
// Run: pnpm build && node scripts/verify-origins.mjs [screenshot dir]
// Not part of `pnpm check` (it launches the app and takes about a minute).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "quire-verify-shots-")));
fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), "quire-verify-home-"));
const configDir = path.join(home, ".noteblock");
const userData = path.join(home, "userData");
fs.mkdirSync(userData, { recursive: true });
process.env.HOME = home;
process.env.QUIRE_CONFIG_DIR = configDir;
const { createVault, createPage } = await import("../core/index.mjs");

const vault = createVault(path.join(home, "Quire", "Verify"), { name: "Verify", seed: true });
const para = (n) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i + 1} of the holder page, here to give it something to scroll.</p>`).join("\n");
createPage(vault, "Spinner", {
  content: `<!doctype html><html><head><title>Spinner</title></head><body><h1>Spinner</h1><p>Spins forever a moment after it first loads (not after a Reload).</p>
<script>if (!/reload=/.test(location.search)) setTimeout(function () { while (true) {} }, 2500);</script></body></html>`,
});
createPage(vault, "Holder", {
  content: `<!doctype html><html><head><title>Holder</title></head><body><h1>Holder</h1><p>This page embeds a page that freezes.</p>
<quire-embed src="Spinner"></quire-embed>
${para(40)}
</body></html>`,
});
createPage(vault, "Freezer", {
  content: `<!doctype html><html><head><title>Freezer</title></head><body><h1>Freezer</h1><p>Freezes once, a moment after its first load.</p>
<script>if (!localStorage.getItem("spun")) { localStorage.setItem("spun", "1"); setTimeout(function () { while (true) {} }, 2500); }</script></body></html>`,
});
spawnSync(process.execPath, [path.join(ROOT, "scripts", "make-bad-stuff.mjs"), path.join(vault, "Bad stuff")], { stdio: "ignore" });

const electron = path.join(ROOT, "node_modules", ".bin", "electron");
function run(mode) {
  const r = spawnSync(electron, ["."], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 240000,
    env: {
      ...process.env,
      HOME: home,
      QUIRE_CONFIG_DIR: configDir,
      QUIRE_VAULT: vault,
      QUIRE_USER_DATA: userData,
      QUIRE_CAPTURE: path.join(out, `run-${mode}.png`),
      QUIRE_CAPTURE_DELAY: "1500",
      QUIRE_OPEN_PAGE: "Welcome",
      QUIRE_TEST_SCRIPT: path.join(ROOT, "scripts", "verify-origins-main.mjs"),
      QUIRE_VERIFY_MODE: mode,
      QUIRE_VERIFY_OUT: out,
    },
  });
  const text = (r.stdout || "") + (r.stderr || "");
  const results = text
    .split("\n")
    .filter((l) => l.startsWith("[verify] "))
    .map((l) => JSON.parse(l.slice(9)));
  const problems = text.split("\n").filter((l) => /\[quire-test\] failed|Error:|refused cross-page/.test(l));
  return { status: r.status, results, problems };
}

// A profile that never ran a per-origin Quire has no page-origins.json.
const seed = run("seed");
fs.rmSync(path.join(userData, "page-origins.json"), { force: true });
const test = run("test");
let failed = 0;
for (const r of [...seed.results, ...test.results]) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  " + r.detail}`);
}
for (const p of [...seed.problems, ...test.problems]) console.log("  log: " + p.slice(0, 300));
if (seed.status !== 0 || test.status !== 0) {
  console.log(`exit codes: seed ${seed.status}, test ${test.status}`);
  failed++;
}
console.log(`\n${failed ? failed + " failed" : "all passed"} · screenshots in ${out} · vault ${vault}`);
process.exit(failed ? 1 : 0);
