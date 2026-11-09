// Sync smoke: two clones of one bare repo edit the same page; the second to sync keeps the
// remote version in place and its own beside it as a conflict copy, and both end up equal.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-sync-"));
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");
const { syncOnce } = await import("../app/main/sync.mjs");

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const commit = (dir, msg) => {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg);
};

const bare = path.join(tmp, "remote.git");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
const a = path.join(tmp, "a");
const b = path.join(tmp, "b");
execFileSync("git", ["init", "-q", "-b", "main", a]);
git(a, "remote", "add", "origin", bare);
write(a, "Todos/.noteblock", '{"id":"x","entry":"index.html"}\n');
write(a, "Todos/index.html", "<h1>Todos</h1>\n<p>one</p>\n");
write(a, "Other/index.html", "<p>other</p>\n");
commit(a, "start");
assert.equal((await syncOnce(a)).pushed, 1);
execFileSync("git", ["clone", "-q", bare, b]);

// Nothing moved: a quiet check pushes and pulls nothing.
assert.deepEqual(await syncOnce(b), { pulled: 0, pushed: 0, conflicts: [] });

// Both edit the same line of Todos; B also edits a file A never touched.
write(a, "Todos/index.html", "<h1>Todos</h1>\n<p>one from a</p>\n");
commit(a, "a edits");
await syncOnce(a);
write(b, "Todos/index.html", "<h1>Todos</h1>\n<p>one from b</p>\n");
commit(b, "b edits");
write(b, "Other/index.html", "<p>other from b</p>\n");
commit(b, "b edits other");

const r = await syncOnce(b);
assert.equal(r.pulled, 1);
assert.equal(r.pushed, 2);
assert.equal(r.conflicts.length, 1);
assert.match(r.conflicts[0], /^Todos\/index \(conflict \d{4}-\d\d-\d\d \d{4}\)\.html$/);
assert.equal(fs.readFileSync(path.join(b, "Todos/index.html"), "utf8"), "<h1>Todos</h1>\n<p>one from a</p>\n");
assert.equal(fs.readFileSync(path.join(b, r.conflicts[0]), "utf8"), "<h1>Todos</h1>\n<p>one from b</p>\n");
assert.equal(fs.readFileSync(path.join(b, "Other/index.html"), "utf8"), "<p>other from b</p>\n");
assert.equal(git(b, "status", "--porcelain"), "");
assert.ok(!fs.existsSync(path.join(b, ".git", "rebase-merge")));

// A pulls everything back, conflict copy included.
const ra = await syncOnce(a);
assert.equal(ra.pulled, 2);
assert.equal(git(a, "rev-parse", "main"), git(b, "rev-parse", "main"));
assert.ok(fs.existsSync(path.join(a, r.conflicts[0])));

fs.rmSync(tmp, { recursive: true, force: true });
console.log("smoke-sync ok");
