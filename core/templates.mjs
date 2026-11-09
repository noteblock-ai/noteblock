// Page templates: page folders kept outside any vault, in <configDir>/templates/. A template
// is a dir with a `.noteblock` manifest (optional `title`, `description`; an older `.quire`
// is still read) plus its files; plain subfolders group them. New from template copies one into the vault with a fresh id.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, migrateManifestNames } from "./vault.mjs";
import { isManifestName, MANIFESTS } from "./names.mjs";
import { checkName, isPageDir, readManifest, writeManifest, newPageId, normPath, pathDir, findPage, entryFile, parseBackend, portableName } from "./pages.mjs";
import { buildInfo } from "./build.mjs";
import { gitCommand } from "./git.mjs";

const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "Templates");
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
// Template-only fields, and per-page state that must not travel with a copy.
const PAGE_ONLY = ["id", "public", "origin", "sourceUrl"];
const TEMPLATE_ONLY = ["title", "description"];

const migrated = new Set();

/** <configDir>/templates. The first call per dir renames Quire-era `.quire` manifests there. */
export function templatesDir() {
  const dir = path.join(configDir(), "templates");
  if (!migrated.has(dir)) {
    migrated.add(dir);
    try {
      if (fs.existsSync(dir)) migrateManifestNames(dir);
    } catch {} // readers still accept .quire
  }
  return dir;
}

/**
 * Should `rel` (page-relative, "/"-separated) be copied? Skips data/, node_modules, dotfiles
 * other than the top-level manifest (.noteblock, or an older .quire), and build output.
 */
function keep(rel, outDir) {
  const segs = rel.split("/");
  if (segs.some((s) => s === "node_modules" || (s.startsWith(".") && !(segs.length === 1 && isManifestName(s))))) return false;
  if (segs[0] === "data") return false;
  if (outDir && segs[0] === outDir) return false;
  return true;
}

/** Copy a page folder's own files (see keep) from src to dest, which must not exist yet. */
function copyPage(src, dest) {
  const outDir = buildInfo(src)?.outDir || null;
  fs.cpSync(src, dest, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (p) => p === src || keep(path.relative(src, p).split(path.sep).join("/"), outDir),
  });
}

function countFiles(dir, rel = "", outDir = buildInfo(dir)?.outDir || null) {
  let n = 0;
  for (const e of fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (!keep(r, outDir)) continue;
    if (e.isDirectory()) n += countFiles(dir, r, outDir);
    else if (e.isFile()) n++;
  }
  return n;
}

function freeName(dir, name) {
  let n = name;
  for (let i = 2; fs.existsSync(path.join(dir, n)); i++) n = `${name} ${i}`;
  return n;
}

function cleanName(name) {
  const n = String(name || "").trim().replace(/[/\\:]/g, "-");
  if (!n || n.startsWith(".")) throw new Error("Names can't be empty or start with a dot");
  checkName(n); // the rest of what Windows refuses (pages.mjs)
  return n;
}

/** Template paths under root ("Notes/Daily note"), walking plain folders as categories. */
function walkTemplates(root, rel = "", out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const r = rel ? rel + "/" + e.name : e.name;
    if (isPageDir(path.join(root, r))) out.push(r);
    else walkTemplates(root, r, out);
  }
  return out;
}

/**
 * Copy the starter templates into the templates folder. Only when the folder doesn't exist,
 * or with `restore`, each starter that's missing. Never overwrites. Returns what it added.
 */
export function seedTemplates({ restore = false } = {}) {
  const dir = templatesDir();
  if (fs.existsSync(dir) && !restore) return [];
  fs.mkdirSync(dir, { recursive: true });
  const added = [];
  for (const rel of walkTemplates(SEED_DIR)) {
    const dest = path.join(dir, ...rel.split("/"));
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyPage(path.join(SEED_DIR, ...rel.split("/")), dest);
    added.push(rel);
  }
  return added;
}

function templateInfo(root, rel) {
  const dir = path.join(root, ...rel.split("/"));
  const m = readManifest(dir) || {};
  const name = rel.split("/").pop();
  const entry = entryFile(dir, m);
  return {
    path: rel,
    name,
    title: typeof m.title === "string" && m.title.trim() ? m.title.trim() : name,
    description: typeof m.description === "string" ? m.description.trim() : "",
    sourceUrl: typeof m.sourceUrl === "string" ? m.sourceUrl : "",
    category: rel.split("/").slice(0, -1).join("/"),
    format: /\.md$/i.test(entry) ? "md" : "html",
    files: countFiles(dir),
    dir,
  };
}

/** Every template, by category then title. Seeds the starters the first time. */
export function listTemplates() {
  seedTemplates();
  const root = templatesDir();
  return walkTemplates(root)
    .map((rel) => templateInfo(root, rel))
    .sort((a, b) => collator.compare(a.category, b.category) || collator.compare(a.title, b.title));
}

/** ref = template path ("Notes/Daily note"), or its folder name or title when that's unique. */
export function findTemplate(ref) {
  const all = listTemplates();
  const want = String(ref || "").trim().replace(/^\/+|\/+$/g, "");
  const exact = all.find((t) => t.path === want);
  if (exact) return exact;
  const lc = want.toLowerCase();
  const hits = all.filter((t) => t.name.toLowerCase() === lc || t.title.toLowerCase() === lc);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`More than one template is called ${want}: ${hits.map((t) => t.path).join(", ")}`);
  throw new Error(`No template: ${want}`);
}

/**
 * New page from a template, in vault folder folderRel ("" = top), named `name` (default: the
 * template's title), de-duped with " 2", " 3"… Fresh id; the template's title/description
 * stay behind. Doesn't commit. Returns the page node.
 */
export function createFromTemplate(vault, templateRel, folderRel = "", name) {
  const t = findTemplate(templateRel);
  const folder = normPath(folderRel);
  const parent = folder ? pathDir(vault, folder) : vault;
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error(`No folder: ${folder}`);
  if (folder && isPageDir(parent)) throw new Error(`${folder} is a page; pages can't hold other pages or folders`);
  const base = freeName(parent, cleanName(name || t.title));
  const dest = path.join(parent, base);
  copyPage(t.dir, dest);
  const m = { ...(readManifest(dest) || {}) };
  for (const k of [...PAGE_ONLY, ...TEMPLATE_ONLY]) delete m[k];
  writeManifest(dest, { id: newPageId(), ...m });
  return findPage(vault, folder ? folder + "/" + base : base);
}

/** Copy a vault page into the templates folder as `name` (default: the page title). */
export function saveAsTemplate(vault, pageRef, name) {
  const node = findPage(vault, pageRef);
  const root = templatesDir();
  seedTemplates();
  const base = freeName(root, cleanName(name || node.title));
  const dest = path.join(root, base);
  copyPage(node.dir, dest);
  const m = { ...(readManifest(dest) || {}) };
  for (const k of PAGE_ONLY) delete m[k];
  writeManifest(dest, { ...m, title: m.title || base });
  return templateInfo(root, base);
}

/** Absolute folder of a template, for reveal / trash. Throws when it isn't one. */
export function templatePath(rel) {
  const segs = String(rel || "").split("/").filter(Boolean);
  if (!segs.length || segs.some((s) => s === "." || s === ".." || s.startsWith("."))) throw new Error(`Bad template: ${rel}`);
  const dir = path.join(templatesDir(), ...segs);
  if (!isPageDir(dir)) throw new Error(`No template: ${rel}`);
  return dir;
}

/* ------------------------------------------------------------ add from a git URL */

const CLONE_TIMEOUT_MS = 60000;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const BAD_URL = "Use a GitHub address like https://github.com/owner/repo or owner/repo, or an https address ending in .git";

const stripGit = (name) => name.replace(/\.git$/i, "");
const okRepoPart = (s) => /^[\w.-]+$/.test(s) && !s.startsWith("-") && !/^\.+$/.test(stripGit(s));

function decodeSegments(pathname) {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new Error(BAD_URL);
  }
}

function checkTree(tree) {
  const bad = tree.some((s) => s === "." || s === ".." || /[/\\\0]/.test(s)) || tree[0].startsWith("-");
  if (bad) throw new Error(BAD_URL);
  return tree;
}

/**
 * Where a "from GitHub" address points. Accepts https://github.com/owner/repo, the same with
 * /tree/<ref>/<subdir>, owner/repo, and any https://….git. file:// only with `allowFile`, which
 * only the smoke test passes. Pure; nothing here touches the network.
 * `ref` and `subdir` split `tree` at its first segment; a ref holding a "/" is resolved at fetch.
 * @returns {{cloneUrl: string, sourceUrl: string, repo: string, ref: string|null, subdir: string, tree: string[]|null}}
 */
export function parseTemplateUrl(input, { allowFile = false } = {}) {
  const s = String(input ?? "").trim().replace(/\/+$/, "");
  const result = (cloneUrl, sourceUrl, repo, tree = null) => ({
    cloneUrl,
    sourceUrl,
    repo,
    tree,
    ref: tree ? tree[0] : null,
    subdir: tree ? tree.slice(1).join("/") : "",
  });
  const github = (owner, repo, tree, sourceUrl) => {
    if (!okRepoPart(owner) || !okRepoPart(repo)) throw new Error(BAD_URL);
    const name = stripGit(repo);
    return result(`https://github.com/${owner}/${name}.git`, sourceUrl || `https://github.com/${owner}/${name}`, name, tree);
  };

  const short = s.match(/^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/);
  if (short) return github(short[1], short[2]);

  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(BAD_URL);
  }
  if (allowFile && u.protocol === "file:") {
    const m = u.pathname.match(/^(.*?)\/tree\/(.+)$/);
    const repoPath = m ? m[1] : u.pathname;
    return result("file://" + repoPath, "file://" + repoPath, stripGit(decodeSegments(repoPath).pop() || "repo"), m ? checkTree(decodeSegments(m[2])) : null);
  }
  if (u.protocol !== "https:") throw new Error(BAD_URL);
  if (u.username || u.password) throw new Error("Take the username and password out of the address");

  const segs = decodeSegments(u.pathname);
  if (u.hostname === "github.com" || u.hostname === "www.github.com") {
    const [owner, repo, kind, ...rest] = segs;
    if (!owner || !repo) throw new Error(BAD_URL);
    if (kind === undefined) return github(owner, repo);
    if (kind !== "tree" || !rest.length) throw new Error(BAD_URL);
    return github(owner, repo, checkTree(rest), `https://github.com${u.pathname}`);
  }
  if (!/\.git$/i.test(u.pathname) || segs.length < 1) throw new Error(BAD_URL);
  const clean = u.origin + u.pathname;
  return result(clean, clean, stripGit(segs[segs.length - 1]));
}

/** Runs the app's git for a repo we don't trust: no prompts, and https only (no ext::, no ssh). */
function fetchGit(args, { cwd, deadline, allowFile }) {
  const { bin, env } = gitCommand();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: Math.max(1000, deadline - Date.now()),
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          ...(env || {}),
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          GIT_ALLOW_PROTOCOL: allowFile ? "file" : "https",
          GIT_LFS_SKIP_SMUDGE: "1",
        },
      },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || "") })) : resolve(stdout)),
    );
  });
}

/** Splits /tree/<...> into ref and subdir, asking the remote when the ref could hold a "/". */
async function resolveTree(parsed, opts) {
  const { tree } = parsed;
  if (tree && tree.length > 1) {
    try {
      const out = await fetchGit(["ls-remote", "--heads", "--tags", "--", parsed.cloneUrl], opts);
      const refs = new Set(out.split("\n").map((l) => l.split("\t")[1]?.replace(/^refs\/(heads|tags)\//, "")));
      for (let n = tree.length; n > 1; n--) {
        const ref = tree.slice(0, n).join("/");
        if (refs.has(ref)) return { ref, subdir: tree.slice(n).join("/") };
      }
    } catch {} // the clone below says what's wrong
  }
  return { ref: parsed.ref, subdir: parsed.subdir };
}

async function cloneRepo(parsed, dest, cwd, allowFile) {
  const opts = { cwd, deadline: Date.now() + CLONE_TIMEOUT_MS, allowFile };
  const { ref, subdir } = await resolveTree(parsed, opts);
  try {
    await fetchGit(["clone", "--depth", "1", "--quiet", ...(ref ? ["--branch", ref] : []), "--", parsed.cloneUrl, dest], opts);
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("Couldn't run git");
    if (err.killed || err.signal) throw new Error("That repo took more than 60 s to download");
    if (/Remote branch .* not found/.test(err.stderr)) throw new Error(`No branch or tag called ${ref} in that repo`);
    throw new Error("Couldn't get that repo. Check the address. A private repo only works if git can already sign in to it");
  }
  return subdir;
}

const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/** Follows `subdir` down from root, refusing a symlink at any step. */
function repoFolder(root, subdir) {
  let dir = root;
  for (const seg of subdir ? subdir.split("/") : []) {
    dir = path.join(dir, seg);
    if (!lstat(dir)?.isDirectory()) throw new Error(`No folder called ${subdir} in that repo`);
  }
  return dir;
}

/** The manifest in a repo folder, untrusted: a real file only, else null. {} when it doesn't parse. */
function repoManifest(dir) {
  for (const name of MANIFESTS) {
    const file = path.join(dir, name);
    const st = lstat(file);
    if (!st?.isFile()) continue;
    if (st.size > MAX_MANIFEST_BYTES) return {};
    try {
      const m = JSON.parse(fs.readFileSync(file, "utf8"));
      return m && typeof m === "object" && !Array.isArray(m) ? m : {};
    } catch {
      return {};
    }
  }
  return null;
}

const hasEntryFile = (dir) => ["index.html", "index.md"].some((f) => lstat(path.join(dir, f))?.isFile());

/**
 * The pages a repo offers, per the rule in docs/contract.md (Templates): the folder itself, else
 * its immediate subfolders that have a manifest, grouped under `category`.
 */
function repoPages(dir, name, category) {
  const own = repoManifest(dir);
  if (own || hasEntryFile(dir)) return [{ dir, name, category: "", manifest: own || {} }];
  const pages = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name.toLowerCase() === "node_modules") continue; // a symlink isn't isDirectory()
    const manifest = repoManifest(path.join(dir, e.name));
    if (manifest) pages.push({ dir: path.join(dir, e.name), name: e.name, category, manifest });
  }
  return pages;
}

/** Every file to copy from a repo page, as page-relative paths. Never follows a symlink. */
function pageFiles(dir, tally, limits, rel = "", out = []) {
  for (const e of fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name.toLowerCase() === "node_modules" || (!rel && e.name === "data")) continue;
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) pageFiles(dir, tally, limits, r, out);
    else if (e.isFile()) {
      tally.files++;
      tally.bytes += fs.lstatSync(path.join(dir, r)).size;
      if (tally.files > limits.files || tally.bytes > limits.bytes) throw new Error("That repo is too big to add as a template (the limit is 50 MB and 2,000 files)");
      out.push(r);
    }
  }
  return out;
}

/** The shell commands a manifest would run: its build, then each backend process. */
function codeCommands(m) {
  const build = typeof m.build === "string" ? m.build.trim() : "";
  return [...(build ? [build] : []), ...Object.values(parseBackend(m.backend)?.run || {})];
}

const insidePage = (p) => typeof p === "string" && !p.includes("..") && !p.includes("\\") && !p.startsWith("/");

/** The manifest a template from a repo gets. Code stays only with `allowCode`; no other way in. */
function importedManifest(raw, allowCode, sourceUrl) {
  const m = { ...raw };
  const backend = parseBackend(raw.backend);
  const build = typeof raw.build === "string" ? raw.build.trim() : "";
  for (const k of ["id", "backend", "build", "public", "origin"]) delete m[k];
  if (allowCode) {
    if (build) m.build = build;
    if (backend && Object.keys(backend.run).length) m.backend = backend;
  }
  if (!m.build || !insidePage(m.source)) delete m.source;
  if (!insidePage(m.entry)) delete m.entry;
  for (const k of ["title", "description"]) if (typeof m[k] !== "string") delete m[k];
  return { ...m, sourceUrl };
}

function freeTitle(title, taken) {
  let t = title;
  for (let i = 2; taken.has(t.toLowerCase()); i++) t = `${title} ${i}`;
  taken.add(t.toLowerCase());
  return t;
}

/** Copies every page aside, then moves them in, so a failure leaves no half-made template. */
async function installPages(pages, sourceUrl, allowCode) {
  const root = templatesDir();
  const taken = new Set(listTemplates().flatMap((t) => [t.title.toLowerCase(), t.name.toLowerCase()])); // seeds first
  fs.mkdirSync(root, { recursive: true });
  const stage = await fs.promises.mkdtemp(path.join(root, ".adding-"));
  const moved = [];
  try {
    for (const [i, page] of pages.entries()) {
      for (const rel of page.files) {
        const to = path.join(stage, String(i), ...rel.split("/"));
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        await fs.promises.copyFile(path.join(page.dir, ...rel.split("/")), to);
      }
      await fs.promises.mkdir(path.join(stage, String(i)), { recursive: true });
    }
    const rels = [];
    let category = pages[0].category ? portableName(pages[0].category, "GitHub") : "";
    if (category) {
      // Merges into a folder of that name; a page or file in the way gets " 2".
      const base = category;
      for (let i = 2; fs.existsSync(path.join(root, category)) && (!fs.statSync(path.join(root, category)).isDirectory() || isPageDir(path.join(root, category))); i++) category = `${base} ${i}`;
      fs.mkdirSync(path.join(root, category), { recursive: true });
    }
    for (const [i, page] of pages.entries()) {
      const parent = category ? path.join(root, category) : root;
      const m = importedManifest(page.manifest, allowCode, sourceUrl);
      const name = freeName(parent, portableName(page.name, "Template"));
      const title = freeTitle(portableName(m.title || name, name).slice(0, 100), taken);
      writeManifest(path.join(stage, String(i)), { ...m, title });
      fs.renameSync(path.join(stage, String(i)), path.join(parent, name));
      moved.push(path.join(parent, name));
      rels.push(category ? category + "/" + name : name);
    }
    return rels.map((rel) => templateInfo(root, rel));
  } catch (err) {
    for (const dir of moved) fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Add a template from a git address (see parseTemplateUrl). A repo's `backend` and `build` run
 * shell commands as the person, so they're dropped unless the person says otherwise:
 * - no allowCode: when the repo has any, nothing is added; returns {needsConfirm: {commands}}.
 * - allowCode false: added without them.
 * - allowCode true + `commands` (what the person was shown): kept. Only when the repo still
 *   holds exactly those; each call fetches again, so a repo that changed asks again.
 * `test` is for scripts/smoke-templates.mjs ({allowFile, maxFiles, maxBytes}); IPC never passes it.
 * @returns {Promise<{added: object[]} | {needsConfirm: {commands: string[]}}>}
 */
export async function addTemplateFromUrl(url, { allowCode, commands: approved, test = null } = {}) {
  const allowFile = !!test?.allowFile;
  const parsed = parseTemplateUrl(url, { allowFile });
  const limits = { files: test?.maxFiles || MAX_FILES, bytes: test?.maxBytes || MAX_BYTES };
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "noteblock-template-"));
  try {
    const clone = path.join(tmp, "repo");
    const subdir = await cloneRepo(parsed, clone, tmp, allowFile);
    const dir = repoFolder(clone, subdir);
    const name = subdir ? subdir.split("/").pop() : parsed.repo;
    const pages = repoPages(dir, name, parsed.repo);
    if (!pages.length) throw new Error("No pages found in that repo");
    const tally = { files: 0, bytes: 0 };
    for (const page of pages) page.files = pageFiles(page.dir, tally, limits);

    const commands = [...new Set(pages.flatMap((p) => codeCommands(p.manifest)))];
    const same = Array.isArray(approved) && approved.length === commands.length && commands.every((c) => approved.includes(c));
    if (commands.length && allowCode !== false && !(allowCode === true && same)) return { needsConfirm: { commands } };
    return { added: await installPages(pages, parsed.sourceUrl, allowCode === true) };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
