// Smoke test for page templates (core/templates.mjs + the CLI). Run: node scripts/smoke-templates.mjs
// QUIRE_CONFIG_DIR and HOME point at temp dirs so the real ~/.noteblock is never touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.removeAllListeners("warning"); // node:sqlite is experimental
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quire-templates-smoke-")));
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");
const { createVault, createFolder, createPage, readManifest, listTemplates, seedTemplates, templatesDir, createFromTemplate, saveAsTemplate, findTemplate, parseTemplateUrl, addTemplateFromUrl } = await import("../core/index.mjs");
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "quire.mjs");

try {
  // seed: only when the folder is missing
  const dir = templatesDir();
  assert.equal(dir, path.join(tmp, "config", "templates"));
  assert.equal(fs.existsSync(dir), false);
  const list = listTemplates();
  assert.deepEqual(list.map((t) => t.path), ["Lists/Checklist", "Notes/Daily note", "Trackers/Habits"]);
  const daily = list.find((t) => t.title === "Daily note");
  assert.equal(daily.category, "Notes");
  assert.equal(daily.format, "md");
  assert.ok(daily.description);
  assert.equal(daily.files, 2);
  fs.rmSync(path.join(dir, "Trackers"), { recursive: true });
  assert.deepEqual(seedTemplates(), []); // folder exists: never re-seeds on its own
  assert.equal(listTemplates().length, 2);
  fs.writeFileSync(path.join(dir, "Lists", "Checklist", "mine.txt"), "keep");
  assert.deepEqual(seedTemplates({ restore: true }), ["Trackers/Habits"]); // restore adds missing only
  assert.equal(fs.readFileSync(path.join(dir, "Lists", "Checklist", "mine.txt"), "utf8"), "keep");
  assert.equal(findTemplate("habits").path, "Trackers/Habits");
  assert.throws(() => findTemplate("Nope"), /No template: Nope/);

  // create from template: fresh id, no data/ or dotfiles, title/description left behind, de-duped
  const vault = createVault(path.join(tmp, "Vault"), { seed: false });
  // A Quire-era template (.quire manifest) is still listed, and a page made from it gets .noteblock.
  fs.mkdirSync(path.join(dir, "Old", "Legacy"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Old", "Legacy", ".quire"), JSON.stringify({ entry: "index.html", title: "Legacy" }) + "\n");
  fs.writeFileSync(path.join(dir, "Old", "Legacy", "index.html"), "<p>old</p>\n");
  assert.ok(listTemplates().some((t) => t.path === "Old/Legacy"));
  const legacy = createFromTemplate(vault, "Old/Legacy", "", "From legacy");
  assert.ok(fs.existsSync(path.join(legacy.dir, ".noteblock")) && !fs.existsSync(path.join(legacy.dir, ".quire")));
  assert.match(readManifest(legacy.dir).id, /^[a-z0-9]{10}$/);
  fs.rmSync(path.join(dir, "Old"), { recursive: true });
  fs.rmSync(legacy.dir, { recursive: true });
  createFolder(vault, "Journal");
  const hab = path.join(dir, "Trackers", "Habits");
  fs.mkdirSync(path.join(hab, "data"));
  fs.writeFileSync(path.join(hab, "data", "me.sqlite"), "x");
  fs.writeFileSync(path.join(hab, ".env"), "SECRET=1");
  fs.mkdirSync(path.join(hab, "node_modules", "x"), { recursive: true });
  const a = createFromTemplate(vault, "Trackers/Habits", "Journal");
  assert.equal(a.path, "Journal/Habits");
  assert.match(a.id, /^[a-z0-9]{10}$/);
  assert.equal(a.title, "Habits");
  for (const f of ["data", ".env", "node_modules"]) assert.equal(fs.existsSync(path.join(a.dir, f)), false, f);
  assert.ok(fs.existsSync(path.join(a.dir, "app.js")));
  const m = readManifest(a.dir);
  assert.equal(m.title, undefined);
  assert.equal(m.description, undefined);
  const b = createFromTemplate(vault, "Trackers/Habits", "Journal");
  assert.equal(b.path, "Journal/Habits 2");
  assert.notEqual(b.id, a.id);
  const c = createFromTemplate(vault, "Notes/Daily note", "", "Oct 22");
  assert.equal(c.path, "Oct 22");
  assert.equal(c.format, "md");
  assert.throws(() => createFromTemplate(vault, "Notes/Daily note", "Oct 22"), /is a page/);
  assert.throws(() => createFromTemplate(vault, "Notes/Daily note", "Missing"), /No folder/);

  // save as template: copies the page minus data/, keeps a title, drops the id
  const p = createPage(vault, "Journal/Reading log");
  fs.mkdirSync(path.join(p.dir, "data"));
  fs.writeFileSync(path.join(p.dir, "data", "me.sqlite"), "x");
  fs.writeFileSync(path.join(p.dir, "app.js"), "// hi\n");
  const t = saveAsTemplate(vault, "Journal/Reading log");
  assert.equal(t.path, "Reading log");
  assert.equal(t.files, 3);
  assert.equal(fs.existsSync(path.join(dir, "Reading log", "data")), false);
  const tm = readManifest(path.join(dir, "Reading log"));
  assert.equal(tm.id, undefined);
  assert.equal(tm.title, "Reading log");
  assert.equal(saveAsTemplate(vault, p.id, "Reading log").path, "Reading log 2");

  // CLI
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  const run = (args) => {
    const r = spawnSync(cli, args, { cwd: vault, encoding: "utf8", env: { ...process.env, HOME: home } });
    if (r.status !== 0) throw new Error(`quire ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
    return r.stdout;
  };
  const out = run(["templates"]);
  assert.ok(out.includes(dir));
  assert.match(out, /Notes\/Daily note/);
  assert.equal(JSON.parse(run(["templates", "--json"])).templates.length, 5);
  assert.equal(run(["new", "Journal/Groceries", "--template", "Checklist"]).trim(), path.join(vault, "Journal", "Groceries"));
  assert.match(readManifest(path.join(vault, "Journal", "Groceries")).id, /^[a-z0-9]{10}$/);
  assert.match(run(["ls"]), /Groceries/);

  // add from a git URL: the address parser (pure)
  const short = parseTemplateUrl("owner/repo");
  assert.equal(short.cloneUrl, "https://github.com/owner/repo.git");
  assert.equal(short.sourceUrl, "https://github.com/owner/repo");
  assert.equal(short.repo, "repo");
  assert.equal(short.ref, null);
  assert.equal(parseTemplateUrl("https://github.com/owner/repo.git/").repo, "repo");
  const tree = parseTemplateUrl("https://github.com/owner/repo/tree/main/some/my%20dir?x=1#y");
  assert.equal(tree.cloneUrl, "https://github.com/owner/repo.git");
  assert.equal(tree.ref, "main");
  assert.equal(tree.subdir, "some/my dir");
  assert.equal(tree.sourceUrl, "https://github.com/owner/repo/tree/main/some/my%20dir");
  assert.equal(parseTemplateUrl("https://github.com/owner/repo/tree/main").subdir, "");
  assert.equal(parseTemplateUrl("https://git.example.com/a/b/thing.git").cloneUrl, "https://git.example.com/a/b/thing.git");
  assert.equal(parseTemplateUrl("https://git.example.com/a/b/thing.git").repo, "thing");
  for (const bad of [
    "",
    "owner",
    "-owner/repo",
    "owner/..",
    "a/b/c",
    "--upload-pack=x",
    "http://github.com/owner/repo",
    "git@github.com:owner/repo.git",
    "ext::sh -c touch%20/tmp/pwn",
    "file:///tmp/repo.git",
    "https://example.com/owner/repo",
    "https://github.com/owner",
    "https://github.com/owner/repo/issues",
    "https://github.com/owner/repo/blob/main/x.md",
    "https://github.com/owner/repo/tree/main/a%2Fb",
    "https://github.com/owner/repo/tree/main/..%2f..%2fx",
    "https://github.com/owner/repo/tree/-x",
  ]) assert.throws(() => parseTemplateUrl(bad), /address/, bad);
  // The URL parser resolves dot segments first, so they can't climb out of the repo.
  assert.equal(parseTemplateUrl("https://github.com/owner/repo/tree/main/../..").tree, null);
  assert.equal(parseTemplateUrl("https://github.com/owner/repo/tree/main/%2e%2e/x").subdir, "");
  assert.throws(() => parseTemplateUrl("https://me:token@github.com/owner/repo"), /username and password/);
  assert.equal(parseTemplateUrl("file:///tmp/r/tree/main/a", { allowFile: true }).subdir, "a");

  // add from a git URL: local repos over file://, no network
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: gitEnv });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const repoAt = (name, files) => {
    const root = path.join(tmp, "repos", name);
    fs.mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
  };
  const commit = (root) => {
    git(root, "add", "-A", "-f");
    git(root, "commit", "-q", "-m", "x");
  };
  const fileUrl = (root) => "file://" + root;
  const add = (url, opts = {}) => addTemplateFromUrl(url, { ...opts, test: { allowFile: true, ...opts.test } });
  const J = (o) => JSON.stringify(o);
  const secret = path.join(tmp, "outside-secret.txt");
  fs.writeFileSync(secret, "TOPSECRET");

  // file:// needs the test flag, and git itself refuses anything but https without it
  await assert.rejects(addTemplateFromUrl(fileUrl(tmp)), /address/);

  // shape 1: a manifest at the top. public, origin, id and a planted sourceUrl go; symlinks don't come.
  const one = repoAt("one-page", {
    ".noteblock": J({ id: "aaaaaaaaaa", title: "One", description: "A nice page", public: { slug: "x" }, origin: { kind: "claude-artifact" }, sourceUrl: "https://evil.example" }),
    "index.html": "<p>one</p>",
    "lib/a.js": "//",
    "data/me.sqlite": "x",
    ".env": "SECRET=1",
    "node_modules/x/y.js": "//",
  });
  fs.symlinkSync(secret, path.join(one, "leak.txt"));
  fs.symlinkSync(path.dirname(secret), path.join(one, "leakdir"));
  commit(one);
  const r1 = await add(fileUrl(one));
  assert.equal(r1.needsConfirm, undefined);
  assert.equal(r1.added.length, 1);
  assert.equal(r1.added[0].path, "one-page");
  assert.equal(r1.added[0].title, "One");
  assert.equal(r1.added[0].description, "A nice page");
  assert.equal(r1.added[0].sourceUrl, fileUrl(one));
  const oneDir = path.join(dir, "one-page");
  const oneM = readManifest(oneDir);
  for (const k of ["id", "public", "origin"]) assert.equal(oneM[k], undefined, k);
  assert.equal(oneM.sourceUrl, fileUrl(one));
  assert.ok(fs.existsSync(path.join(oneDir, "lib", "a.js")));
  for (const f of [".git", "node_modules", "data", ".env", "leak.txt", "leakdir"]) assert.equal(fs.existsSync(path.join(oneDir, f)), false, f);
  for (const f of fs.readdirSync(oneDir, { recursive: true })) assert.equal(fs.lstatSync(path.join(oneDir, f)).isSymbolicLink(), false, f);
  assert.ok(listTemplates().some((x) => x.path === "one-page" && x.description === "A nice page"));
  // No sourceUrl on a page made from it, and a collision gets " 2", title too.
  const fromOne = createFromTemplate(vault, "one-page", "", "From one");
  assert.equal(readManifest(fromOne.dir).sourceUrl, undefined);
  const again = await add(fileUrl(one));
  assert.equal(again.added[0].path, "one-page 2");
  assert.equal(again.added[0].title, "One 2");

  // shape 2: an entry and no manifest: one is generated
  const two = repoAt("plain-site", { "index.md": "# hi\n", "pic.txt": "x" });
  commit(two);
  const r2 = await add(fileUrl(two));
  assert.deepEqual(r2.added.map((x) => [x.path, x.title, x.format, x.category]), [["plain-site", "plain-site", "md", ""]]);
  assert.deepEqual(Object.keys(readManifest(path.join(dir, "plain-site"))).sort(), ["sourceUrl", "title"]);

  // shape 3: immediate subfolders that are pages, under a category named after the repo.
  // A symlinked page, a nested page, .git and node_modules are not taken.
  const three = repoAt("page-pack", {
    "README.md": "x",
    "Alpha/.noteblock": J({ description: "First" }),
    "Alpha/index.html": "a",
    "Habits/.quire": J({ title: "Habits" }),
    "Habits/index.html": "b",
    "docs/guide.md": "not a page",
    "docs/Nested/.noteblock": "{}",
    "node_modules/Dep/.noteblock": "{}",
  });
  fs.symlinkSync(path.join(three, "Alpha"), path.join(three, "Linked"));
  commit(three);
  const r3 = await add(fileUrl(three));
  assert.deepEqual(r3.added.map((x) => [x.path, x.title, x.category]).sort(), [["page-pack/Alpha", "Alpha", "page-pack"], ["page-pack/Habits", "Habits 2", "page-pack"]]);
  assert.equal(r3.added.find((x) => x.name === "Alpha").description, "First");
  assert.ok(fs.existsSync(path.join(dir, "page-pack", "Habits", ".noteblock")) && !fs.existsSync(path.join(dir, "page-pack", "Habits", ".quire")));
  assert.equal(findTemplate("Habits 2").path, "page-pack/Habits"); // the title stays unique
  // The category folder name is taken by a page: the group gets " 2".
  fs.mkdirSync(path.join(dir, "Clash"));
  fs.writeFileSync(path.join(dir, "Clash", ".noteblock"), "{}");
  const clash = repoAt("Clash", { "P/.noteblock": "{}", "P/index.html": "x" });
  commit(clash);
  assert.equal((await add(fileUrl(clash))).added[0].path, "Clash 2/P");

  // /tree/<ref>/<subdir>, a ref with a slash, a missing ref, a missing folder, a symlinked folder
  const treed = repoAt("treed", { "README.md": "x", "site/sub/.noteblock": J({ title: "Deep" }), "site/sub/index.html": "x" });
  fs.symlinkSync(path.join(treed, "site"), path.join(treed, "alias"));
  fs.symlinkSync(path.dirname(secret), path.join(treed, "out"));
  commit(treed);
  git(treed, "branch", "feat/x");
  assert.equal((await add(fileUrl(treed) + "/tree/main/site/sub")).added[0].title, "Deep");
  const slash = await add(fileUrl(treed) + "/tree/feat/x/site/sub");
  assert.equal(slash.added[0].path, "sub 2");
  await assert.rejects(add(fileUrl(treed) + "/tree/nope"), /No branch or tag called nope/);
  await assert.rejects(add(fileUrl(treed) + "/tree/main/missing"), /No folder called missing/);
  await assert.rejects(add(fileUrl(treed) + "/tree/main/alias/sub"), /No folder called alias\/sub/);
  await assert.rejects(add(fileUrl(treed) + "/tree/main/out"), /No folder called out/);

  // nothing usable, too big, unreachable
  const none = repoAt("empty-ish", { "README.md": "x", "docs/a.md": "x" });
  fs.symlinkSync(path.dirname(secret), path.join(none, "outside"));
  commit(none);
  await assert.rejects(add(fileUrl(none)), /^Error: No pages found in that repo$/);
  await assert.rejects(add(fileUrl(one), { test: { maxFiles: 1 } }), /too big/);
  await assert.rejects(add(fileUrl(one), { test: { maxBytes: 3 } }), /too big/);
  const before = fs.readdirSync(dir).length;
  await assert.rejects(add(fileUrl(path.join(tmp, "no-such-repo"))), /Couldn't get that repo/);
  assert.equal(fs.readdirSync(dir).length, before); // no stage folder or half a template left

  // code: a repo's backend/build never comes along by default
  const coded = repoAt("coded", {
    ".noteblock": J({ title: "Coded", description: "Runs", build: " pnpm build ", source: "index.html", entry: "dist/index.html", backend: { run: { api: "node server.js", web: "python3 -m http.server" } } }),
    "index.html": "x",
    "dist/index.html": "built",
    "backend/server.js": "//",
  });
  commit(coded);
  const COMMANDS = ["pnpm build", "node server.js", "python3 -m http.server"];
  const asked = await add(fileUrl(coded));
  assert.deepEqual(asked, { needsConfirm: { commands: COMMANDS } });
  assert.equal(fs.existsSync(path.join(dir, "coded")), false); // asking adds nothing
  // allowCode alone, or a different list than the one shown, is not consent
  assert.deepEqual(await add(fileUrl(coded), { allowCode: true }), asked);
  assert.deepEqual(await add(fileUrl(coded), { allowCode: true, commands: ["node server.js"] }), asked);
  assert.deepEqual(await add(fileUrl(coded), { allowCode: true, commands: ["a", "b", "c"] }), asked);

  const stripped = await add(fileUrl(coded), { allowCode: false });
  const sm = readManifest(path.join(dir, "coded"));
  for (const k of ["backend", "build", "source"]) assert.equal(sm[k], undefined, k);
  assert.equal(sm.entry, "dist/index.html");
  assert.equal(stripped.added[0].description, "Runs");
  const page = createFromTemplate(vault, "coded", "", "Coded page");
  assert.equal(page.backend, null);
  assert.equal(readManifest(page.dir).build, undefined);
  assert.ok(fs.existsSync(path.join(page.dir, "dist", "index.html"))); // committed output still shows

  const allowed = await add(fileUrl(coded), { allowCode: true, commands: [...COMMANDS].reverse() });
  const am = readManifest(path.join(dir, allowed.added[0].path));
  assert.equal(am.build, "pnpm build");
  assert.deepEqual(am.backend.run, { api: "node server.js", web: "python3 -m http.server" });
  assert.equal(am.sourceUrl, fileUrl(coded));
  const allowedPage = createFromTemplate(vault, allowed.added[0].path, "", "Allowed page");
  assert.equal(allowedPage.backend.run.api, "node server.js");
  assert.equal(readManifest(allowedPage.dir).sourceUrl, undefined);

  // Both spellings of the manifest count: an old .quire can't carry code past the confirm.
  const oldCoded = repoAt("old-coded", { ".quire": J({ backend: { run: "node evil.js" } }), "index.html": "x" });
  commit(oldCoded);
  assert.deepEqual(await add(fileUrl(oldCoded)), { needsConfirm: { commands: ["node evil.js"] } });
  // A subfolder's code asks too, and a .quire left beside a clean .noteblock doesn't survive.
  const twoNames = repoAt("two-names", { ".noteblock": "{}", ".quire": J({ backend: { run: "node evil.js" } }), "index.html": "x" });
  commit(twoNames);
  const tn = await add(fileUrl(twoNames));
  assert.equal(fs.existsSync(path.join(dir, tn.added[0].path, ".quire")), false);
  const packCoded = repoAt("pack-coded", { "A/.noteblock": J({ build: "make" }), "A/index.html": "x", "B/.noteblock": "{}", "B/index.html": "x" });
  commit(packCoded);
  assert.deepEqual(await add(fileUrl(packCoded)), { needsConfirm: { commands: ["make"] } });
  // A symlinked manifest is never read, a broken one doesn't pass code along.
  const linkMan = repoAt("link-manifest", { "index.html": "x" });
  fs.writeFileSync(secret, J({ backend: { run: "node evil.js" }, title: "stolen" }));
  fs.symlinkSync(secret, path.join(linkMan, ".noteblock"));
  commit(linkMan);
  const lm = await add(fileUrl(linkMan));
  assert.equal(lm.added[0].title, "link-manifest");
  assert.equal(fs.lstatSync(path.join(dir, "link-manifest", ".noteblock")).isSymbolicLink(), false);

  console.log("smoke-templates ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
