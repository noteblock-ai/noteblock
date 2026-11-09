#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// The MCP server (stdio), named "quire" (an internal id) with BRAND.name as its title. Thin wrappers over core; see docs/contract.md "MCP".
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import {
  resolveVault,
  vaultName,
  currentUser,
  listTree,
  findPage,
  createPage,
  createFolder,
  readEntry,
  beginEdit,
  detectAgent,
  endEdit,
  abortEdit,
  openStore,
} from "../core/index.mjs";
import { BRAND } from "../core/brand.mjs";

const vaultArg = z.string().optional().describe("Vault directory (default: nearest vault above cwd, else the current vault)");
const pageArg = z.string().describe('Page path like "Kyoto trip/Trip budget" (its folder path in the vault), or the page id');

const vaultOf = (vault) => resolveVault({ vault });

/** Tree without absolute dirs. */
function publicTree(nodes) {
  return nodes.map(({ dir, children, ...n }) => ({ ...n, children: publicTree(children) }));
}

/** A page's own files (relative paths), excluding data/. */
function ownFiles(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === ".DS_Store") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!rel && e.name === "data") continue;
      out.push(...ownFiles(dir, r));
    } else out.push(r);
  }
  return out.sort();
}

/** Resolve `file` inside the page dir; reject absolute paths, `..` and data/. */
function safeFile(dir, file) {
  if (!file || path.isAbsolute(file) || file.includes("\0")) throw new Error(`Bad file path: ${file}`);
  const segs = file.split(/[\\/]+/).filter(Boolean);
  if (!segs.length || segs.some((s) => s === "." || s === "..")) throw new Error(`Bad file path: ${file}`);
  if (segs[0] === "data") throw new Error("data/ holds the page's stored rows; use the page runtime, not write_file");
  const full = path.resolve(dir, ...segs);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Bad file path: ${file}`);
  return full;
}

const ok = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

function tool(server, name, description, shape, fn) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err?.message || String(err) }] };
    }
  });
}

const server = new McpServer({ name: "quire", title: BRAND.name, version: "0.1.0" });

tool(server, "quire_list",
  "List the vault's tree. Nodes are folders (kind \"folder\"), pages (kind \"page\": a folder with a .noteblock manifest; path, title, id, entry, format, lock), or plain files sitting in a folder (kind \"file\"; path). Address pages by path or id.",
  { vault: vaultArg },
  ({ vault }) => {
    const v = vaultOf(vault);
    return { vault: v, name: vaultName(v), pages: publicTree(listTree(v)) };
  });

tool(server, "quire_read",
  "Read a page's entry file (index.html or index.md) and list its other files. Reading needs no lock.",
  { vault: vaultArg, page: pageArg },
  ({ vault, page }) => {
    const v = vaultOf(vault);
    const node = findPage(v, page);
    const entry = readEntry(v, page);
    return {
      path: node.path,
      id: node.id,
      dir: node.dir,
      file: entry.file,
      format: entry.format,
      lock: node.lock,
      content: entry.content,
      files: ownFiles(node.dir).filter((f) => f !== entry.file),
    };
  });

tool(server, "quire_begin_edit",
  "Step 1 of editing: lock the page (the app shows it read-only with a spinner) and get its dir; then edit files, then call quire_end_edit.",
  {
    vault: vaultArg,
    page: pageArg,
    message: z.string().describe("What you are about to change; shown in the app's banner and used as the commit message"),
    by: z.string().optional().describe('Who is editing, shown in the app ("<by> is editing this page"). Default: detected from the environment (Claude, Codex, Cursor, else "An agent")'),
  },
  ({ vault, page, message, by }) => {
    const v = vaultOf(vault);
    const { lock, dir } = beginEdit(v, page, { message, by: by || detectAgent() });
    return { dir, files: ownFiles(dir), lock };
  });

tool(server, "quire_write_file",
  "Step 2 of editing: write a file in a locked page's dir (path relative to the page dir, subdirs created). Any file tool on the begin_edit dir works too.",
  {
    vault: vaultArg,
    page: pageArg,
    file: z.string().describe('Path relative to the page dir, e.g. "index.html" or "js/app.js"'),
    content: z.string().describe("Full file contents"),
  },
  ({ vault, page, file, content }) => {
    const v = vaultOf(vault);
    const node = findPage(v, page);
    if (!node.lock) throw new Error(`Not being edited: ${node.path} (call quire_begin_edit first)`);
    const full = safeFile(node.dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return { written: path.relative(node.dir, full).split(path.sep).join("/"), bytes: Buffer.byteLength(content) };
  });

tool(server, "quire_end_edit",
  "Step 3 of editing: unlock the page and commit everything (message defaults to the begin_edit message); the app reloads it.",
  { vault: vaultArg, page: pageArg, message: z.string().optional().describe("Commit message (default: the lock message)") },
  ({ vault, page, message }) => endEdit(vaultOf(vault), page, message ? { message } : {}));

tool(server, "quire_abort_edit",
  "Cancel an edit: restore the page's files from the begin_edit snapshot and unlock, no commit.",
  { vault: vaultArg, page: pageArg },
  ({ vault, page }) => {
    abortEdit(vaultOf(vault), page);
    return { aborted: true };
  });

tool(server, "quire_new_page",
  "Create a page in a folder (the folder must exist; pages can't hold pages) with a blank index.html or index.md; then begin_edit it to fill it in.",
  {
    vault: vaultArg,
    page: z.string().describe('New page path, e.g. "Kyoto trip/Notes"'),
    format: z.enum(["html", "md"]).optional().describe('Entry format (default "html")'),
  },
  ({ vault, page, format }) => {
    const { dir, children, ...node } = createPage(vaultOf(vault), page, { format: format || "html" });
    return { ...node, dir };
  });

tool(server, "quire_new_folder",
  "Create a plain folder for grouping pages (its parent folder must exist).",
  { vault: vaultArg, folder: z.string().describe('New folder path, e.g. "Kyoto trip"') },
  ({ vault, folder }) => {
    const { children, ...node } = createFolder(vaultOf(vault), folder);
    return node;
  });

tool(server, "quire_data",
  "Read a page's stored rows for the current user (one table, or all tables keyed by name). Read-only.",
  { vault: vaultArg, page: pageArg, table: z.string().optional().describe("Table name (default: all tables)") },
  ({ vault, page, table }) => {
    const v = vaultOf(vault);
    const node = findPage(v, page);
    const user = currentUser();
    const file = path.join(node.dir, "data", `${user}.sqlite`);
    if (!fs.existsSync(file)) return table ? [] : {};
    const store = openStore(node.dir, user);
    if (table) return store.all(table);
    return Object.fromEntries(store.tables().map((t) => [t, store.all(t)]));
  });

await server.connect(new StdioServerTransport());
