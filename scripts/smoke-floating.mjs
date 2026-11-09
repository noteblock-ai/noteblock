// Floating note page resolution (app/main/floating-page.mjs): default created once, a gone page
// reported as missing (never swapped), "New floating note" de-dupes its name.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVault, createPage, findPage } from "../core/index.mjs";
import { DEFAULT_FLOATING_PAGE, resolveFloatingPage, createFloatingNote } from "../app/main/floating-page.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-floating-"));
const vault = createVault(path.join(tmp, "V"), { name: "V", seed: false });

// Nothing picked: the default note is created, then found.
const first = resolveFloatingPage(vault, null);
assert.equal(first.node.path, DEFAULT_FLOATING_PAGE);
assert.equal(first.created, true);
const again = resolveFloatingPage(vault, null);
assert.equal(again.node.path, DEFAULT_FLOATING_PAGE);
assert.ok(!again.created);

// A picked page resolves; once gone it's missing, not the default.
createPage(vault, "Inbox");
assert.equal(resolveFloatingPage(vault, "Inbox").node.path, "Inbox");
fs.rmSync(path.join(vault, "Inbox"), { recursive: true });
assert.deepEqual(resolveFloatingPage(vault, "Inbox"), { missing: "Inbox" });
fs.rmSync(path.join(vault, DEFAULT_FLOATING_PAGE), { recursive: true });
assert.deepEqual(resolveFloatingPage(vault, DEFAULT_FLOATING_PAGE), { missing: DEFAULT_FLOATING_PAGE });

// New floating note: the plain name when free, else "Floating note 2", 3, …
assert.equal(createFloatingNote(vault).path, DEFAULT_FLOATING_PAGE);
assert.equal(createFloatingNote(vault).path, `${DEFAULT_FLOATING_PAGE} 2`);
assert.equal(createFloatingNote(vault).path, `${DEFAULT_FLOATING_PAGE} 3`);
assert.ok(findPage(vault, `${DEFAULT_FLOATING_PAGE} 3`));

fs.rmSync(tmp, { recursive: true, force: true });

console.log("smoke-floating ok");
