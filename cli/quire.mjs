#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// The `noteblock` command (`quire` is the same file under its old name). See the "CLI (`noteblock`)" section of docs/contract.md.
import fs from "node:fs";
import path from "node:path";
import {
  loadConfig,
  saveConfig,
  resolveVault,
  createVault,
  listTree,
  findPage,
  createPage,
  createFolder,
  readEntry,
  beginEdit,
  detectAgent,
  endEdit,
  abortEdit,
  listLocks,
  gitLog,
  gitStatus,
  openStore,
  closeAllStores,
  currentUser,
  runBuildSync,
  configDir,
  importArtifact,
  listTemplates,
  createFromTemplate,
  templatesDir,
} from "../core/index.mjs";
import { BRAND } from "../core/brand.mjs";

const USAGE = `noteblock — the ${BRAND.name} command line. Pages are folders; agents lock, edit files, then commit

  noteblock vault                            print the current vault path
  noteblock vault create <dir> [--no-seed]   create (and make current)
  noteblock vault use <dir>                  make current
  noteblock ls [--json]                      folders and pages, 🔒 when locked
  noteblock path <page>                      absolute page folder, the thing to edit
  noteblock cat <page>                       print the page's entry (index.html / index.md)
  noteblock new <page> [--md]                create a page in an existing folder, print its dir
  noteblock new <page> --template <name>     the same, copied from a template (see noteblock templates)
  noteblock templates                        list the templates in ~/.noteblock/templates
  noteblock mkdir <folder>                   create a folder for grouping pages
  noteblock edit <page> -m "<what>" [--by NAME] [--force]
                                         lock + snapshot, print its dir; the app goes read-only
  noteblock done <page> [-m "<msg>"]         unlock + commit everything (msg defaults to the lock's)
  noteblock abort <page>                     put the snapshot back, unlock, no commit
  noteblock build <page>                     run the page's .noteblock "build" command (done runs it too)
  noteblock logs <page> [name] [-n 80]       recent output of the page's backend processes (the app runs them)
  noteblock data <page> [table]              print the page's stored rows as JSON
  noteblock import-artifact <file|dir> [--name N] [--url U] [--folder F] [--skip-existing]
                                         a Claude artifact (.html/.md, or a folder with index.html)
                                         → a page in Artifacts/; the same --url again updates it
                                         (or, with --skip-existing, leaves it alone)
  noteblock status                           locks + uncommitted changes
  noteblock log [-n 10]                      recent commits

Global: --vault <dir>   --json   --help
<page> is a page path ("Kyoto trip/Trip budget") or a page id.`;

// flags that take a value → canonical name
const VALUE_FLAGS = { "--vault": "vault", "-m": "message", "--message": "message", "--by": "by", "-n": "n", "--name": "name", "--url": "url", "--folder": "folder", "--template": "template", "-t": "template" };
const BOOL_FLAGS = {
  "--json": "json",
  "--no-seed": "noSeed",
  "--md": "md",
  "--force": "force",
  "--skip-existing": "skipExisting",
  "-f": "force",
  "--help": "help",
  "-h": "help",
};

function fail(msg) {
  const err = new Error(msg);
  err.usage = true;
  throw err;
}

function parse(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    let inline;
    if (a.startsWith("--") && a.includes("=")) {
      inline = a.slice(a.indexOf("=") + 1);
      a = a.slice(0, a.indexOf("="));
    }
    if (VALUE_FLAGS[a]) {
      const v = inline ?? argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      opts[VALUE_FLAGS[a]] = v;
    } else if (BOOL_FLAGS[a]) {
      opts[BOOL_FLAGS[a]] = true;
    } else if (a.length > 1 && a.startsWith("-") && !/^-\d/.test(a)) {
      fail(`unknown option ${a} (see noteblock --help)`);
    } else {
      pos.push(a);
    }
  }
  return { pos, opts };
}

const tty = process.stdout.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[22m` : s);
const out = (s = "") => process.stdout.write(s + "\n");
const json = (v) => out(JSON.stringify(v, null, 2));

function need(v, what) {
  if (!v) fail(`missing ${what} (see noteblock --help)`);
  return v;
}

function vault(opts) {
  return resolveVault({ vault: opts.vault, cwd: process.cwd() });
}

function lockMarker(lock) {
  return `🔒 editing (${lock.by || "an agent"})${lock.message ? `: ${lock.message}` : ""}`;
}

const commands = {
  vault(pos, opts) {
    const [sub, dir] = pos;
    if (!sub) {
      const v = vault(opts);
      return opts.json ? json({ vault: v }) : out(v);
    }
    if (sub === "create" || sub === "use") {
      need(dir, "<dir>");
      const abs = sub === "create" ? createVault(dir, { seed: !opts.noSeed }) : resolveVault({ vault: dir, cwd: process.cwd() });
      const cfg = loadConfig();
      cfg.current = abs;
      cfg.vaults = [...cfg.vaults.filter((v) => v !== abs), abs];
      saveConfig(cfg);
      return opts.json ? json({ vault: abs }) : out(abs);
    }
    fail(`unknown command: vault ${sub}`);
  },

  ls(pos, opts) {
    const tree = listTree(vault(opts));
    if (opts.json) return json(tree);
    if (!tree.length) return out(dim("(no pages)"));
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        const name = n.path.split("/").pop();
        let line =
          n.kind === "folder" ? `${"  ".repeat(depth)}${name}/` : n.kind === "file" ? `${"  ".repeat(depth)}${name}  ${dim("file")}` : `${"  ".repeat(depth)}${name}  ${dim(n.format)}`;
        if (n.lock) line += `  ${lockMarker(n.lock)}`;
        if (n.searchExcludedBy === n.path) line += `  ${dim("excluded from search")}`;
        out(line);
        walk(n.children, depth + 1);
      }
    };
    walk(tree, 0);
  },

  path(pos, opts) {
    const node = findPage(vault(opts), need(pos[0], "<page>"));
    return opts.json ? json({ path: node.path, dir: node.dir }) : out(node.dir);
  },

  cat(pos, opts) {
    const entry = readEntry(vault(opts), need(pos[0], "<page>"));
    if (opts.json) return json(entry);
    process.stdout.write(entry.content.endsWith("\n") || !entry.content ? entry.content : entry.content + "\n");
  },

  new(pos, opts) {
    if (opts.template) {
      const norm = need(pos[0], "<page>").split("/").filter(Boolean);
      const v = vault(opts);
      const name = norm.pop();
      const node = createFromTemplate(v, opts.template, norm.join("/"), name);
      return opts.json ? json({ path: node.path, dir: node.dir, format: node.format }) : out(node.dir);
    }
    const node = createPage(vault(opts), need(pos[0], "<page>"), { format: opts.md ? "md" : "html" });
    return opts.json ? json({ path: node.path, dir: node.dir, format: node.format }) : out(node.dir);
  },

  templates(pos, opts) {
    const list = listTemplates();
    if (opts.json) return json({ dir: templatesDir(), templates: list });
    out(dim(templatesDir()));
    if (!list.length) return out(dim("(no templates)"));
    for (const t of list) out(`${t.path}  ${dim(t.format + (t.description ? " · " + t.description : ""))}`);
  },

  mkdir(pos, opts) {
    const node = createFolder(vault(opts), need(pos[0], "<folder>"));
    return opts.json ? json({ path: node.path, dir: node.dir }) : out(node.dir);
  },

  edit(pos, opts) {
    const page = need(pos[0], "<page>");
    const v = vault(opts);
    const { lock, dir } = beginEdit(v, page, {
      by: opts.by || detectAgent(),
      message: opts.message || "",
      force: !!opts.force,
    });
    if (opts.json) return json({ dir, lock });
    out(dir);
    out(dim(`Locked for ${lock.by}; the app shows the pre-edit version until you finish.`));
    out(dim(`Edit the files in that folder, then run: noteblock done "${lock.path}"`));
    out(dim(`(or: noteblock abort "${lock.path}" to put it back)`));
  },

  done(pos, opts) {
    const { commit, build } = endEdit(vault(opts), need(pos[0], "<page>"), { message: opts.message });
    if (opts.json) return json({ commit, build });
    if (build && !build.ok) out(build.output.trim() + "\n" + dim("Build failed; the commit has the unbuilt change. Fix it and run: noteblock build"));
    else if (build) out(dim(`Built in ${(build.ms / 1000).toFixed(1)} s`));
    return out(commit || "nothing to commit");
  },

  logs(pos, opts) {
    const node = findPage(vault(opts), need(pos[0], "<page>"));
    if (!node.backend || !Object.keys(node.backend.run).length) fail(`${node.path} has no "backend.run" in its .noteblock`);
    const names = pos[1] ? [pos[1]] : Object.keys(node.backend.run);
    const n = Number(opts.n) || 80;
    for (const name of names) {
      if (!node.backend.run[name]) fail(`No backend process "${name}" (have: ${Object.keys(node.backend.run).join(", ")})`);
      let text = "";
      try {
        text = fs.readFileSync(path.join(configDir(), "logs", `${node.id}-${name}.log`), "utf8");
      } catch {}
      if (names.length > 1) out(dim(`── ${name}: ${node.backend.run[name]}`));
      out(text ? text.trimEnd().split("\n").slice(-n).join("\n") : dim("(no output yet; the app starts it when the page is opened)"));
    }
  },

  build(pos, opts) {
    const node = findPage(vault(opts), need(pos[0], "<page>"));
    if (!node.build) fail(`${node.path} has no "build" in its .noteblock`);
    const r = runBuildSync(node.dir);
    if (opts.json) return json(r);
    if (!r.ok) fail(r.output.trim() || `Build failed (exit ${r.code})`);
    out(r.output.trim());
    out(dim(`Built ${node.path} in ${(r.ms / 1000).toFixed(1)} s`));
  },

  abort(pos, opts) {
    const v = vault(opts);
    const node = findPage(v, need(pos[0], "<page>"));
    abortEdit(v, node.id || node.path);
    return opts.json ? json({ aborted: node.path }) : out(`Restored ${node.path}`);
  },

  data(pos, opts) {
    const node = findPage(vault(opts), need(pos[0], "<page>"));
    const table = pos[1];
    const file = path.join(node.dir, "data", `${currentUser()}.sqlite`);
    if (!fs.existsSync(file)) return json(table ? [] : {});
    const store = openStore(node.dir, currentUser());
    if (table) return json(store.all(table));
    const all = {};
    for (const t of store.tables()) all[t] = store.all(t);
    return json(all);
  },

  "import-artifact"(pos, opts) {
    const r = importArtifact(vault(opts), {
      source: need(pos[0], "<file|dir>"),
      name: opts.name,
      url: opts.url,
      folder: opts.folder ?? "Artifacts",
      skipExisting: !!opts.skipExisting,
    });
    if (opts.json) return json(r);
    out(r.dir);
    out(dim(`${r.skipped ? "Skipped (already imported)" : r.updated ? "Updated" : "Imported"} ${r.path}${r.commit ? ` (${r.commit.slice(0, 7)})` : ""}`));
  },

  status(pos, opts) {
    const v = vault(opts);
    const locks = listLocks(v);
    const changes = gitStatus(v);
    if (opts.json) return json({ vault: v, locks, changes });
    out(dim(v));
    if (!locks.length) out("No pages being edited");
    for (const l of locks) out(`${l.path}  ${lockMarker(l)}  ${dim(l.startedAt)}`);
    if (!changes.length) out("Nothing uncommitted");
    else {
      out("Uncommitted:");
      for (const c of changes) out(`  ${c}`);
    }
  },

  log(pos, opts) {
    const n = opts.n === undefined ? 10 : Number(opts.n);
    if (!Number.isInteger(n) || n < 1) fail(`-n must be a positive number`);
    const commits = gitLog(vault(opts), n);
    if (opts.json) return json(commits);
    for (const c of commits) out(`${c.sha.slice(0, 7)}  ${dim(c.date.slice(0, 16).replace("T", " "))}  ${c.message}  ${dim(c.author)}`);
  },
};

function main(argv) {
  const { pos, opts } = parse(argv);
  const [cmd, ...rest] = pos;
  if (opts.help || !cmd || cmd === "help") {
    out(USAGE);
    return;
  }
  const fn = commands[cmd];
  if (!fn) fail(`unknown command: ${cmd} (see noteblock --help)`);
  fn(rest, opts);
}

try {
  main(process.argv.slice(2));
  closeAllStores();
} catch (err) {
  try {
    closeAllStores();
  } catch {}
  process.stderr.write(`noteblock: ${String(err?.message || err).split("\n")[0]}\n`);
  process.exitCode = 1;
}
