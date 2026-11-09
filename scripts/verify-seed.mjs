#!/usr/bin/env node
// Checks that the default vault and the bundled templates only run the commands and reach the
// hosts listed below. New installs copy examples/My First Vault in as their vault, so anything
// here runs on a new user's Mac. Change a list only after reading the code it lets through.
//
//   node scripts/verify-seed.mjs     exit 0 when clean, 1 with one line per problem
//
// Plain Node, no dependencies. scripts/release.mjs runs it before every build.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every command a seed page may run: page path (relative to examples/), manifest field, exact
// command. "backend.run" is a string run; "backend.run.<name>" one entry of an object run.
const ALLOWED_COMMANDS = [
  { page: "My First Vault/Apps/Guestbook", field: "backend.run.api", command: "node server.js" },
  { page: "My First Vault/Apps/Blastside", field: "build", command: "pnpm install --prefer-offline --silent && pnpm exec vite build --logLevel warn" },
  { page: "My First Vault/Apps/Focus timer", field: "build", command: "pnpm install --prefer-offline --silent && pnpm exec vite build --logLevel warn" },
  { page: "My First Vault/Apps/Reading list", field: "build", command: "pnpm install --prefer-offline --silent && pnpm exec vite build --logLevel warn" },
];

// Hosts any seed file may name. play.noteblock.ai is the Blastside game server (it connects
// after the person presses Play). www.w3.org appears only as XML namespace strings, never fetched.
const ALLOWED_HOSTS = ["play.noteblock.ai", "www.w3.org"];

// Hosts allowed only inside built bundles (dist/): links in library error messages and package
// metadata (React, Svelte, react-three-fiber, three.js comments). Nothing fetches them.
// 127.0.0.1 is colyseus.js's fallback server address for when there is no window; in a page
// the client is always given play.noteblock.ai.
const DIST_ONLY_HOSTS = ["react.dev", "svelte.dev", "github.com", "opencollective.com", "docs.pmnd.rs", "jcgt.org", "127.0.0.1"];

// Manifest keys that can't run anything. Any other key fails until someone adds it here or
// gives it a check.
const KNOWN_KEYS = ["id", "entry", "title", "description", "renderer", "source", "embed", "origin", "requires", "public", "build", "backend"];

// package.json scripts that pnpm install runs on its own.
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare", "prepublish"];

const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json"]);
const MANIFESTS = [".noteblock", ".quire"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = path.join(root, "examples");
const SEEDS = ["My First Vault", "Templates"];

const problems = [];
const fail = (where, msg) => problems.push(`${where}: ${msg}`);
const rel = (abs) => path.relative(examples, abs).split(path.sep).join("/");
const isPage = (dir) => MANIFESTS.some((m) => isFile(path.join(dir, m)));
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// --- walk ---------------------------------------------------------------------------------
const pages = []; // absolute page dirs
const files = []; // { abs, dist } every file a seed copies, minus node_modules, data and lockfiles

function walk(dir, page, inDist) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === ".DS_Store") continue;
    if (ent.isSymbolicLink()) {
      fail(rel(abs), "symlink in a seed (createVault would copy what it points at)");
      continue;
    }
    if (ent.isDirectory()) {
      if (page && ent.name === "data" && dir === page) continue; // personal data, never seeded
      const childPage = !page && isPage(abs) ? abs : page;
      if (childPage === abs) pages.push(abs);
      walk(abs, childPage, inDist || (page !== null && ent.name === "dist"));
      continue;
    }
    if (LOCKFILES.has(ent.name)) continue;
    files.push({ abs, dist: inDist });
  }
}
for (const s of SEEDS) {
  const dir = path.join(examples, s);
  if (!fs.existsSync(dir)) {
    fail(`examples/${s}`, "missing");
    continue;
  }
  walk(dir, null, false);
}

// --- manifests: commands ------------------------------------------------------------------
const seen = new Set();
for (const page of pages) {
  const where = rel(page);
  const mf = MANIFESTS.map((m) => path.join(page, m)).find(isFile);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(mf, "utf8"));
  } catch (e) {
    fail(where, `unreadable ${path.basename(mf)}: ${e.message}`);
    continue;
  }
  for (const k of Object.keys(m)) if (!KNOWN_KEYS.includes(k)) fail(where, `unknown manifest key "${k}"`);

  const commands = [];
  if (m.build !== undefined) commands.push(["build", m.build]);
  if (m.backend !== undefined) {
    const b = m.backend;
    if (!b || typeof b !== "object") fail(where, "backend is not an object");
    else {
      for (const k of Object.keys(b)) if (k !== "run" && k !== "dir") fail(where, `unknown backend key "${k}"`);
      if (b.dir !== undefined && b.dir !== "backend") fail(where, `backend.dir is "${b.dir}", only "backend" is allowed`);
      if (typeof b.run === "string") commands.push(["backend.run", b.run]);
      else if (b.run && typeof b.run === "object") for (const [n, c] of Object.entries(b.run)) commands.push([`backend.run.${n}`, c]);
      else fail(where, "backend.run is missing or not a string/object");
    }
  }
  for (const [field, command] of commands) {
    const ok = ALLOWED_COMMANDS.find((a) => a.page === where && a.field === field && a.command === command);
    if (ok) seen.add(ok);
    else fail(where, `${field} ${JSON.stringify(command)} is not in ALLOWED_COMMANDS`);
  }
  // A built page ships its output so it shows without running the build.
  if (m.build !== undefined && !isFile(path.join(page, m.entry || "index.html"))) fail(where, `has a build but its entry ${m.entry} is not committed`);

  // pnpm install runs these without asking.
  const pkgFile = path.join(page, "package.json");
  if (isFile(pkgFile)) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    } catch (e) {
      fail(`${where}/package.json`, `unreadable: ${e.message}`);
      pkg = {};
    }
    for (const s of INSTALL_SCRIPTS) if (pkg.scripts?.[s] !== undefined) fail(`${where}/package.json`, `has an install-time "${s}" script`);
    const builds = pkg.pnpm?.onlyBuiltDependencies ?? pkg.pnpm?.allowBuilds;
    if (builds && Object.keys(builds).length) fail(`${where}/package.json`, "lets dependencies run install scripts (pnpm.onlyBuiltDependencies / allowBuilds)");
  }
}
for (const a of ALLOWED_COMMANDS) if (!seen.has(a)) fail(a.page, `ALLOWED_COMMANDS lists ${a.field} ${JSON.stringify(a.command)}, which no page has (remove it)`);

// --- files: hosts -------------------------------------------------------------------------
const URL_RE = /\b(?:https?|wss?):\/\/([^\s"'`<>()\\/?#]*)/gi;
const hostOf = (raw) => raw.replace(/^[^@]*@/, "").replace(/:\d*$/, "").replace(/[.,;:]+$/, "").toLowerCase();
for (const { abs, dist } of files) {
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) continue; // binary (images)
  const text = buf.toString("utf8");
  const bad = new Map();
  for (const match of text.matchAll(URL_RE)) {
    const host = hostOf(match[1]);
    if (!host) continue; // a bare "https://" prefix, not a URL
    if (ALLOWED_HOSTS.includes(host) || (dist && DIST_ONLY_HOSTS.includes(host))) continue;
    if (!bad.has(host)) bad.set(host, text.slice(0, match.index).split("\n").length);
  }
  for (const [host, line] of bad) fail(`${rel(abs)}:${line}`, `URL host ${host} is not in ${dist ? "ALLOWED_HOSTS or DIST_ONLY_HOSTS" : "ALLOWED_HOSTS"}`);
}

// --- report -------------------------------------------------------------------------------
if (problems.length) {
  console.error(`verify-seed: ${problems.length} problem${problems.length === 1 ? "" : "s"} in examples/\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nThe allow-lists are at the top of scripts/verify-seed.mjs.");
  process.exit(1);
}
console.log(`verify-seed: ok (${pages.length} pages, ${files.length} files, ${ALLOWED_COMMANDS.length} allowed commands)`);
