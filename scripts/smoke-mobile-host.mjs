#!/usr/bin/env node
// Runs ios/Generated/host.js under macOS's own JavaScriptCore (the `jsc` shell, no DOM, no
// node) and checks every QuireHost function gives the same answer as the node modules the
// Mac app uses. Skips (exit 0) when jsc isn't there (not macOS). Builds host.js first.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { indexBody, applyRegions, renderMarkdown, htmlToMarkdown, splitFrontmatter, stripEditorAttrs } from "../core/html.mjs";
import { transformEntry, contentType, headInjection } from "../app/main/transform.mjs";

const JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc";
if (!existsSync(JSC)) {
  console.log("smoke-mobile-host: no jsc here, skipped");
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(root, "scripts", "build-mobile-host.mjs"), "--quiet"], { cwd: root, stdio: "inherit" });
const hostJs = join(root, "ios", "Generated", "host.js");

const html = `<!doctype html><html><head><title>T</title></head><body>\n<h1>Hi</h1>\n<p>One <b>two</b></p>\n<div data-app>app</div>\n<ul><li>a</li><li>b</li></ul>\n</body></html>`;
const md = `---\ntags: [a]\n---\n# Note\n\nSome *text* and a [link](../x/).\n\n- [ ] todo\n- [x] done\n\n![[Other page]]\n`;
const regions = [{ replace: [0, 1], before: 2, html: '<h1 data-q-i="0">Hello</h1><p contenteditable="true">New</p>' }];
const bodyHtml = '<h2 data-q-i="3">Title</h2><p>Para with <em>em</em></p><ul><li>x</li></ul><quire-embed src="Child"></quire-embed><table><tr><td>1</td></tr></table>';
const opts = { pagePath: "Kyoto trip/Overview", title: "Overview", baseHref: null, editor: {} };

const cases = {
  indexBody: [[html], indexBody(html)],
  applyRegions: [[html, regions], applyRegions(html, regions)],
  renderMarkdown: [[md, { title: "Note" }], renderMarkdown(md, { title: "Note" })],
  htmlToMarkdown: [[bodyHtml], htmlToMarkdown(bodyHtml)],
  splitFrontmatter: [[md], splitFrontmatter(md)],
  stripEditorAttrs: [['<p data-q-i="1" contenteditable="true">x</p>'], stripEditorAttrs('<p data-q-i="1" contenteditable="true">x</p>')],
  transformEntry: [[md, "md", opts], transformEntry(md, "md", opts)],
  contentType: [["vendor/react.mjs"], contentType("vendor/react.mjs")],
  headInjection: [["Welcome", {}], headInjection("Welcome", {})],
};

const dir = mkdtempSync(join(tmpdir(), "quire-jsc-"));
try {
  const test = join(dir, "test.js");
  writeFileSync(
    test,
    // The jsc shell has globals an app's JSContext doesn't; drop them so the test sees what
    // the app sees.
      `for (var k of ["atob", "btoa", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]) delete globalThis[k];\n` +
      `load(${JSON.stringify(hostJs)});\n` +
      `var cases = ${JSON.stringify(Object.fromEntries(Object.entries(cases).map(([k, [args]]) => [k, args])))};\n` +
      `var out = {};\nfor (var k in cases) { try { out[k] = QuireHost[k].apply(null, cases[k]); } catch (e) { out[k] = {error: String(e && e.stack || e)}; } }\n` +
      `print(JSON.stringify(out));\n`,
  );
  const got = JSON.parse(execFileSync(JSC, [test], { encoding: "utf8" }));
  for (const [k, [, want]] of Object.entries(cases)) assert.deepEqual(got[k], want, `QuireHost.${k} differs under JavaScriptCore`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`smoke-mobile-host ok: ${Object.keys(cases).length} functions match under JavaScriptCore`);
