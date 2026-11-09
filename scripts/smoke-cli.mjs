// Smoke test for the `noteblock` CLI against a temp vault. Run: node scripts/smoke-cli.mjs
// HOME points at a temp dir so the real ~/.noteblock/config.json is never touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentUser } from "../core/vault.mjs";
import { BRAND } from "../core/brand.mjs";

process.removeAllListeners("warning"); // node:sqlite is experimental
const { DatabaseSync } = await import("node:sqlite");

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "quire.mjs");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quire-cli-smoke-")));
const home = path.join(tmp, "home");
fs.mkdirSync(home);
const vault = path.join(tmp, "Vault");
const elsewhere = path.join(tmp, "elsewhere");
fs.mkdirSync(elsewhere);

function run(args, { ok = true } = {}) {
  const r = spawnSync(cli, args, {
    cwd: elsewhere,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USER: process.env.USER },
  });
  if (ok && r.status !== 0) throw new Error(`noteblock ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  if (!ok) assert.equal(r.status, 1, `expected exit 1 for noteblock ${args.join(" ")}`);
  return { out: r.stdout, err: r.stderr, lines: r.stdout.trimEnd().split("\n") };
}

try {
  // help
  assert.match(run(["--help"]).out, /noteblock edit <page>/);
  assert.match(run(["help"]).out, /noteblock vault create/);

  // both names are declared, and a link under either name runs the CLI (how setup-cli installs it)
  const { bin } = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), "..", "package.json"), "utf8"));
  assert.equal(bin.noteblock, "cli/quire.mjs");
  assert.equal(bin.quire, "cli/quire.mjs");
  for (const name of ["noteblock", "quire"]) {
    const link = path.join(tmp, name);
    fs.symlinkSync(cli, link);
    const r = spawnSync(link, ["--help"], { encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(r.status, 0, `${name} --help: ${r.stderr}`);
    assert.match(r.stdout, /^noteblock — /);
  }

  // no vault yet → one-line error, exit 1
  const none = run(["ls"], { ok: false });
  assert.match(none.err, new RegExp(`^noteblock: No ${BRAND.name} vault found`));
  assert.equal(none.err.trim().split("\n").length, 1);

  // vault create (no seed) → current + in vaults, in the TEMP home
  assert.equal(run(["vault", "create", vault, "--no-seed"]).out.trim(), vault);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".noteblock", "config.json"), "utf8"));
  assert.equal(cfg.current, vault);
  assert.deepEqual(cfg.vaults, [vault]);
  assert.equal(run(["vault"]).out.trim(), vault);
  assert.equal(run(["vault", "use", vault]).out.trim(), vault);
  assert.equal(run(["vault", "use", elsewhere], { ok: false }).err.startsWith("noteblock: "), true);

  // new / ls / path / cat
  assert.equal(run(["mkdir", "Trips"]).out.trim(), path.join(vault, "Trips"));
  const tripDir = run(["new", "Trips/Kyoto trip"]).out.trim();
  assert.equal(tripDir, path.join(vault, "Trips", "Kyoto trip"));
  run(["new", "Trips/Notes", "--md"]);
  run(["new", "Nope/Child"], { ok: false });
  assert.match(run(["new", "Trips/Kyoto trip/Child"], { ok: false }).err, /is a page/);
  const ls = run(["ls"]).lines;
  assert.deepEqual(ls, ["Trips/", "  Kyoto trip  html", "  Notes  md"]);
  const tree = JSON.parse(run(["ls", "--json"]).out);
  assert.equal(tree[0].kind, "folder");
  assert.equal(tree[0].children[1].path, "Trips/Notes");
  assert.equal(run(["path", "Trips/Notes"]).out.trim(), path.join(vault, "Trips", "Notes"));
  assert.equal(run(["cat", "Trips/Notes"]).out, "# Notes\n");
  assert.match(run(["cat", "Trips/Kyoto trip"]).out, /<title>Kyoto trip<\/title>/);
  assert.match(run(["cat", "Missing"], { ok: false }).err, /^noteblock: No page: Missing\n$/);
  // --vault works from anywhere
  assert.equal(run(["--vault", vault, "path", "Trips/Kyoto trip"]).out.trim(), tripDir);

  // commit the new pages so the edit below is the only change
  const pre = spawnSync("git", ["-C", vault, "add", "-A"]);
  assert.equal(pre.status, 0);
  spawnSync("git", ["-C", vault, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "Add pages"]);

  // edit → status → done
  const edit = run(["edit", "Trips/Kyoto trip", "-m", "Add a budget table", "--by", "Smoke"]).lines;
  assert.equal(edit[0], tripDir);
  assert.equal(edit.length, 4);
  assert.ok(edit.some((l) => l.includes('noteblock done "Trips/Kyoto trip"')));
  assert.match(run(["edit", "Trips/Kyoto trip", "-m", "again"], { ok: false }).err, /Already being edited/);
  assert.match(run(["ls"]).lines[1], /🔒 editing \(Smoke\): Add a budget table$/);
  fs.writeFileSync(path.join(tripDir, "index.html"), "<!doctype html><body><p>Budget</p></body>");
  const status = run(["status"]).out;
  assert.match(status, /Trips\/Kyoto trip  🔒 editing \(Smoke\): Add a budget table/);
  assert.match(status, / M "Trips\/Kyoto trip\/index\.html"/);
  const sha = run(["done", "Trips/Kyoto trip"]).out.trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  const log = run(["log", "-n", "1"]).out;
  assert.match(log, /Add a budget table/);
  assert.match(log, /Smoke/);
  assert.equal(JSON.parse(run(["log", "--json"]).out).length, 3);
  assert.equal(JSON.parse(run(["log", "--json", "-n", "2"]).out).length, 2);
  assert.match(run(["done", "Trips/Kyoto trip"], { ok: false }).err, /^noteblock: Not being edited/);

  // edit with no changes → nothing to commit
  run(["edit", "Trips/Notes", "-m", "noop"]);
  assert.equal(run(["done", "Trips/Notes", "-m", "noop done"]).out.trim(), "nothing to commit");

  // edit → abort restores the snapshot
  run(["edit", "Trips/Kyoto trip", "-m", "scratch"]);
  fs.writeFileSync(path.join(tripDir, "index.html"), "garbage");
  fs.writeFileSync(path.join(tripDir, "extra.js"), "// new");
  run(["abort", "Trips/Kyoto trip"]);
  assert.equal(fs.readFileSync(path.join(tripDir, "index.html"), "utf8"), "<!doctype html><body><p>Budget</p></body>");
  assert.equal(fs.existsSync(path.join(tripDir, "extra.js")), false);
  assert.match(run(["status"]).out, /No pages being edited/);
  assert.match(run(["status"]).out, /Nothing uncommitted/);

  // data: none yet, then rows written straight to the store file
  assert.deepEqual(JSON.parse(run(["data", "Trips/Kyoto trip"]).out), {});
  const user = currentUser();
  fs.mkdirSync(path.join(tripDir, "data"), { recursive: true });
  const db = new DatabaseSync(path.join(tripDir, "data", `${user}.sqlite`));
  db.exec("CREATE TABLE rows (tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (tbl, id))");
  db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO rows VALUES (?, ?, ?, ?, ?)").run("expenses", "a1", JSON.stringify({ item: "Ramen", yen: 1200 }), 1, 1);
  db.close();
  const rows = JSON.parse(run(["data", "Trips/Kyoto trip", "expenses"]).out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item, "Ramen");
  assert.equal(rows[0].id, "a1");
  const all = JSON.parse(run(["data", "Trips/Kyoto trip"]).out);
  assert.deepEqual(Object.keys(all), ["expenses"]);

  // bad usage
  assert.match(run(["frobnicate"], { ok: false }).err, /^noteblock: unknown command/);
  assert.match(run(["edit"], { ok: false }).err, /^noteblock: missing <page>/);

  console.log("smoke-cli: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
