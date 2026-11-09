// Smoke test for the Obsidian import. Run: node scripts/smoke-obsidian.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVault } from "../core/vault.mjs";
import { listTree, findPage, readManifest } from "../core/pages.mjs";
import { gitLog } from "../core/git.mjs";
import { scanObsidian, importObsidian } from "../core/obsidian.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-obsidian-"));
const src = path.join(tmp, "Notes");
const put = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
  fs.writeFileSync(path.join(src, rel), body);
};
try {
  put(".obsidian/app.json", "{}");
  put("Home.md", [
    "---", "tags: [start]", "---",
    "See [[Trips/Kyoto|the Kyoto note]] and [[Packing]].",
    "", "| Link |", "|---|", "| [[Packing\\|list]] |",
    "", "![[photo.png|300]]", "", "![[Packing]]",
    "", "> [!tip] Remember", "> ==Bring== cash ^abc123",
    "", "%% hidden %%", "```", "[[Not a link]]", "```",
    "", "[[Missing note]]",
  ].join("\n"));
  put("Trips/Kyoto.md", "# Kyoto\n\nBack [home](../Home.md).\n");
  put("Trips/Packing.md", "- [ ] Passport\n");
  put("Trips.md", "Folder note\n");
  put("assets/photo.png", "png");
  put("assets/unused.pdf", "pdf");
  put("Board.canvas", "{}");

  assert.deepEqual(scanObsidian(src), { source: src, name: "Notes", notes: 4, files: 3, obsidian: true });

  const vault = createVault(path.join(tmp, "Vault"), { name: "Vault", seed: false });
  const r = importObsidian(vault, { source: src, dest: "Imported/Obsidian", format: "md" });
  assert.equal(r.pages, 4);
  assert.equal(r.attachments, 1);
  assert.deepEqual(r.unresolved, ["Home → Missing note"]);
  assert.equal(r.files, 2);
  const paths = [...(function* w(ns) { for (const n of ns) { yield n.kind + ":" + n.path; yield* w(n.children); } })(listTree(vault))];
  assert.deepEqual(paths, [
    "folder:Imported", "folder:Imported/Obsidian", "folder:Imported/Obsidian/assets", "file:Imported/Obsidian/assets/unused.pdf",
    "folder:Imported/Obsidian/Trips",
    "page:Imported/Obsidian/Trips/Kyoto", "page:Imported/Obsidian/Trips/Packing", "page:Imported/Obsidian/Trips/Trips",
    "file:Imported/Obsidian/Board.canvas", "page:Imported/Obsidian/Home",
  ]);

  const home = fs.readFileSync(path.join(findPage(vault, "Imported/Obsidian/Home").dir, "index.md"), "utf8");
  assert.ok(home.startsWith("---\ntags: [start]\n---\n# Home\n"), "frontmatter kept, title added");
  assert.ok(home.includes("[the Kyoto note](../../../Imported/Obsidian/Trips/Kyoto/)"));
  assert.ok(home.includes("| [list](../../../Imported/Obsidian/Trips/Packing/) |"));
  assert.ok(home.includes('<img src="photo.png" width="300" alt="">'));
  assert.ok(home.includes("![[/Imported/Obsidian/Trips/Packing]]"));
  assert.ok(home.includes("> **Remember**\\\n> <mark>Bring</mark> cash\n"));
  assert.ok(!home.includes("hidden"));
  assert.ok(home.includes("```\n[[Not a link]]\n```"));
  assert.ok(home.includes("Missing note"));
  assert.ok(fs.existsSync(path.join(findPage(vault, "Imported/Obsidian/Home").dir, "photo.png")));
  const kyoto = fs.readFileSync(path.join(findPage(vault, "Imported/Obsidian/Trips/Kyoto").dir, "index.md"), "utf8");
  assert.ok(kyoto.includes("[home](../../../../Imported/Obsidian/Home/)"));
  assert.equal(gitLog(vault)[0].message, "Import Notes from Obsidian");

  // As HTML pages, next to the first import: names don't collide with what's there.
  const h = importObsidian(vault, { source: src, dest: "Imported", format: "html" });
  assert.equal(h.first.startsWith("Imported/"), true);
  const page = findPage(vault, "Imported/Home");
  assert.equal(readManifest(page.dir).entry, "index.html");
  assert.equal(readManifest(page.dir).frontmatter, "tags: [start]");
  const html = fs.readFileSync(path.join(page.dir, "index.html"), "utf8");
  assert.ok(html.includes("<body><h1>Home</h1>"));
  assert.ok(html.includes('<quire-embed src="/Imported/Trips/Packing"></quire-embed>'));
  assert.ok(html.includes("<mark>Bring</mark>"));
  assert.throws(() => importObsidian(vault, { source: src, dest: "Imported/Home", format: "md" }), /inside a page/);

  console.log("smoke-obsidian: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
