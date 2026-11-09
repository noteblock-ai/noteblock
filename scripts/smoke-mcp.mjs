// Smoke test for the MCP server over stdio. Run: node scripts/smoke-mcp.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quire-mcp-")));
process.env.HOME = home; // core's config lives under os.homedir()
const { createVault, saveConfig, gitLog } = await import("../core/index.mjs");

const vault = createVault(path.join(home, "Quire", "Smoke"), { name: "Smoke", seed: false });
saveConfig({ current: vault, vaults: [vault] });

const client = new Client({ name: "quire-smoke", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--disable-warning=ExperimentalWarning", path.join(ROOT, "mcp", "server.mjs")],
  env: { ...process.env, HOME: home },
  cwd: home,
  stderr: "inherit",
});

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ["quire_list", "quire_read", "quire_begin_edit", "quire_write_file", "quire_end_edit",
    "quire_abort_edit", "quire_new_page", "quire_new_folder", "quire_data"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }

  // vault resolved from config.current (no vault arg)
  assert.equal((await call("quire_new_folder", { folder: "Trips" })).kind, "folder");
  assert.equal((await call("quire_new_page", { page: "Trips/Plan" })).path, "Trips/Plan");
  const created = await call("quire_new_page", { page: "Notes", format: "md" });
  assert.equal(created.path, "Notes");
  assert.equal(created.format, "md");

  const list = await call("quire_list", {});
  assert.equal(list.vault, vault);
  assert.deepEqual(list.pages.map((p) => p.path), ["Trips", "Notes"]);
  assert.equal(list.pages[0].dir, undefined);

  // editing without a lock is refused
  assert.match((await call("quire_write_file", { page: "Notes", file: "index.md", content: "x" })).error, /Not being edited/);

  const begun = await call("quire_begin_edit", { page: "Notes", message: "Write notes", vault });
  assert.equal(begun.dir, path.join(vault, "Notes"));
  assert.ok(begun.files.includes("index.md"));
  assert.ok((await call("quire_list", {})).pages[1].lock);

  assert.match((await call("quire_write_file", { page: "Notes", file: "../escape.txt", content: "x" })).error, /Bad file path/);
  assert.match((await call("quire_write_file", { page: "Notes", file: "/tmp/x", content: "x" })).error, /Bad file path/);
  await call("quire_write_file", { page: "Notes", file: "index.md", content: "# Notes\n\nHello from MCP.\n" });
  await call("quire_write_file", { page: "Notes", file: "assets/style.css", content: "body{}\n" });

  const ended = await call("quire_end_edit", { page: "Notes" });
  assert.match(ended.commit, /^[0-9a-f]{7,40}$/);
  assert.equal(gitLog(vault)[0].message, "Write notes");

  const read = await call("quire_read", { page: "Notes" });
  assert.equal(read.file, "index.md");
  assert.equal(read.content, "# Notes\n\nHello from MCP.\n");
  assert.ok(read.files.includes("assets/style.css"));
  assert.ok(!read.files.includes("index.md"));
  assert.equal(read.lock, null);

  // abort restores the snapshot
  await call("quire_begin_edit", { page: "Notes", message: "Scratch" });
  await call("quire_write_file", { page: "Notes", file: "index.md", content: "junk" });
  await call("quire_abort_edit", { page: "Notes" });
  assert.equal((await call("quire_read", { page: "Notes" })).content, "# Notes\n\nHello from MCP.\n");

  assert.deepEqual(await call("quire_data", { page: "Notes" }), {});
  assert.deepEqual(await call("quire_data", { page: "Notes", table: "items" }), []);
  assert.match((await call("quire_read", { page: "Missing" })).error, /No page: Missing/);

  console.log("smoke-mcp: ok");
} finally {
  await client.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
