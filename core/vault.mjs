// Vault config, resolution and creation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitInit, commitAll, commitPaths } from "./git.mjs";
import { checkName, isPageDir, writeManifest } from "./pages.mjs";
import { MANIFEST, OLD_MANIFEST, META_DIR, OLD_META_DIR, isMetaDirName, isVaultDir, metaPath, newMetaPath } from "./names.mjs";
import { listLocks } from "./lock.mjs";
import { closeAllStores } from "./store.mjs";
import { BRAND } from "./brand.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_DIR = path.join(REPO_ROOT, "examples", "My First Vault");
// .env files hold page backends' secrets: never committed, so never synced to a remote.
// node_modules/ and .venv/ are a page's installed dependencies: rebuilt on each Mac, never synced.
// Locks and snapshots are ignored under both metadata names (.noteblock/, and .quire/ for a
// vault an older install still writes to).
const GITIGNORE = "data/\n.noteblock/snapshots/\n.noteblock/locks/\n.quire/snapshots/\n.quire/locks/\n.DS_Store\nnode_modules/\n.venv/\n.env\n.env.*\n!.env.example\n";

/** `.quire/x` (or `/.quire/x`) → `.noteblock/x`; null for a line that doesn't name the old dir. */
function renamedIgnoreLine(line) {
  const m = /^(!?\/?)\.quire(\/.*)?$/.exec(line);
  return m ? `${m[1]}${META_DIR}${m[2] || ""}` : null;
}

/**
 * Add any missing GITIGNORE lines to an existing vault (older vaults predate node_modules/),
 * plus a `.noteblock/…` twin for every line of the vault's own that names `.quire/…`.
 */
export function ensureGitignore(vault) {
  const file = path.join(vault, ".gitignore");
  let have = "";
  try {
    have = fs.readFileSync(file, "utf8");
  } catch {}
  const lines = new Set(have.split("\n").map((l) => l.trim()));
  const want = [...GITIGNORE.split("\n"), ...[...lines].map(renamedIgnoreLine)];
  const missing = [...new Set(want.filter((l) => l && !lines.has(l)))];
  if (!missing.length) return false;
  fs.writeFileSync(file, have + (have && !have.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  return true;
}

/**
 * Rename an old config dir to its new name, leaving a symlink old → new so an older app or CLI
 * still finds it. Only when nothing is at `newDir` yet and `oldDir` is a real directory (not
 * already the symlink). Returns true when it moved.
 */
export function migrateConfigDirName(oldDir, newDir) {
  try {
    try {
      fs.lstatSync(newDir);
      return false; // something is already there
    } catch {}
    if (!fs.lstatSync(oldDir).isDirectory()) return false;
    fs.renameSync(oldDir, newDir);
  } catch {
    return false;
  }
  try {
    fs.symlinkSync(newDir, oldDir, process.platform === "win32" ? "junction" : "dir");
  } catch {}
  return true;
}

let configChecked = false;

/**
 * ~/.noteblock, or NOTEBLOCK_CONFIG_DIR (QUIRE_CONFIG_DIR still honoured; the dev app keeps its
 * own so it never touches the real one). The first call without an override moves an older
 * install's ~/.quire to ~/.noteblock (leaving ~/.quire as a symlink to it).
 */
export function configDir() {
  const override = process.env.NOTEBLOCK_CONFIG_DIR || process.env.QUIRE_CONFIG_DIR;
  if (override) return override;
  const dir = path.join(os.homedir(), ".noteblock");
  if (!configChecked) {
    configChecked = true;
    migrateConfigDirName(path.join(os.homedir(), ".quire"), dir);
  }
  return dir;
}

function configFile() {
  return path.join(configDir(), "config.json");
}

/** @returns {{current: string|null, vaults: string[]}} */
export function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    return {
      ...cfg,
      current: typeof cfg.current === "string" ? cfg.current : null,
      vaults: Array.isArray(cfg.vaults) ? cfg.vaults : [],
    };
  } catch {
    return { current: null, vaults: [] };
  }
}

export function saveConfig(cfg) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

function isVault(dir) {
  return isVaultDir(dir);
}

/*
 * Vault trust (docs/contract.md "Trust", app/main/trust.mjs). Kept per machine in
 * <configDir>/trust.json, never inside the vault: a flag in the vault could be written by
 * whoever sent it. Keyed by the vault's real path.
 */
function trustFile() {
  return path.join(configDir(), "trust.json");
}

/** The vault's key in trust.json: its real path (a symlinked or relative spelling is the same vault). */
export function trustKey(vault) {
  const abs = path.resolve(String(vault || ""));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** @returns {{version: number, migrated: string|null, vaults: Record<string, {state: "trusted"|"restricted", since: string, how?: string, approved?: Record<string, string[]>, declined?: Record<string, string[]>}>}} */
export function readTrustStore() {
  try {
    const t = JSON.parse(fs.readFileSync(trustFile(), "utf8"));
    return { version: 1, migrated: typeof t.migrated === "string" ? t.migrated : null, vaults: t.vaults && typeof t.vaults === "object" ? t.vaults : {} };
  } catch {
    return { version: 1, migrated: null, vaults: {} };
  }
}

export function writeTrustStore(store) {
  const file = trustFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write then rename: a half-written trust.json would read as "nothing trusted".
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Mark a vault trusted on this machine (`how`: "created", "migrated", "chosen"). Keeps an
 * existing entry's approvals. Commands get their baseline the first time the app opens it.
 */
export function markVaultTrusted(vault, how = "chosen") {
  const store = readTrustStore();
  const key = trustKey(vault);
  const cur = store.vaults[key] || {};
  store.vaults[key] = { ...cur, state: "trusted", since: new Date().toISOString(), how };
  writeTrustStore(store);
}

export const VAULT_VERSION = 2;

function readMeta(vault) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(vault, "vault.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Write vault.json, always under the new metadata dir. */
function writeMeta(vault, meta) {
  const file = newMetaPath(vault, "vault.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + "\n");
}

function freeName(dir, name) {
  let n = name;
  for (let i = 2; fs.existsSync(path.join(dir, n)); i++) n = `${name} ${i}`;
  return n;
}

/** Turn one old `X.app` dir (already renamed to `from`) into a page at `to`. */
function appToPage(from, to) {
  let app = {};
  try {
    app = JSON.parse(fs.readFileSync(path.join(from, "app.json"), "utf8"));
  } catch {}
  fs.renameSync(from, to);
  fs.rmSync(path.join(to, "app.json"), { force: true });
  const entry = fs.existsSync(path.join(to, "index.html")) ? "index.html" : fs.existsSync(path.join(to, "index.md")) ? "index.md" : "index.html";
  const m = { ...(app.id ? { id: app.id } : {}), entry, ...(app.title ? { title: app.title } : {}) };
  writeManifest(to, m);
}

function migrateDir(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || !e.name.endsWith(".app")) continue;
    const name = e.name.slice(0, -4);
    if (!name) continue;
    const src = path.join(dir, e.name);
    const kids = fs.readdirSync(src, { withFileTypes: true }).filter((k) => k.isDirectory() && k.name.endsWith(".app"));
    if (!kids.length) {
      appToPage(src, path.join(dir, freeName(dir, name)));
      continue;
    }
    // A page with child pages becomes a folder; its own content becomes a page of the same name inside it.
    const folder = path.join(dir, freeName(dir, name));
    const tmp = path.join(dir, `.migrating-${name}`);
    fs.renameSync(src, tmp);
    fs.mkdirSync(folder);
    for (const k of kids) fs.renameSync(path.join(tmp, k.name), path.join(folder, k.name));
    const hasEntry = ["index.html", "index.md"].some((f) => fs.existsSync(path.join(tmp, f)));
    if (hasEntry) appToPage(tmp, path.join(folder, freeName(folder, name)));
    else fs.rmSync(tmp, { recursive: true, force: true });
    migrateDir(folder);
  }
}

/**
 * v1 vaults kept every page in a `Name.app/` dir with an app.json and nested child pages.
 * v2: a page is any folder with a manifest (.noteblock, once .quire); folders are plain folders. Runs once,
 * commits the move, and waits while any agent lock is held. Returns true when it migrated.
 */
export function migrateVault(vault) {
  const meta = readMeta(vault);
  if ((meta.version || 1) >= VAULT_VERSION) return false;
  if (listLocks(vault).length) return false;
  migrateDir(vault);
  const { order, ...rest } = meta;
  writeMeta(vault, { ...rest, version: VAULT_VERSION });
  if (fs.existsSync(path.join(vault, ".git"))) commitAll(vault, "Move pages to plain folders");
  return true;
}

/**
 * `--vault <dir>` → nearest ancestor of cwd holding .noteblock/vault.json (or .quire/vault.json)
 * → config.current. Renames the vault's Quire-era files first (migrateVaultNames).
 * @returns {string} absolute vault path
 */
export function resolveVault({ vault, cwd = process.cwd() } = {}) {
  const open = (dir) => {
    try {
      migrateVaultNames(dir);
    } catch {} // readers still accept the old names
    migrateVault(dir);
    return dir;
  };
  if (vault) {
    const abs = path.resolve(cwd, vault);
    if (!isVault(abs)) throw new Error(`No ${BRAND.name} vault found at ${abs}`);
    return open(abs);
  }
  let dir = path.resolve(cwd);
  while (true) {
    if (isVault(dir)) return open(dir);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const { current } = loadConfig();
  if (current && isVault(current)) return open(current);
  throw new Error(`No ${BRAND.name} vault found (pass --vault, cd into one, or run \`quire vault create <dir>\`)`);
}

/**
 * Create a vault at dir. Seeds from examples/My First Vault when seed is true (skipped if the
 * examples folder is missing). Does not touch the config; callers decide whether it becomes current.
 * @returns {string} absolute vault path
 */
export function createVault(dir, { name, seed = true } = {}) {
  const abs = path.resolve(dir);
  if (isVault(abs)) throw new Error(`Already a ${BRAND.name} vault: ${abs}`);
  // Only a vault made from nothing is trusted here. A folder that already holds files (Open
  // Vault on someone's download) may hold pages with commands: the app asks about it instead.
  let fresh = true;
  try {
    fresh = fs.readdirSync(abs).filter((n) => n !== ".DS_Store").length === 0;
  } catch {}
  fs.mkdirSync(abs, { recursive: true });

  if (seed && fs.existsSync(SEED_DIR)) {
    for (const entry of fs.readdirSync(SEED_DIR)) {
      if (entry === ".git" || entry === ".DS_Store") continue;
      fs.cpSync(path.join(SEED_DIR, entry), path.join(abs, entry), {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          if (base === ".DS_Store" || base === ".git" || base === "node_modules") return false;
          // never seed personal data, locks or snapshots
          if (base === "data" && isPageDir(path.dirname(src))) return false;
          const rel = path.relative(SEED_DIR, src).split(path.sep);
          if (isMetaDirName(rel[0]) && (rel[1] === "locks" || rel[1] === "snapshots")) return false;
          return true;
        },
      });
    }
  }

  fs.writeFileSync(path.join(abs, ".gitignore"), GITIGNORE);
  // A seed (or a folder) still carrying Quire-era names gets the new ones before the first commit.
  migrateVaultNames(abs, { commit: false });
  const meta = readMeta(abs);
  writeMeta(abs, { ...meta, name: name || meta.name || path.basename(abs), version: VAULT_VERSION });

  if (!fs.existsSync(path.join(abs, ".git"))) gitInit(abs);
  commitAll(abs, "Create vault");
  if (fresh) {
    try {
      markVaultTrusted(abs, "created");
    } catch {}
  }
  return abs;
}

export function vaultName(vault) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(vault, "vault.json"), "utf8"));
    if (meta.name) return String(meta.name);
  } catch {}
  return path.basename(vault);
}

export function currentUser() {
  let name = "";
  try {
    name = os.userInfo().username;
  } catch {}
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "user";
}

/** Set the vault's display name (vault.json `name`). */
export function setVaultName(vault, name) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("Vault name can't be empty");
  const meta = readMeta(vault);
  writeMeta(vault, { ...meta, name: clean });
  commitAll(vault, "Rename vault");
}

/**
 * Move a vault folder to `to` (which must not exist) and point the config at the new place.
 * Refused while an agent holds a lock, since it is editing files under the old path.
 * @returns {string} the new absolute path
 */
export function moveVault(from, to) {
  const src = path.resolve(from);
  const dest = path.resolve(to);
  if (src === dest) return src;
  if (!isVault(src)) throw new Error(`Not a ${BRAND.name} vault: ${src}`);
  if (fs.existsSync(dest)) throw new Error(`Something is already at ${dest}`);
  if (dest.startsWith(src + path.sep)) throw new Error("Can't move a vault inside itself");
  if (listLocks(src).length) throw new Error("Claude is editing a page in this vault; try again when it's done");
  closeAllStores();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
  const cfg = loadConfig();
  saveConfig({
    ...cfg,
    current: cfg.current && path.resolve(cfg.current) === src ? dest : cfg.current,
    vaults: [...new Set(cfg.vaults.map((v) => (path.resolve(v) === src ? dest : v)))],
  });
  return dest;
}

/**
 * Rename a vault the way Obsidian does: the name and the folder change together. When a
 * folder of that name already sits next to it, only the name changes.
 * @returns {string} the vault's path afterwards
 */
export function renameVault(vault, name) {
  const clean = String(name || "").trim();
  if (/[/\\:]/.test(clean) || clean.startsWith(".")) throw new Error("Vault names can't contain / \\ : or start with a dot");
  checkName(clean); // also a folder name: the same rules as pages (pages.mjs)
  setVaultName(vault, clean);
  const dest = path.join(path.dirname(vault), clean);
  if (path.basename(vault) === clean || fs.existsSync(dest)) return vault;
  return moveVault(vault, dest);
}

/**
 * Move everything in `from` into `to` that `to` doesn't already have (recursing into dirs both
 * have; on a clash the entry in `to` wins), then remove `from`.
 */
function mergeDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dest = path.join(to, e.name);
    let there = null;
    try {
      there = fs.lstatSync(dest);
    } catch {}
    if (!there) fs.renameSync(src, dest);
    else if (e.isDirectory() && there.isDirectory()) mergeDir(src, dest);
  }
  fs.rmSync(from, { recursive: true, force: true });
}

/**
 * Rename every page manifest `.quire` → `.noteblock` under `root` (keeping `.noteblock` and
 * deleting `.quire` when a page has both). Walks plain folders only: pages are leaves, and
 * dot-dirs, node_modules, data and .git are skipped. Returns the root-relative paths it touched
 * ("/"-separated, both the old and the new name).
 */
export function migrateManifestNames(root) {
  const touched = [];
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    const isFile = (n) => entries.some((e) => e.name === n && e.isFile());
    if (rel && isFile(OLD_MANIFEST)) {
      const from = path.join(dir, OLD_MANIFEST);
      if (names.has(MANIFEST)) fs.rmSync(from, { force: true });
      else fs.renameSync(from, path.join(dir, MANIFEST));
      touched.push(`${rel}/${OLD_MANIFEST}`, `${rel}/${MANIFEST}`);
      return; // a page: its own folders are its files, never pages
    }
    if (rel && isFile(MANIFEST)) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name === "data") continue;
      walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(root, "");
  return touched;
}

/**
 * Rename a vault's Quire-era files to the Noteblock names, then commit just those paths
 * ("Rename Quire files to Noteblock"):
 * - <vault>/.quire/ → <vault>/.noteblock/ (when both exist, entries the new one lacks move over
 *   and the old dir is removed);
 * - every page's .quire manifest → .noteblock (when a page has both, .quire is deleted);
 * - a `.noteblock/…` line in .gitignore for each line naming `.quire/…` (ensureGitignore).
 * Idempotent: nothing to rename = no change and no commit. `commit: false` skips the commit
 * (createVault commits everything itself). Returns {changed, commit}.
 */
export function migrateVaultNames(vault, { commit = true } = {}) {
  const paths = [];
  const oldMeta = path.join(vault, OLD_META_DIR);
  const newMeta = path.join(vault, META_DIR);
  let oldIsDir = false;
  try {
    oldIsDir = fs.lstatSync(oldMeta).isDirectory();
  } catch {}
  if (oldIsDir) {
    let newExists = false;
    try {
      newExists = fs.lstatSync(newMeta).isDirectory();
    } catch {}
    if (newExists) mergeDir(oldMeta, newMeta);
    else fs.renameSync(oldMeta, newMeta);
    paths.push(OLD_META_DIR, META_DIR);
  }
  paths.push(...migrateManifestNames(vault));
  if (fs.existsSync(path.join(vault, ".gitignore")) && ensureGitignore(vault)) paths.push(".gitignore");
  if (!paths.length) return { changed: false, commit: null };
  let sha = null;
  if (commit && fs.existsSync(path.join(vault, ".git"))) {
    // .gitignore is already rewritten on disk, so locks/snapshots under .noteblock/ stay out.
    sha = commitPaths(vault, "Rename Quire files to Noteblock", paths);
  }
  return { changed: true, commit: sha };
}
