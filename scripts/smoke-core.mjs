// Smoke test for core: vault, pages, git, lock. Run: node scripts/smoke-core.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVault, vaultName, currentUser, resolveVault, migrateVault, migrateVaultNames, migrateConfigDirName } from "../core/vault.mjs";
import { createPage, createFolder, listTree, walkTree, findPage, readEntry, writeEntry, pathDir, isPageDir, readManifest, writeManifest } from "../core/pages.mjs";
import { commitPaths, gitLog, gitStatus } from "../core/git.mjs";
import { movePath } from "../core/move.mjs";
import { renameHeader, headerName } from "../core/html.mjs";
import { dropFolder, dropMoveTarget, isPlainFile, moveFile, importDropped, renameTarget, convertFileToPage } from "../core/drop.mjs";
import { isExcluded, excludedBy, readSearchExclude, setSearchExcluded, dropSearchExclude, readVaultSettings, writeVaultSettings } from "../core/searchExclude.mjs";
import { beginEdit, endEdit, abortEdit, getLock, listLocks, snapshotDir } from "../core/lock.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-smoke-"));
const vault = createVault(path.join(tmp, "Smoke"), { name: "Smoke", seed: false });
try {
  assert.equal(vaultName(vault), "Smoke");
  assert.match(currentUser(), /^[a-z0-9_-]+$/);
  assert.equal(resolveVault({ cwd: vault }), vault);
  assert.equal(gitLog(vault)[0].message, "Create vault");
  const ignore = fs.readFileSync(path.join(vault, ".gitignore"), "utf8");
  assert.ok(ignore.includes(".noteblock/locks/") && ignore.includes(".quire/locks/"));
  assert.ok(fs.existsSync(path.join(vault, ".noteblock", "vault.json")));
  assert.ok(!fs.existsSync(path.join(vault, ".quire")));

  // pages
  createFolder(vault, "Trips");
  const trip = createPage(vault, "Trips/Kyoto trip");
  assert.equal(trip.kind, "page");
  assert.equal(trip.format, "html");
  assert.equal(trip.entry, "index.html");
  assert.match(trip.id, /^[a-z0-9]{10}$/);
  createPage(vault, "Trips/Notes", { format: "md" });
  createPage(vault, "Alpha");
  assert.throws(() => createPage(vault, "Nope/Child"), /No folder/);
  // Names a Windows PC can't hold are refused on every OS.
  for (const bad of ["Trip: day 1", "What?", "a|b", 'say "hi"', "CON", "nul.txt", "COM3", "LPT1"]) {
    assert.throws(() => createPage(vault, bad), /Names can't|Windows keeps/, bad);
    assert.throws(() => createFolder(vault, bad), /Names can't|Windows keeps/, bad);
  }
  // Every vault repo: no line-ending conversion, long paths on.
  assert.equal(execFileSync("git", ["-C", vault, "config", "--local", "core.autocrlf"], { encoding: "utf8" }).trim(), "false");
  assert.equal(execFileSync("git", ["-C", vault, "config", "--local", "core.longpaths"], { encoding: "utf8" }).trim(), "true");
  assert.throws(() => createPage(vault, "Alpha/Child"), /is a page/);
  assert.throws(() => createFolder(vault, "Alpha/Sub"), /is a page/);
  fs.mkdirSync(path.join(vault, ".hidden"));
  const tree = listTree(vault);
  assert.deepEqual(tree.map((n) => [n.kind, n.path]), [["folder", "Trips"], ["page", "Alpha"]]);
  assert.deepEqual(tree[0].children.map((n) => n.path), ["Trips/Kyoto trip", "Trips/Notes"]);
  assert.equal(tree[0].children[1].format, "md");
  assert.equal(readEntry(vault, "Trips/Notes").content, "# Notes\n");
  assert.throws(() => findPage(vault, "Missing"), /No page: Missing/);
  assert.throws(() => findPage(vault, "Trips"), /No page: Trips/);
  // a page's own subfolders are its files, never rows
  fs.mkdirSync(path.join(pathDir(vault, "Alpha"), "lib"));
  assert.deepEqual(listTree(vault)[1].children, []);

  // data dir must survive snapshot/abort untouched
  const dir = pathDir(vault, "Trips/Kyoto trip");
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, "data", "me.sqlite"), "db");
  fs.writeFileSync(path.join(dir, "app.js"), "// v1\n");
  const original = readEntry(vault, "Trips/Kyoto trip").content;

  // begin → modify → abort restores
  const { lock, dir: editDir } = beginEdit(vault, "Trips/Kyoto trip", { message: "Add itinerary" });
  assert.equal(editDir, dir);
  assert.match(lock.id, /^[a-z0-9]{10}$/);
  assert.ok(fs.existsSync(path.join(snapshotDir(vault, lock.id), "index.html")));
  assert.ok(!fs.existsSync(path.join(snapshotDir(vault, lock.id), "data")));
  assert.equal(findPage(vault, lock.id).lock.message, "Add itinerary");
  assert.equal(listLocks(vault).length, 1);
  assert.throws(() => beginEdit(vault, "Trips/Kyoto trip"), /Already being edited by Claude since/);
  writeEntry(vault, "Trips/Kyoto trip", "<p>broken</p>");
  fs.writeFileSync(path.join(dir, "extra.css"), "body{}");
  fs.rmSync(path.join(dir, "app.js"));
  abortEdit(vault, "Trips/Kyoto trip");
  assert.equal(readEntry(vault, "Trips/Kyoto trip").content, original);
  assert.equal(fs.readFileSync(path.join(dir, "app.js"), "utf8"), "// v1\n");
  assert.ok(!fs.existsSync(path.join(dir, "extra.css")));
  assert.equal(fs.readFileSync(path.join(dir, "data", "me.sqlite"), "utf8"), "db");
  assert.equal(getLock(vault, lock.id), null);
  assert.ok(!fs.existsSync(snapshotDir(vault, lock.id)));
  assert.throws(() => abortEdit(vault, "Trips/Kyoto trip"), /Not being edited/);

  // begin → modify → end commits as Claude
  beginEdit(vault, lock.id, { message: "Add itinerary" });
  writeEntry(vault, "Trips/Kyoto trip", original.replace(/<body>[\s\S]*<\/body>/, "<body><h1>Itinerary</h1></body>"));
  const { commit } = endEdit(vault, "Trips/Kyoto trip", {});
  assert.match(commit, /^[0-9a-f]{40}$/);
  const [head] = gitLog(vault, 1);
  assert.equal(head.sha, commit);
  assert.equal(head.message, "Add itinerary");
  assert.equal(head.author, "Claude <claude@quire.local>");
  assert.deepEqual(gitStatus(vault), []);
  assert.equal(getLock(vault, lock.id), null);

  // nothing to commit → null
  beginEdit(vault, "Trips/Kyoto trip", { message: "No-op" });
  assert.equal(endEdit(vault, "Trips/Kyoto trip").commit, null);

  // v1 → v2 migration: Name.app dirs (nested) become folders + pages
  const old = path.join(tmp, "Old");
  fs.mkdirSync(path.join(old, ".quire"), { recursive: true });
  fs.writeFileSync(path.join(old, ".quire", "vault.json"), JSON.stringify({ name: "Old", version: 1, order: ["x"] }));
  const mk = (rel, id, file = "index.html") => {
    fs.mkdirSync(path.join(old, rel), { recursive: true });
    fs.writeFileSync(path.join(old, rel, "app.json"), JSON.stringify({ id }));
    fs.writeFileSync(path.join(old, rel, file), "x");
  };
  mk("Solo.app", "aaaaaaaaaa");
  mk("Trip.app", "bbbbbbbbbb");
  mk("Trip.app/Budget.app", "cccccccccc");
  mk("Trip.app/Budget.app/Deep.app", "dddddddddd", "index.md");
  fs.mkdirSync(path.join(old, "Trip.app/Budget.app/data"));
  assert.equal(migrateVault(old), true);
  assert.equal(migrateVault(old), false);
  const paths = [...(function* w(ns) { for (const n of ns) { yield n.kind + ":" + n.path; yield* w(n.children); } })(listTree(old))];
  assert.deepEqual(paths, ["folder:Trip", "folder:Trip/Budget", "page:Trip/Budget/Budget", "page:Trip/Budget/Deep", "page:Trip/Trip", "page:Solo"]);
  assert.equal(findPage(old, "cccccccccc").path, "Trip/Budget/Budget");
  assert.ok(fs.existsSync(path.join(old, "Trip/Budget/Budget/data")));
  assert.equal(findPage(old, "Trip/Budget/Deep").format, "md");
  assert.ok(!fs.existsSync(path.join(old, "Solo", "app.json")));
  assert.ok(isPageDir(path.join(old, "Solo")));

  // Quire → Noteblock file names: a vault as 0.3.2 left it.
  const q = path.join(tmp, "Quire era");
  const git = (...args) => execFileSync("git", ["-C", q, ...args], { encoding: "utf8" });
  const qpage = (rel, m) => {
    fs.mkdirSync(path.join(q, rel), { recursive: true });
    fs.writeFileSync(path.join(q, rel, ".quire"), JSON.stringify(m) + "\n");
    fs.writeFileSync(path.join(q, rel, "index.html"), "<p>x</p>\n");
  };
  fs.mkdirSync(path.join(q, ".quire", "locks"), { recursive: true });
  fs.writeFileSync(path.join(q, ".quire", "vault.json"), JSON.stringify({ name: "Quire era", version: 2 }) + "\n");
  fs.writeFileSync(path.join(q, ".gitignore"), "data/\n.quire/snapshots/\n.quire/locks/\n.quire/cache/\n");
  qpage("Top", { id: "aaaaaaaaa1", entry: "index.html", title: "Top page" });
  qpage("Trips/Kyoto", { id: "aaaaaaaaa2", entry: "index.html" });
  qpage("Trips/node_modules/pkg", { id: "aaaaaaaaa3" }); // never walked
  fs.mkdirSync(path.join(q, "Top", "lib")); // a page's own folder: never walked
  fs.writeFileSync(path.join(q, "Top", "lib", ".quire"), "{}\n");
  execFileSync("git", ["init", "-q", "-b", "main", q]);
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "0.3.2");
  // Readers take the old names as they are.
  assert.ok(isPageDir(path.join(q, "Top")));
  assert.equal(vaultName(q), "Quire era");
  assert.equal(findPage(q, "aaaaaaaaa2").path, "Trips/Kyoto");
  // A lock an older CLI holds is still seen, and moves with the dir.
  fs.writeFileSync(path.join(q, ".quire", "locks", "aaaaaaaaa1.json"), JSON.stringify({ id: "aaaaaaaaa1", path: "Top", by: "Claude" }));
  assert.equal(listLocks(q).length, 1);
  fs.writeFileSync(path.join(q, "Top", "notes.txt"), "pending autosave\n"); // not ours: stays uncommitted

  const r1 = migrateVaultNames(q);
  assert.equal(r1.changed, true);
  assert.match(r1.commit, /^[0-9a-f]{40}$/);
  assert.equal(gitLog(q, 1)[0].message, "Rename Quire files to Noteblock");
  assert.ok(!fs.existsSync(path.join(q, ".quire")));
  assert.ok(fs.existsSync(path.join(q, ".noteblock", "vault.json")));
  assert.equal(listLocks(q).length, 1);
  assert.equal(readManifest(path.join(q, "Top")).title, "Top page");
  for (const rel of ["Top", "Trips/Kyoto"]) {
    assert.ok(fs.existsSync(path.join(q, rel, ".noteblock")), rel);
    assert.ok(!fs.existsSync(path.join(q, rel, ".quire")), rel);
  }
  assert.ok(fs.existsSync(path.join(q, "Trips/node_modules/pkg/.quire")));
  assert.ok(fs.existsSync(path.join(q, "Top/lib/.quire")));
  const qi = fs.readFileSync(path.join(q, ".gitignore"), "utf8");
  for (const l of [".noteblock/locks/", ".noteblock/snapshots/", ".noteblock/cache/", ".quire/locks/"]) assert.ok(qi.split("\n").includes(l), l);
  // Only the renamed paths went in: the lock stays ignored, the stray file stays uncommitted.
  const committed = git("show", "--no-renames", "--name-only", "--format=", "HEAD").trim().split("\n").sort();
  assert.deepEqual(committed, [".gitignore", ".noteblock/vault.json", ".quire/vault.json", "Top/.noteblock", "Top/.quire", "Trips/Kyoto/.noteblock", "Trips/Kyoto/.quire"]);
  assert.deepEqual(gitStatus(q), ["?? Top/notes.txt"]);
  // Idempotent: nothing left to rename, no commit.
  const head1 = gitLog(q, 1)[0].sha;
  assert.deepEqual(migrateVaultNames(q), { changed: false, commit: null });
  assert.equal(gitLog(q, 1)[0].sha, head1);
  fs.rmSync(path.join(q, ".noteblock", "locks", "aaaaaaaaa1.json"));

  // Mixed state: an older install wrote .quire/ again beside .noteblock/, a page has both
  // manifests, and a page synced in later still has only .quire.
  fs.mkdirSync(path.join(q, ".quire", "locks"), { recursive: true });
  fs.writeFileSync(path.join(q, ".quire", "vault.json"), JSON.stringify({ name: "Stale", version: 2 }) + "\n");
  fs.writeFileSync(path.join(q, ".quire", "locks", "bbbbbbbbb1.json"), JSON.stringify({ id: "bbbbbbbbb1", path: "Late", by: "Codex" }));
  fs.writeFileSync(path.join(q, ".quire", "extra.json"), "{}\n");
  fs.writeFileSync(path.join(q, "Top", ".quire"), JSON.stringify({ id: "aaaaaaaaa1", title: "Stale title" }) + "\n");
  qpage("Late", { id: "aaaaaaaaa4", entry: "index.html", title: "Synced later" });
  // Reader fallback before migrating: .noteblock wins over .quire, .quire alone still reads.
  assert.equal(readManifest(path.join(q, "Top")).title, "Top page");
  assert.equal(findPage(q, "Late").title, "Synced later");
  assert.equal(findPage(q, "aaaaaaaaa4").path, "Late");
  assert.equal(vaultName(q), "Quire era");
  assert.equal(listLocks(q).length, 1);
  const r2 = migrateVaultNames(q);
  assert.equal(r2.changed, true);
  assert.ok(!fs.existsSync(path.join(q, ".quire")));
  assert.equal(vaultName(q), "Quire era"); // the new vault.json won the merge
  assert.ok(fs.existsSync(path.join(q, ".noteblock", "extra.json")));
  assert.ok(fs.existsSync(path.join(q, ".noteblock", "locks", "bbbbbbbbb1.json")));
  assert.equal(readManifest(path.join(q, "Top")).title, "Top page");
  assert.ok(!fs.existsSync(path.join(q, "Top", ".quire")));
  assert.ok(fs.existsSync(path.join(q, "Late", ".noteblock")) && !fs.existsSync(path.join(q, "Late", ".quire")));
  assert.deepEqual(migrateVaultNames(q), { changed: false, commit: null });
  // Writers write .noteblock and drop an old .quire beside it.
  fs.writeFileSync(path.join(q, "Late", ".quire"), "{}\n");
  writeManifest(path.join(q, "Late"), { id: "aaaaaaaaa4" });
  assert.ok(!fs.existsSync(path.join(q, "Late", ".quire")));
  // resolveVault migrates a Quire-era vault before anything reads it.
  const q2 = path.join(tmp, "Quire era 2");
  fs.mkdirSync(path.join(q2, ".quire"), { recursive: true });
  fs.writeFileSync(path.join(q2, ".quire", "vault.json"), JSON.stringify({ name: "Two", version: 2 }) + "\n");
  fs.mkdirSync(path.join(q2, "P"));
  fs.writeFileSync(path.join(q2, "P", ".quire"), "{}\n");
  assert.equal(resolveVault({ vault: q2 }), q2);
  assert.ok(fs.existsSync(path.join(q2, ".noteblock", "vault.json")) && fs.existsSync(path.join(q2, "P", ".noteblock")));

  // Config dir: ~/.quire → ~/.noteblock with a symlink back; never over an existing new dir.
  const oldCfg = path.join(tmp, "home", ".quire");
  const newCfg = path.join(tmp, "home", ".noteblock");
  fs.mkdirSync(oldCfg, { recursive: true });
  fs.writeFileSync(path.join(oldCfg, "config.json"), '{"current":null}\n');
  assert.equal(migrateConfigDirName(oldCfg, newCfg), true);
  assert.ok(fs.lstatSync(oldCfg).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(oldCfg, "config.json"), "utf8"), '{"current":null}\n');
  assert.equal(migrateConfigDirName(oldCfg, newCfg), false);
  const otherOld = path.join(tmp, "home", ".quire-dev");
  fs.mkdirSync(otherOld);
  assert.equal(migrateConfigDirName(otherOld, newCfg), false);
  assert.ok(fs.lstatSync(otherOld).isDirectory());

  // Sidebar drag and drop (core/drop.mjs).
  const dv = createVault(path.join(tmp, "Drops"), { name: "Drops", seed: false });
  createFolder(dv, "A");
  createFolder(dv, "A/B");
  createPage(dv, "A/P");
  fs.writeFileSync(path.join(dv, "A", "note.txt"), "x");
  assert.equal(dropFolder(dv, "A/P"), "A");
  assert.equal(dropFolder(dv, "A/note.txt"), "A");
  assert.equal(dropFolder(dv, "A/B"), "A/B");
  assert.equal(dropMoveTarget(dv, "A/P", "A"), null);
  assert.equal(dropMoveTarget(dv, "A/P", "A/P"), null);
  assert.equal(dropMoveTarget(dv, "A", "A/B"), null);
  assert.equal(dropMoveTarget(dv, "A/P", ""), "P");
  assert.equal(dropMoveTarget(dv, "A/note.txt", "A/B"), "A/B/note.txt");
  assert.throws(() => dropMoveTarget(dv, "A/P", "../out"), /Bad path/);
  assert.ok(isPlainFile(dv, "A/note.txt") && !isPlainFile(dv, "A/P"));
  assert.equal(moveFile(dv, "A/note.txt", "A/B/note.txt").to, "A/B/note.txt");
  fs.writeFileSync(path.join(dv, "A", "note.txt"), "y");
  assert.throws(() => moveFile(dv, "A/note.txt", "A/B/note.txt"), /Already exists/);
  assert.equal(movePath(dv, "A/P", "A/B/P").to, "A/B/P");

  const out = path.join(tmp, "outside");
  fs.mkdirSync(path.join(out, "site", "css"), { recursive: true });
  fs.mkdirSync(path.join(out, "empty"));
  fs.writeFileSync(path.join(out, "Plan.html"), "<html><body>plan</body></html>");
  fs.writeFileSync(path.join(out, "Notes.MD"), "# Notes\n");
  fs.writeFileSync(path.join(out, "data.csv"), "a,b\n");
  fs.writeFileSync(path.join(out, "site", "index.html"), "<body>site</body>");
  fs.writeFileSync(path.join(out, "site", "css", "a.css"), "a{}");
  fs.symlinkSync(path.join(tmp, "Smoke"), path.join(out, "site", "link"));
  const sources = ["Plan.html", "Notes.MD", "data.csv", "site"].map((n) => path.join(out, n));
  const before = gitLog(dv).length;
  const dropped = importDropped(dv, { sources, folder: "A" });
  assert.deepEqual(dropped.imported.map((i) => i.path), ["A/Plan", "A/Notes", "A/data.csv", "A/site"]);
  assert.equal(gitLog(dv).length, before + 1);
  assert.ok(!gitStatus(dv).some((l) => l.includes("A/Plan")));
  assert.equal(findPage(dv, "A/Plan").entry, "index.html");
  assert.equal(findPage(dv, "A/Notes").entry, "index.md");
  assert.equal(fs.readFileSync(path.join(dv, "A", "data.csv"), "utf8"), "a,b\n");
  assert.ok(fs.existsSync(path.join(dv, "A", "site", "css", "a.css")) && !fs.existsSync(path.join(dv, "A", "site", "link")));
  assert.ok(findPage(dv, "A/site").id);
  for (const s of sources) assert.ok(fs.existsSync(s));
  // Collisions get a number, a page target means its folder, and nothing lands outside.
  const again = importDropped(dv, { sources: sources.slice(0, 3), folder: "A/Plan" });
  assert.deepEqual(again.imported.map((i) => i.path), ["A/Plan 2", "A/Notes 2", "A/data 2.csv"]);
  const bad = importDropped(dv, { sources: [path.join(out, "empty"), path.join(dv, "A", "note.txt"), "relative.txt", tmp] });
  assert.deepEqual(bad.imported, []);
  assert.equal(bad.errors.length, 4);
  assert.throws(() => importDropped(dv, { sources, folder: "../.." }), /Bad path/);

  // Exclude from search: exact and prefix-with-slash, never a shared name start.
  assert.ok(isExcluded("Archive", ["Archive"]));
  assert.ok(isExcluded("Archive/Old/Page", ["Archive"]));
  assert.ok(isExcluded("Old/Stuff/x", ["Archive", "Old/Stuff"]));
  assert.ok(isExcluded("Archive/x", ["Archive/"]));
  assert.ok(!isExcluded("Archive 2", ["Archive"]));
  assert.ok(!isExcluded("Archive 2/x", ["Archive"]));
  assert.ok(!isExcluded("Old", ["Old/Stuff"]));
  assert.ok(!isExcluded("Old/Stuffing", ["Old/Stuff"]));
  assert.ok(!isExcluded("Anything", ["", "/"]));
  assert.ok(!isExcluded("Anything", []));
  assert.equal(excludedBy("Old/Stuff/x", ["Old/Stuff", "Old"]), "Old");

  const ev = createVault(path.join(tmp, "Exclude"), { name: "Exclude", seed: false });
  createFolder(ev, "Archive");
  createFolder(ev, "Archive 2");
  createFolder(ev, "Archive/Deep");
  createPage(ev, "Archive/Deep/Buried");
  createPage(ev, "Archive 2/Kept");
  const nodeAt = (p) => [...walkTree(listTree(ev))].find((n) => n.path === p);
  assert.deepEqual(readSearchExclude(ev), []);
  assert.equal(nodeAt("Archive").searchExcluded, undefined);
  writeVaultSettings(ev, { other: 1 });
  assert.deepEqual(setSearchExcluded(ev, "Archive/Deep", true), ["Archive/Deep"]);
  assert.deepEqual(setSearchExcluded(ev, "Archive", true), ["Archive"]); // covers the one before
  assert.deepEqual(setSearchExcluded(ev, "Archive/Deep/Buried", true), ["Archive"]); // already covered
  assert.equal(readVaultSettings(ev).other, 1);
  assert.ok(fs.existsSync(path.join(ev, ".noteblock", "settings.json")));
  assert.throws(() => setSearchExcluded(ev, "Nope", true), /No page or folder/);
  assert.throws(() => setSearchExcluded(ev, "../x", true), /Bad path/);
  assert.equal(nodeAt("Archive/Deep/Buried").searchExcludedBy, "Archive");
  assert.equal(nodeAt("Archive/Deep/Buried").searchExcluded, true);
  assert.equal(nodeAt("Archive 2/Kept").searchExcluded, undefined);
  assert.equal(findPage(ev, "Archive/Deep/Buried").path, "Archive/Deep/Buried"); // still opens
  // Moves and renames carry entries along, inside a moved folder too.
  assert.equal(movePath(ev, "Archive", "Attic").settingsChanged, true);
  assert.deepEqual(readSearchExclude(ev), ["Attic"]);
  assert.equal(nodeAt("Attic/Deep/Buried").searchExcluded, true);
  createFolder(ev, "Shelf");
  movePath(ev, "Attic", "Shelf/Attic");
  assert.deepEqual(readSearchExclude(ev), ["Shelf/Attic"]);
  assert.equal(movePath(ev, "Shelf", "Rack").settingsChanged, true);
  assert.deepEqual(readSearchExclude(ev), ["Rack/Attic"]);
  assert.equal(movePath(ev, "Archive 2", "Other").settingsChanged, undefined);
  assert.ok(dropSearchExclude(ev, "Rack"));
  assert.deepEqual(readSearchExclude(ev), []);
  setSearchExcluded(ev, "Other", true);
  assert.deepEqual(setSearchExcluded(ev, "Gone", false), ["Other"]);
  assert.deepEqual(setSearchExcluded(ev, "Other", false), []);

  // Rename: where a new name lands.
  assert.equal(renameTarget("A/P", "Q"), "A/Q");
  assert.equal(renameTarget("Top", " Next "), "Next");
  assert.equal(renameTarget("A/P", "P"), null);
  assert.throws(() => renameTarget("A/P", "x/y"), /can't contain \//);
  assert.throws(() => renameTarget("A/P", ".."), /can't start with a dot/);
  assert.throws(() => renameTarget("", "x"), /vault itself/);

  // Rename: a header that said the old name follows, and nothing else in the file moves.
  const doc = (body) => `<!doctype html>\r\n<html><head><title>Old</title></head><body class="x">\n${body}\n</body></html>\n`;
  assert.equal(renameHeader(doc('<h1 id="a">Old</h1>\n<p>  Old  </p>'), "html", "Old", "A & B"), doc('<h1 id="a">A &amp; B</h1>\n<p>  Old  </p>'));
  assert.equal(renameHeader(doc("<p>intro</p><h1> <b>Old</b>\n</h1>"), "html", "Old", "New"), doc("<p>intro</p><h1>New</h1>"));
  const same = (s, f = "html") => assert.equal(renameHeader(s, f, "Old", "New"), s);
  same(doc("<h1>Older</h1>"));
  same(doc("<h1>old</h1>")); // case is exact
  same(doc("<h1>Other</h1><h1>Old</h1>")); // only the first h1
  same(doc("<p>x</p><div>made</div><h1>Old</h1>")); // not in the first region
  same(doc("<div><h1>Old</h1></div>"));
  same(doc("<script>'<h1>Old</h1>'</script>"));
  same(doc('<h1 data-app>Old</h1>'));
  const md = (s) => renameHeader(s, "md", "Old", "New");
  assert.equal(md("# Old\n\ntext Old\n"), "# New\n\ntext Old\n");
  assert.equal(md("---\ntitle: x\n# Old\n---\n\n# Old #\r\nbody\r\n"), "---\ntitle: x\n# Old\n---\n\n# New #\r\nbody\r\n");
  assert.equal(md("intro\n\n```\n# Old\n```\n\n#   Old\n"), "intro\n\n```\n# Old\n```\n\n#   New\n");
  assert.equal(renameHeader("# My\\_plan\n", "md", "My_plan", "a*b"), "# a\\*b\n");
  same("## Old\n", "md");
  same("# Other\n\n# Old\n", "md");
  same("Title\n===\n\n# Old\n", "md");
  same("    # Old\n", "md");
  assert.equal(headerName(" a  /  b "), "a - b");

  // Convert a plain file in the vault to a page where it sits.
  const cv = createVault(path.join(tmp, "Converts"), { name: "Converts", seed: false });
  createFolder(cv, "Docs");
  fs.writeFileSync(path.join(cv, "Docs", "Plan.html"), "<html><body>plan</body></html>");
  commitPaths(cv, "plan", ["Docs/Plan.html"]);
  const conv = convertFileToPage(cv, "Docs/Plan.html");
  assert.deepEqual([conv.from, conv.to, conv.kind], ["Docs/Plan.html", "Docs/Plan", "page"]);
  assert.ok(conv.commit, "convert commits");
  assert.ok(!fs.existsSync(path.join(cv, "Docs", "Plan.html")));
  assert.equal(findPage(cv, "Docs/Plan").entry, "index.html");
  assert.match(fs.readFileSync(path.join(cv, "Docs", "Plan", "index.html"), "utf8"), /<body data-q-theme="none">plan/);
  assert.equal(execFileSync("git", ["-C", cv, "status", "--porcelain", "--", "Docs/Plan", "Docs/Plan.html"], { encoding: "utf8" }).trim(), "", "nothing left uncommitted");
  // Name collision: the page's name is taken, the file gets the next free one and stays whole.
  fs.writeFileSync(path.join(cv, "Docs", "Plan.md"), "# Again\n");
  const taken = convertFileToPage(cv, "Docs/Plan.md");
  assert.equal(taken.to, "Docs/Plan 2");
  assert.equal(findPage(cv, "Docs/Plan 2").entry, "index.md");
  assert.equal(fs.readFileSync(path.join(cv, "Docs", "Plan 2", "index.md"), "utf8"), "# Again\n");
  fs.writeFileSync(path.join(cv, "Old.HTM"), "<body>old</body>");
  assert.equal(convertFileToPage(cv, "Old.HTM").to, "Old");
  // Refusals, each leaving things as they were.
  assert.throws(() => convertFileToPage(cv, "Docs"), /Not a file/);
  assert.throws(() => convertFileToPage(cv, "Docs/Plan"), /Not a file/);
  assert.throws(() => convertFileToPage(cv, "Docs/Gone.html"), /Not a file/);
  assert.throws(() => convertFileToPage(cv, "Docs/Plan/index.html"), /is a file of the page/);
  fs.writeFileSync(path.join(cv, "data.csv"), "a,b\n");
  assert.throws(() => convertFileToPage(cv, "data.csv"), /can become pages/);
  assert.ok(isPlainFile(cv, "data.csv") && !fs.existsSync(path.join(cv, "data")));

  console.log("smoke-core: ok");
  for (const c of gitLog(vault)) console.log(`  ${c.sha.slice(0, 7)} ${c.author}  ${c.message}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
