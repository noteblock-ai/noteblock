// Smoke test for the tools Quire ships (app/main/tools.mjs) and the missing-tool status of page
// backends: the pnpm shim runs the bundled pnpm, core/git commits with the bundled git (when
// scripts/fetch-tools.mjs has fetched it), "Use the one on this Mac" drops a shim, a backend
// whose program isn't installed reports `missingTool` and isn't restarted, and .noteblock
// "requires" is parsed and passed through.
// Run: node scripts/smoke-tools.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-tools-"));
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");
const core = await import("../core/index.mjs");
const tools = await import("../app/main/tools.mjs");
const { ensureBackend, onBackendStatus, stopAllBackends, missingToolFrom, commandName } = await import("../app/main/backend.mjs");

try {
  // Output → missing program.
  assert.equal(missingToolFrom(127, "/bin/sh: python9: command not found\n", "python9 server.py"), "python9");
  assert.equal(missingToolFrom(127, "/bin/sh: line 0: exec: deno: not found\n", "PORT=1 exec deno run x.ts"), "deno");
  assert.equal(missingToolFrom(127, "env: python3: No such file or directory\n", "./server.py"), "python3");
  assert.equal(missingToolFrom(1, "xcode-select: note: No developer tools were found, requesting install.\n", "python3 app.py"), "python3");
  assert.equal(missingToolFrom(1, "Error: listen EADDRINUSE", "node server.js"), null);
  assert.equal(commandName("FOO=1 BAR=2 exec /usr/local/bin/uv run app.py"), "uv");
  assert.equal(tools.toolHelpUrl("python3"), "https://www.python.org/downloads/macos/");
  assert.match(tools.toolHelpUrl("zig"), /duckduckgo\.com\/\?q=install%20zig/);
  assert.deepEqual(core.parseRequires({ python: "3.12", uv: true, "bad key!": "x", node: 22 }), { python: "3.12", uv: "*", node: "22" });
  assert.equal(core.parseRequires(["python"]), null);

  // Shims: pnpm runs the bundled one; switching pnpm to the Mac's removes the shim.
  tools.initTools({ dir: path.join(tmp, "tools") });
  const bin = tools.shimDir();
  const pnpmVersion = JSON.parse(fs.readFileSync(new URL("../node_modules/pnpm/package.json", import.meta.url), "utf8")).version;
  assert.equal(execFileSync(path.join(bin, "pnpm"), ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim(), pnpmVersion);
  assert.ok(fs.existsSync(path.join(bin, "npx")) && fs.existsSync(path.join(bin, "pnpx")));
  assert.equal(tools.pagePath("/usr/bin:/bin"), `${bin}:/usr/bin:/bin`);
  await tools.setToolMode("pnpm", "system");
  assert.ok(!fs.existsSync(path.join(bin, "pnpm")));
  await tools.setToolMode("pnpm", "builtin");
  assert.ok(fs.existsSync(path.join(bin, "pnpm")));
  const [cmd, args] = tools.wranglerCommand(["whoami"]);
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args.slice(1, 3), ["dlx", `wrangler@${tools.WRANGLER_VERSION}`]);

  // git: the bundled one when this checkout has it, with no git on PATH at all.
  const own = tools.builtinGitDir();
  const vault = core.createVault(path.join(tmp, "V"), { name: "V", seed: false });
  if (own) {
    assert.equal(core.gitCommand().bin, path.join(own, "bin", "git"));
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      core.createPage(vault, "Note");
      assert.ok(core.commitAll(vault, "Add note"));
      assert.equal(core.gitLog(vault, 1)[0].message, "Add note");
    } finally {
      process.env.PATH = savedPath;
    }
    const rows = await tools.toolsInfo();
    assert.equal(rows.find((r) => r.id === "git").source, "builtin");
    assert.match(rows.find((r) => r.id === "git").version, /^\d+\.\d+/);
  } else console.log("smoke-tools: no bundled git here (run node scripts/fetch-tools.mjs); skipped the git part");
  assert.match(fs.readFileSync(path.join(vault, ".gitignore"), "utf8"), /^\.venv\/$/m);

  // A backend whose program isn't installed: missingTool, requires passed through, no restart loop.
  const page = core.createPage(vault, "Py");
  core.writeManifest(page.dir, { ...core.readManifest(page.dir), requires: { python: "3.12" }, backend: { run: { api: "python9 server.py" } } });
  let last = null;
  onBackendStatus((s) => s.path === "Py" && (last = s));
  const snap = await ensureBackend(vault, "Py");
  assert.deepEqual(snap.requires, { python: "3.12" });
  for (let i = 0; i < 50 && !last?.procs[0]?.missingTool; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(last.procs[0].missingTool, "python9");
  assert.equal(last.procs[0].state, "crashed");
  assert.equal(last.procs[0].missingHelp, "https://www.python.org/downloads/macos/");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(last.procs[0].restarts, 0, "a missing program isn't restarted");
  console.log("smoke-tools ok");
} finally {
  await stopAllBackends();
  fs.rmSync(tmp, { recursive: true, force: true });
}
