// Moving or renaming keeps links working (core/relink.mjs): inbound, outbound, embeds, markdown,
// absolute URLs; everything but the link byte-identical; locks and build output left alone; speed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noteblock-relink-"));
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");
const { createVault, movePath, rewriteLinksForMove, relinkText, commitPaths, writeManifest, readManifest, pathDir, beginEdit } = await import("../core/index.mjs");

let n = 0;
/** A fresh vault holding {page path: entry file text}; text after a "#md" line makes a markdown page. */
function vaultWith(pages) {
  const vault = path.join(tmp, `v${++n}`);
  createVault(vault, { seed: false });
  for (const [p, text] of Object.entries(pages)) {
    const dir = path.join(vault, ...p.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    const md = text.startsWith("#md\n");
    writeManifest(dir, { id: `id${n}x${Buffer.from(p).toString("hex").slice(0, 24)}`, entry: md ? "index.md" : "index.html" });
    fs.writeFileSync(path.join(dir, md ? "index.md" : "index.html"), md ? text.slice(4) : text);
  }
  return vault;
}
const read = (vault, p) => {
  const dir = path.join(vault, ...p.split("/"));
  return fs.readFileSync(path.join(dir, fs.existsSync(path.join(dir, "index.md")) ? "index.md" : "index.html"), "utf8");
};
async function move(vault, from, to) {
  movePath(vault, from, to);
  return rewriteLinksForMove(vault, from, to);
}
const a = (href) => `<!doctype html><html><head><title>t</title></head><body>\n  <p  class=x>hi <A data-x='1' HREF="${href}"   title="a href=b">go</A>\n</body></html>\n`;

// Rename a page: inbound repointed, encoded, the rest of the file byte-identical.
{
  const v = vaultWith({ Home: a("../Kyoto%20trip/"), "Kyoto trip": "<p>x</p>" });
  const r = await move(v, "Kyoto trip", "Tokyo trip");
  assert.equal(read(v, "Home"), a("../Tokyo%20trip/"));
  assert.deepEqual(r, { relinked: ["Home/index.html"], skipped: [] });
}

// Unencoded matches, and comes out encoded; a space in the new name.
{
  const v = vaultWith({ Home: a("../Kyoto trip/"), "Kyoto trip": "<p>x</p>" });
  await move(v, "Kyoto trip", "Tokyo two");
  assert.equal(read(v, "Home"), a("../Tokyo%20two/"));
}

// Move a page deeper, then shallower: its way out is recomputed, its own assets stay.
{
  const own = '<link rel="stylesheet" href="style.css"><img src="img/a.png"><a href="sub/file.pdf">f</a>';
  const v = vaultWith({ A: `${own}<a href="../B/">b</a><a href="../B/">again</a>`, B: "<p>b</p>", "Deep/er/x": "x" });
  await move(v, "A", "Deep/er/A");
  assert.equal(read(v, "Deep/er/A"), `${own}<a href="../../../B/">b</a><a href="../../../B/">again</a>`);
  await move(v, "Deep/er/A", "A");
  assert.equal(read(v, "A"), `${own}<a href="../B/">b</a><a href="../B/">again</a>`);
}

// Rename a folder of pages that link to each other: siblings' links don't change; outside ones do.
{
  const one = '<a href="../Two/">2</a><quire-embed src="Two"></quire-embed><a href="../../Other/">o</a>';
  const v = vaultWith({ "Trip/One": one, "Trip/Two": '<a href="../One/">1</a>', Other: '<a href="../Trip/One/">in</a><a href="../Trip/">folder</a><a href="../Trip/One/a.png">file</a>' });
  const r = await move(v, "Trip", "Journey");
  assert.equal(read(v, "Journey/One"), one);
  assert.equal(read(v, "Journey/Two"), '<a href="../One/">1</a>');
  assert.equal(read(v, "Other"), '<a href="../Journey/One/">in</a><a href="../Journey/">folder</a><a href="../Journey/One/a.png">file</a>');
  assert.deepEqual(r.relinked, ["Other/index.html"]);
}

// A folder moved deeper: nothing inside changes among siblings, the way out does.
{
  const v = vaultWith({ "Trip/One": '<a href="../Two/">2</a><a href="../../Other/">o</a>', "Trip/Two": "x", Other: "x", "Box/x": "x" });
  await move(v, "Trip", "Box/Trip");
  assert.equal(read(v, "Box/Trip/One"), '<a href="../Two/">2</a><a href="../../../Other/">o</a>');
}

// Inbound from another folder; a page's link to itself follows it.
{
  const v = vaultWith({ "Notes/Day": a("../../Trips/Kyoto/Overview/"), "Trips/Kyoto/Overview": '<a href="../Overview/">me</a>', "Elsewhere/x": "x" });
  await move(v, "Trips/Kyoto/Overview", "Elsewhere/Sum");
  assert.equal(read(v, "Notes/Day"), a("../../Elsewhere/Sum/"));
  assert.equal(read(v, "Elsewhere/Sum"), '<a href="./">me</a>');
}

// Embeds go by the folder holding the page, plain text, leading slash = vault root.
{
  const v = vaultWith({
    "Garden/Home": '<quire-embed src="Beds" height="90"></quire-embed><quire-embed src="/Garden/Beds"></quire-embed><quire-embed src="../Top"></quire-embed>',
    "Garden/Beds": "x",
    Top: '<quire-embed src="Garden/Beds"></quire-embed>',
    "Yard/deep/x": "x",
  });
  await move(v, "Garden/Beds", "Yard/Beds and more");
  assert.equal(
    read(v, "Garden/Home"),
    '<quire-embed src="../Yard/Beds and more" height="90"></quire-embed><quire-embed src="/Yard/Beds and more"></quire-embed><quire-embed src="../Top"></quire-embed>',
  );
  assert.equal(read(v, "Top"), '<quire-embed src="Yard/Beds and more"></quire-embed>');
  // The embedding page moves: a sibling src needs a way out, with no ".." in it to start with.
  await move(v, "Garden/Home", "Yard/deep/Home");
  assert.match(read(v, "Yard/deep/Home"), /src="\.\.\/Beds and more" height="90"/);
  assert.match(read(v, "Yard/deep/Home"), /src="\.\.\/\.\.\/Top"/);
}

// Markdown: links, images, titles, angle form, references, embeds; code and frontmatter left alone.
{
  const md = (t) => `---
see: [x](../Foo/)
---
# Title

[x](${t}/) and ![pic](${t}/a.png "A title") and [q](${t}/?a=1&b=2#top) and [y](<${t}/>) \\[no\\](../Foo/)
\`[code](../Foo/)\` and \`\` [two](../Foo/) \`\`

\`\`\`md
[fenced](../Foo/)
![[/Foo]]
\`\`\`

~~~~
[tilde](../Foo/)
\`\`\`
[still](../Foo/)
~~~~

    [indented](../Foo/)

- item

    [in a list](${t}/)

<!-- [comment](../Foo/) -->
<a href="${t}/">raw</a>

[ref]: ${t}/
`;
  const v = vaultWith({ Foo: "#md\n# Foo\n", Notes: `#md\n${md("../Foo")}` });
  const before = read(v, "Notes");
  await move(v, "Foo", "Bar");
  const after = read(v, "Notes");
  assert.equal(after, md("../Bar"));
  assert.notEqual(after, before);
  assert.match(after, /^\[fenced\]\(\.\.\/Foo\/\)$/m);
  assert.match(after, /^see: \[x\]\(\.\.\/Foo\/\)$/m);
}

// Markdown embeds, an encoded markdown link and a parenthesis in the new name; CRLF stays.
{
  const v = vaultWith({ "Box/Foo": "#md\nx\n", Notes: "#md\n![[/Box/Foo]]\r\n\r\n![[Box/Foo]]\r\n\r\ninline ![[/Box/Foo]] stays\r\n\r\n[a](../Box/Foo/)\r\n" });
  await move(v, "Box/Foo", "Box/Foo (2)");
  assert.equal(read(v, "Notes"), "![[/Box/Foo (2)]]\r\n\r\n![[Box/Foo (2)]]\r\n\r\ninline ![[/Box/Foo]] stays\r\n\r\n[a](../Box/Foo%20%282%29/)\r\n");
}

// Hash and query kept as written; absolute forms keep their form; externals untouched.
{
  const same = [
    "https://example.com/Foo/",
    "//example.com/Foo/",
    "mailto:Foo@example.com",
    "#Foo",
    "?Foo",
    "quire://runtime/Foo/x.js",
    "Foo/", // inside this page, not the vault's Foo
    "{{Foo}}",
    "",
  ].map((h) => `<a href="${h}">x</a>`).join("");
  const v = vaultWith({
    Foo: "x",
    Ext: same,
    Keep: `<a href="../Foo/?a=1&amp;b=2#sec&amp;x">q</a><a href='/Foo/#h'>r</a><a href=../Foo/>u</a><a href="quire://vault/Foo/sub/">v</a><a href="quire://p-abc123/Foo/">w</a><a href="../Foo">noslash</a>`,
  });
  const r = await move(v, "Foo", "Bar");
  assert.equal(read(v, "Ext"), same);
  assert.equal(read(v, "Keep"), `<a href="../Bar/?a=1&amp;b=2#sec&amp;x">q</a><a href='/Bar/#h'>r</a><a href=../Bar/>u</a><a href="quire://vault/Bar/sub/">v</a><a href="quire://p-abc123/Bar/">w</a><a href="../Bar">noslash</a>`);
  assert.deepEqual(r.relinked, ["Keep/index.html"]);
}

// Text that only looks like a link: code, comments, scripts, styles, another attribute's value.
{
  const page = `<pre><code>&lt;a href="../Foo/"&gt;</code></pre><!-- <a href="../Foo/">c</a> --><script>const s = '<a href="../Foo/">';</script><style>a[href="../Foo/"]{}</style><textarea><a href="../Foo/"></textarea><div title='<a href="../Foo/">' data-href="../Foo/">x</div><img alt=' src="../Foo/"' src="ok.png">`;
  const v = vaultWith({ Foo: "x", Code: page });
  const r = await move(v, "Foo", "Bar");
  assert.equal(read(v, "Code"), page);
  assert.deepEqual(r.relinked, []);
}

// Spaces and unicode, in all their spellings; quotes in an attribute of the same quote.
{
  const nfd = "Café 日本".normalize("NFD");
  const v = vaultWith({
    "Café 日本": "x",
    Home: `<a href="../Caf%C3%A9%20%E6%97%A5%E6%9C%AC/">a</a><a href="../Café 日本/">b</a><a href="../${nfd}/">c</a><a href="../caf%c3%a9%20%e6%97%a5%e6%9c%ac/">other case</a><a href="../Caf%c3%a9%20%e6%97%a5%e6%9c%ac/">d</a>`,
  });
  await move(v, "Café 日本", "Bob's & 北京");
  const out = "../Bob's%20%26%20%E5%8C%97%E4%BA%AC/";
  assert.equal(read(v, "Home"), `<a href="${out}">a</a><a href="${out}">b</a><a href="${out}">c</a><a href="../caf%c3%a9%20%e6%97%a5%e6%9c%ac/">other case</a><a href="${out}">d</a>`);
  // A single-quoted value, and a name with no plain run to look for.
  const w = vaultWith({ "日本": "x", Home: "<a href='../%E6%97%A5%E6%9C%AC/'>a</a>" });
  await move(w, "日本", "Bob's");
  assert.equal(read(w, "Home"), "<a href='../Bob&#39;s/'>a</a>");
  assert.equal(relinkText('<quire-embed src="/A &amp; B"></quire-embed>', "html", { oldPage: "P", newPage: "P", from: "A & B", to: "C & D" }), '<quire-embed src="/C &amp; D"></quire-embed>');
}

// A locked page is skipped and named; only if it needed the change. Build output never touched.
{
  const v = vaultWith({ Foo: "x", Locked: '<a href="../Foo/">l</a>', LockedToo: "nothing here", Built: '<a href="../Foo/">src</a>', Free: '<a href="../Foo/">f</a>' });
  beginEdit(v, "Locked", { by: "agent" });
  beginEdit(v, "LockedToo", { by: "agent" });
  const built = pathDir(v, "Built");
  writeManifest(built, { ...readManifest(built), build: "pnpm build", entry: "dist/index.html", source: "index.html" });
  fs.mkdirSync(path.join(built, "dist"));
  fs.mkdirSync(path.join(built, "node_modules/x"), { recursive: true });
  fs.mkdirSync(path.join(built, "data"));
  for (const f of ["dist/index.html", "node_modules/x/index.html", "data/index.html"]) fs.writeFileSync(path.join(built, f), '<a href="../Foo/">out</a>');
  const r = await move(v, "Foo", "Bar");
  assert.equal(read(v, "Locked"), '<a href="../Foo/">l</a>');
  assert.deepEqual(r.skipped, ["Locked"]);
  assert.deepEqual(r.relinked.sort(), ["Built/index.html", "Free/index.html"]);
  assert.equal(fs.readFileSync(path.join(built, "index.html"), "utf8"), '<a href="../Bar/">src</a>');
  for (const f of ["dist/index.html", "node_modules/x/index.html", "data/index.html"]) assert.equal(fs.readFileSync(path.join(built, f), "utf8"), '<a href="../Foo/">out</a>');
}

// Bytes a string round trip would change are left alone, not mangled.
{
  const v = vaultWith({ Foo: "x", Latin: "x" });
  const bad = Buffer.concat([Buffer.from('<a href="../Foo/">'), Buffer.from([0xff, 0xfe]), Buffer.from("</a>")]);
  fs.writeFileSync(path.join(pathDir(v, "Latin"), "index.html"), bad);
  await move(v, "Foo", "Bar");
  assert.ok(fs.readFileSync(path.join(pathDir(v, "Latin"), "index.html")).equals(bad));
}

// The list commits with the move: one commit, nothing left over.
{
  const v = vaultWith({ Foo: "x", Other: '<a href="../Foo/">f</a>' });
  const git = (...args) => execFileSync("git", ["-C", v, ...args], { encoding: "utf8" });
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "start");
  const m = await move(v, "Foo", "Bar");
  commitPaths(v, "Move", ["Foo", "Bar", ...m.relinked]);
  assert.equal(git("status", "--porcelain").trim(), "");
  assert.match(git("show", "--stat", "--format=", "HEAD"), /Other\/index\.html/);
}

// 2,000 pages, a tenth of them linking in, inside the budget and without starving the event loop.
{
  const v = vaultWith({ Target: "x" });
  const filler = "<p>Some ordinary words in a paragraph.</p>\n".repeat(40);
  for (let i = 0; i < 2000; i++) {
    const dir = path.join(v, `F${i % 40}`, `P${i}`);
    fs.mkdirSync(dir, { recursive: true });
    writeManifest(dir, { id: `perf${i}`, entry: "index.html" });
    fs.writeFileSync(path.join(dir, "index.html"), i % 10 ? filler : `${filler}<a href="../../Target/">t</a>`);
  }
  movePath(v, "Target", "Goal");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const t0 = performance.now();
  const r = await rewriteLinksForMove(v, "Target", "Goal");
  const ms = performance.now() - t0;
  clearInterval(timer);
  assert.equal(r.relinked.length, 200);
  assert.ok(ms < 2000, `2,000 pages took ${Math.round(ms)} ms`);
  assert.ok(ticks > 2, "the event loop never ran");
  console.log(`relink: 2,000 pages in ${Math.round(ms)} ms`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("smoke-relink ok");
