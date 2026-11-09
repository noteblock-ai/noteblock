// Smoke test for importing Claude artifacts. Run: node scripts/smoke-artifacts.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVault } from "../core/vault.mjs";
import { findPage, readManifest, listTree, walkTree } from "../core/pages.mjs";
import { gitLog, gitStatus } from "../core/git.mjs";
import { beginEdit, abortEdit } from "../core/lock.mjs";
import { importArtifact, importArtifactFiles, artifactTitle } from "../core/index.mjs";
import { artifactPrompt } from "../app/renderer/src/artifactPrompt.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "quire.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-artifacts-"));
const put = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), body);
  return path.join(tmp, rel);
};
try {
  assert.equal(artifactTitle("<html><head><title>Tip &amp; split</title></head></html>"), "Tip & split");
  assert.equal(artifactTitle("<body><h1>Big <em>plan</em></h1></body>"), "Big plan");
  assert.equal(artifactTitle("---\na: 1\n---\n# Notes\n", "md"), "Notes");

  const vault = createVault(path.join(tmp, "Vault"), { name: "Vault", seed: false });

  // a single HTML file
  const file = put("dl/page.html", "<!doctype html><html><head><title>Budget board</title></head><body><h1>Hi</h1></body></html>");
  const a = importArtifact(vault, { source: file, url: "https://claude.ai/artifact/abc" });
  assert.equal(a.path, "Artifacts/Budget board");
  assert.equal(a.updated, false);
  assert.ok(a.commit);
  assert.ok(fs.existsSync(path.join(vault, "Artifacts", ".gitkeep")));
  const m = readManifest(a.dir);
  assert.match(m.id, /^[a-z0-9]{10}$/);
  assert.equal(m.entry, "index.html");
  assert.equal(m.title, undefined); // same as the folder name
  assert.equal(m.origin.kind, "claude-artifact");
  assert.equal(m.origin.url, "https://claude.ai/artifact/abc");
  assert.ok(m.origin.importedAt);
  assert.equal(findPage(vault, a.path).format, "html");
  assert.equal(gitLog(vault, 1)[0].message, "Import artifact Artifacts/Budget board");

  // same name, different artifact → de-duped
  const b = importArtifact(vault, { source: file });
  assert.equal(b.path, "Artifacts/Budget board 2");

  // a folder with index.html + supporting files, custom name and folder
  put("site/index.html", "<html><body><h1>Map</h1><script src='app.js'></script></body></html>");
  put("site/app.js", "console.log(1)");
  put("site/img/dot.svg", "<svg/>");
  put("site/.hidden", "x");
  const c = importArtifact(vault, { source: path.join(tmp, "site"), name: "Route map", folder: "Work/Claude" });
  assert.equal(c.path, "Work/Claude/Route map");
  for (const f of ["index.html", "app.js", "img/dot.svg"]) assert.ok(fs.existsSync(path.join(c.dir, f)), f);
  assert.ok(!fs.existsSync(path.join(c.dir, ".hidden")));
  assert.equal(readManifest(c.dir).title, "Map");

  // markdown
  const d = importArtifact(vault, { source: put("notes.md", "# Reading list\n\n- one\n") });
  assert.equal(d.path, "Artifacts/Reading list");
  assert.equal(readManifest(d.dir).entry, "index.md");

  // re-import the same url → updates in place, keeps id and data/
  const id = m.id;
  fs.mkdirSync(path.join(a.dir, "data"));
  fs.writeFileSync(path.join(a.dir, "data", "me.sqlite"), "rows");
  fs.writeFileSync(path.join(a.dir, "old.css"), "x");
  const file2 = put("dl/page2.html", "<html><head><title>Budget board v2</title></head><body></body></html>");
  const e = importArtifact(vault, { source: file2, url: "https://claude.ai/artifact/abc" });
  assert.equal(e.updated, true);
  assert.equal(e.path, a.path);
  const m2 = readManifest(e.dir);
  assert.equal(m2.id, id);
  assert.equal(m2.title, "Budget board v2");
  assert.ok(fs.readFileSync(path.join(e.dir, "index.html"), "utf8").includes("v2"));
  assert.ok(!fs.existsSync(path.join(e.dir, "old.css")));
  assert.ok(fs.existsSync(path.join(e.dir, "data", "me.sqlite")));
  const withUrl = [...walkTree(listTree(vault))].filter((n) => n.kind === "page" && readManifest(n.dir).origin?.url === "https://claude.ai/artifact/abc");
  assert.equal(withUrl.length, 1);
  assert.equal(gitLog(vault, 1)[0].message, "Update artifact Artifacts/Budget board");
  assert.deepEqual(gitStatus(vault), []);

  // a locked page is refused
  beginEdit(vault, a.path, { message: "x" });
  assert.throws(() => importArtifact(vault, { source: file2, url: "https://claude.ai/artifact/abc" }), /being edited/);
  abortEdit(vault, id);

  // errors
  assert.throws(() => importArtifact(vault, { source: put("x.txt", "hi") }), /Not an artifact/);
  assert.throws(() => importArtifact(vault, { source: file, folder: "Artifacts/Budget board" }), /inside a page/);

  // CLI
  const outText = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "import-artifact", file2, "--vault", vault, "--url", "https://claude.ai/artifact/zzz", "--json"], { encoding: "utf8" });
  const r = JSON.parse(outText);
  assert.equal(r.path, "Artifacts/Budget board v2");
  assert.equal(readManifest(r.dir).origin.url, "https://claude.ai/artifact/zzz");

  // --skip-existing leaves an imported url alone
  const before = fs.readFileSync(path.join(a.dir, "index.html"), "utf8");
  const sk = importArtifact(vault, { source: file, url: "https://claude.ai/artifact/abc", skipExisting: true });
  assert.equal(sk.skipped, true);
  assert.equal(sk.path, a.path);
  assert.equal(fs.readFileSync(path.join(a.dir, "index.html"), "utf8"), before);
  const skCli = JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "import-artifact", file, "--vault", vault, "--url", "https://claude.ai/artifact/zzz", "--skip-existing", "--json"], { encoding: "utf8" }));
  assert.equal(skCli.skipped, true);

  // several downloads at once: files, an artifact folder, a folder of files, a bad one → one commit
  put("many/one.html", "<title>One</title>");
  put("many/two.md", "# Two\n");
  put("many/skip.txt", "x");
  put("app2/index.html", "<title>App two</title>");
  const bad = put("bad.txt", "x");
  const commits = gitLog(vault, 100).length;
  const f = importArtifactFiles(vault, { sources: [path.join(tmp, "many"), path.join(tmp, "app2"), file, bad], folder: "Downloads/Claude" });
  assert.equal(f.pages, 4);
  assert.equal(f.dest, "Downloads/Claude");
  assert.equal(f.first, "Downloads/Claude/One");
  assert.deepEqual(f.errors.map((e) => e.source), [bad]);
  assert.match(f.errors[0].error, /Not an artifact/);
  for (const p of ["One", "Two", "App two", "Budget board"]) assert.ok(findPage(vault, "Downloads/Claude/" + p), p);
  assert.equal(gitLog(vault, 100).length, commits + 1);
  assert.equal(gitLog(vault, 1)[0].message, "Import 4 artifacts into Downloads/Claude");
  assert.deepEqual(gitStatus(vault), []);
  assert.equal(importArtifactFiles(vault, { sources: [bad] }).commit, null);

  // the Claude Code prompt
  const p1 = artifactPrompt({ vault: "/v/Q", folder: "Artifacts" });
  assert.match(p1, /scope "mine", limit 200/);
  assert.match(p1, /--vault "\/v\/Q" --url "<artifact url>" --name "<artifact title>" --folder "Artifacts"\n/);
  assert.doesNotMatch(p1, /skip-existing/);
  const p2 = artifactPrompt({ vault: "/v/Q", folder: "", which: "recent", recent: 5, shared: true, update: false });
  assert.match(p2, /scope "all", limit 5/);
  assert.match(p2, /--folder "" --skip-existing/);
  assert.match(p2, /top level of the vault/);
  const p3 = artifactPrompt({ vault: "/v/Q", folder: "A", which: "these", these: " https://claude.ai/artifact/x \n\nTrip budget\n" });
  assert.match(p3, /- https:\/\/claude.ai\/artifact\/x\n- Trip budget\n/);

  console.log("smoke-artifacts ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Imported HTML artifacts opt out of Quire's theme (full width, their own styles).
{
  const { untheme } = await import("../core/artifacts.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-untheme-"));
  const f = path.join(tmp, "a.html");
  fs.writeFileSync(f, '<!doctype html><html><head></head><body class="x"><p>hi</p></body></html>');
  if (!untheme(f) || !fs.readFileSync(f, "utf8").includes('<body data-q-theme="none" class="x">')) throw new Error("untheme did not add data-q-theme");
  if (untheme(f)) throw new Error("untheme changed a body that already has data-q-theme");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("smoke-artifacts: untheme ok");
}
