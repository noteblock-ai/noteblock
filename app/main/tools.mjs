// The tools Quire ships with, for its own features: git (vault history and sync), Node and
// pnpm (page builds, the example backends), and wrangler (publishing to your own Cloudflare,
// fetched on first use at a pinned version and run with the Node and pnpm here). Everything
// else a page's backend runs (python3, deno, go…) is the Mac's job: Quire only says, plainly,
// when one is missing (backend.mjs `missingTool`).
//
// - Node is Quire's own binary run as Node: process.execPath with ELECTRON_RUN_AS_NODE=1.
// - pnpm is the `pnpm` package's bin/pnpm.cjs (a dependency, so it's in the app's node_modules).
// - git is dugite-native's portable git, fetched by scripts/fetch-tools.mjs into
//   build/tools/git/darwin-<arch>. The universal app carries both (Contents/Resources/git/
//   darwin-arm64 and darwin-x64, kept out of the lipo merge by mac.x64ArchFiles) and runs the
//   one for process.arch. On Windows it is MinGit in git/win32-<arch> (cmd/git.exe).
//
// Page builds and backends find `node`, `pnpm`, `pnpx` and `npx` through small shell scripts
// in a bin folder put first on their PATH (shimDir); on Windows they are .cmd files. Settings → Tools can switch any of git,
// node and pnpm to "the one on this Mac" (config.json `tools: {git: "system", …}`); a switched
// tool gets no shim, and when the Mac doesn't have it Quire keeps using its own.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, useGit } from "../../core/index.mjs";
import { BRAND } from "../../core/brand.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** wrangler isn't shipped (its workerd runtime is ~135 MB per arch): this exact one is fetched. */
export const WRANGLER_VERSION = "4.147.0";
export const TOOL_IDS = ["git", "node", "pnpm"];

const USES = {
  git: "Page history and sync",
  node: "Page builds and backends that run node",
  pnpm: "Page builds (pnpm install, pnpm build)",
  wrangler: "Publishing to your own Cloudflare",
};
const NAMES = { git: "Git", node: "Node", pnpm: "pnpm", wrangler: "wrangler" };

const state = { shimDir: null, shellPath: null, versions: new Map() };

/* ------------------------------------------------------------ where things are */

const WIN = process.platform === "win32";
/** Folder name of the shipped git for this machine: darwin-arm64, win32-x64… */
const gitPlatformDir = () => `${WIN ? "win32" : "darwin"}-${process.arch}`;
/** Where the git binary sits inside that folder. */
const gitBinIn = (dir) => (WIN ? path.join(dir, "cmd", "git.exe") : path.join(dir, "bin", "git"));

const isElectron = () => !!process.versions.electron;
const packaged = () => isElectron() && !process.defaultApp && !!process.resourcesPath && !process.resourcesPath.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`);

/** Folder of the shipped git (has bin/git, cmd/git.exe on Windows), or null when this checkout hasn't fetched it. */
export function builtinGitDir() {
  const dirs = [
    packaged() ? path.join(process.resourcesPath, "git", gitPlatformDir()) : null,
    path.join(REPO_ROOT, "build", "tools", "git", gitPlatformDir()),
  ].filter(Boolean);
  return dirs.find((d) => fs.existsSync(gitBinIn(d))) || null;
}

// The `pnpm` dependency, in the app's own node_modules (the checkout's in dev). Its exports
// don't include package.json, so it's found by path rather than require.resolve.
const PNPM_DIR = path.join(REPO_ROOT, "node_modules", "pnpm");

/** The shipped pnpm's JS entry (run it with builtinNode()). */
export function builtinPnpm() {
  const f = path.join(PNPM_DIR, "bin", "pnpm.cjs");
  return fs.existsSync(f) ? f : null;
}

const pnpmVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PNPM_DIR, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
};

/** [binary, env] that runs a Node script with Quire's own Node. */
export function builtinNode() {
  return { bin: process.execPath, env: isElectron() ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
}

/** The PATH of the person's login shell (a Finder-launched app gets a bare one). Set by builds.mjs. */
export function setShellPath(p) {
  state.shellPath = p || null;
}

/** PATH as the environment has it (Windows spells it Path; process.env is case-blind there, a copy isn't). */
export const envPath = (env = process.env) => (WIN ? env[Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH"] : env.PATH);

const searchPath = () => (state.shellPath || envPath() || "").split(path.delimiter).filter((d) => d && d !== state.shimDir);

/** The tool's binary on this computer's PATH, or null (on Windows: name.exe / .cmd / .bat). */
export function findOnMac(name) {
  const names = WIN ? [".exe", ".cmd", ".bat", ""].map((ext) => name + ext) : [name];
  for (const dir of searchPath()) {
    for (const n of names) {
      const f = path.join(dir, n);
      try {
        fs.accessSync(f, fs.constants.X_OK);
        if (fs.statSync(f).isFile()) return f;
      } catch {}
    }
  }
  return null;
}

/* ------------------------------------------------------------ config */

/** config.json `tools`: {git, node, pnpm} → "builtin" | "system" (default builtin). */
export function toolModes() {
  const t = loadConfig().tools;
  const out = {};
  for (const id of TOOL_IDS) out[id] = t && t[id] === "system" ? "system" : "builtin";
  return out;
}

export function setToolMode(id, mode) {
  if (!TOOL_IDS.includes(id)) throw new Error(`Unknown tool: ${id}`);
  if (mode !== "system" && mode !== "builtin") throw new Error(`Pick "builtin" or "system"`);
  const cfg = loadConfig();
  const tools = { ...(cfg.tools && typeof cfg.tools === "object" ? cfg.tools : {}), [id]: mode };
  saveConfig({ ...cfg, tools });
  applyTools();
  return toolsInfo();
}

/**
 * What each tool resolves to right now: {mode, source: "builtin"|"system", path, missing}.
 * missing: switched to the Mac's one, but the Mac has none (Quire's own is used meanwhile).
 */
function resolve(id) {
  const mode = toolModes()[id];
  const mac = findOnMac(id);
  const own = id === "git" ? builtinGitDir() && gitBinIn(builtinGitDir()) : id === "pnpm" ? builtinPnpm() : process.execPath;
  if (mode === "system" && mac) return { mode, source: "system", path: mac, missing: false };
  if (own) return { mode, source: "builtin", path: own, missing: mode === "system" };
  // A checkout that hasn't run scripts/fetch-tools.mjs has no git of its own: use the Mac's.
  return { mode, source: mac ? "system" : "none", path: mac, missing: mode === "system" || !mac };
}

/* ------------------------------------------------------------ git */

/**
 * GIT_* variables for the shipped git: where its helpers and templates are, and a system
 * config that keeps /etc/gitconfig and the Mac's keychain credential helper when there is one
 * (Apple's git sets that in a file this git doesn't read).
 */
function portableGitEnv(dir) {
  // MinGit reads its own system config (etc/gitconfig, with Git Credential Manager) and finds
  // its templates itself; it only needs to be told where its helpers are.
  if (WIN) return { GIT_EXEC_PATH: path.join(dir, process.arch === "arm64" ? "clangarm64" : "mingw64", "libexec", "git-core") };
  const conf = path.join(toolsHome(), "gitconfig");
  const lines = [`# Written by ${BRAND.name} for the git it ships. Your ~/.gitconfig still applies.`, "[include]", `\tpath = ${path.join(dir, "etc", "gitconfig")}`];
  const keychain = [
    "/Library/Developer/CommandLineTools/usr/libexec/git-core/git-credential-osxkeychain",
    "/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core/git-credential-osxkeychain",
  ].find((f) => fs.existsSync(f));
  if (keychain) lines.push("[credential]", `\thelper = ${keychain.replace(/ /g, "\\ ")}`);
  try {
    fs.mkdirSync(path.dirname(conf), { recursive: true });
    fs.writeFileSync(conf, lines.join("\n") + "\n");
  } catch {}
  return {
    GIT_EXEC_PATH: path.join(dir, "libexec", "git-core"),
    GIT_TEMPLATE_DIR: path.join(dir, "share", "git-core", "templates"),
    GIT_CONFIG_SYSTEM: conf,
  };
}

/** {bin, env} for running git: env holds only the variables to add. */
export function gitTool() {
  const r = resolve("git");
  if (r.source === "builtin") return { bin: r.path, env: portableGitEnv(builtinGitDir()) };
  return { bin: r.path || "git", env: {} };
}

/* ------------------------------------------------------------ shims */

const toolsHome = () => (state.shimDir ? path.dirname(state.shimDir) : path.join(os.tmpdir(), "quire-tools-home"));

/** The bin folder that page builds and backends get first on PATH (null before initTools). */
export function shimDir() {
  return state.shimDir;
}

const q = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;

function writeShim(dir, name, body) {
  const file = path.join(dir, name);
  const text = `#!/bin/sh\n# ${BRAND.name}'s ${name} (Settings → Tools). Rewritten each time ${BRAND.name} starts.\n${body}\n`;
  try {
    if (fs.readFileSync(file, "utf8") === text) return;
  } catch {}
  fs.writeFileSync(file, text, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

// npx on Windows: the same logic as the sh shim, as a script Quire's Node runs (cmd.exe can't
// shift %*). argv: pnpm.cjs, then npx's own arguments.
const NPX_JS = `// ${BRAND.name}'s npx (Settings → Tools). Rewritten each time ${BRAND.name} starts.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [pnpm, ...args] = process.argv.slice(2);
while (args[0] === "-y" || args[0] === "--yes") args.shift();
const local = args[0] && ["", ".cmd", ".exe"].some((e) => fs.existsSync(path.join("node_modules", ".bin", args[0] + e)));
const r = spawnSync(process.execPath, [pnpm, local ? "exec" : "dlx", ...args], { stdio: "inherit", env: process.env });
process.exit(r.status == null ? 1 : r.status);
`;

function writeFileIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, "utf8") === text) return;
  } catch {}
  fs.writeFileSync(file, text);
}

/** Windows: <name>.cmd files instead of sh scripts. */
function writeWinShims(dir, modes) {
  const exe = process.execPath;
  const pnpm = builtinPnpm();
  const head = (name) => `@echo off\r\nrem ${BRAND.name}'s ${name} (Settings → Tools). Rewritten each time ${BRAND.name} starts.\r\nset ELECTRON_RUN_AS_NODE=1\r\n`;
  const want = {};
  if (modes.node === "builtin" && isElectron()) want.node = `"${exe}" %*`;
  if (modes.pnpm === "builtin" && pnpm) {
    want.pnpm = `"${exe}" "${pnpm}" %*`;
    want.pnpx = `"${exe}" "${pnpm}" dlx %*`;
    want.npx = `"${exe}" "${path.join(dir, "npx.cjs")}" "${pnpm}" %*`;
  }
  for (const name of ["node", "pnpm", "pnpx", "npx"]) {
    const file = path.join(dir, name + ".cmd");
    if (want[name]) writeFileIfChanged(file, head(name) + want[name] + "\r\n");
    else fs.rmSync(file, { force: true });
  }
  if (want.npx) writeFileIfChanged(path.join(dir, "npx.cjs"), NPX_JS);
  else fs.rmSync(path.join(dir, "npx.cjs"), { force: true });
}

/** Write (or remove) the shims for the current modes. */
function writeShims() {
  const dir = state.shimDir;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  if (WIN) return writeWinShims(dir, toolModes());
  const modes = toolModes();
  const node = `ELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)}`;
  const pnpm = builtinPnpm();
  const want = {};
  if (modes.node === "builtin" && isElectron()) want.node = `${node} "$@"`;
  if (modes.pnpm === "builtin" && pnpm) {
    want.pnpm = `${node} ${q(pnpm)} "$@"`;
    want.pnpx = `${node} ${q(pnpm)} dlx "$@"`;
    // npx, as far as pnpm goes: a bin the project has runs from node_modules, anything else
    // is fetched (pnpm dlx). -y/--yes is what npx would have asked; there is nothing to ask.
    want.npx = [
      'while [ "$1" = "-y" ] || [ "$1" = "--yes" ]; do shift; done',
      `if [ -n "$1" ] && [ -x "node_modules/.bin/$1" ]; then ${node} ${q(pnpm)} exec "$@"; fi`,
      `${node} ${q(pnpm)} dlx "$@"`,
    ].join("\n");
  }
  for (const name of ["node", "pnpm", "pnpx", "npx"]) {
    if (want[name]) writeShim(dir, name, want[name]);
    else fs.rmSync(path.join(dir, name), { force: true });
  }
}

/** PATH for page builds and backends: the shims first, then the login shell's PATH. */
export function pagePath(basePath) {
  const dir = state.shimDir;
  if (!dir) return basePath;
  const rest = String(basePath || "").split(path.delimiter).filter((d) => d && d !== dir);
  return [dir, ...rest].join(path.delimiter);
}

/* ------------------------------------------------------------ start + apply */

/**
 * Call once at startup (main.mjs) with a folder Quire owns: shims go in <dir>/bin.
 */
export function initTools({ dir }) {
  state.shimDir = path.join(dir, "bin");
  applyTools();
}

/** Point core/git at the right git and rewrite the shims (after a Settings change). */
export function applyTools() {
  useGit(gitTool());
  try {
    writeShims();
  } catch (err) {
    console.error("[quire] tools: couldn't write shims:", err.message);
  }
}

/* ------------------------------------------------------------ wrangler */

/** [command, args, env] for `wrangler <args>`: pnpm dlx wrangler@<pinned>, with Quire's node + pnpm. */
export function wranglerCommand(args) {
  const spec = `wrangler@${WRANGLER_VERSION}`;
  const r = resolve("pnpm");
  if (r.source === "builtin") {
    const n = builtinNode();
    return [n.bin, [r.path, "dlx", spec, ...args], n.env];
  }
  return [r.path || "pnpm", ["dlx", spec, ...args], {}];
}

/* ------------------------------------------------------------ Settings → Tools */

function runVersion(bin, args, env) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 8000, encoding: "utf8", env: { ...process.env, ...env } }, (err, stdout) => {
      const m = /(\d+\.\d+(?:\.\d+)?)/.exec(String(stdout || ""));
      resolve(err || !m ? null : m[1]);
    });
  });
}

/** `--version` of one binary, asked once per path per run. */
function versionOf(id, r) {
  if (r.source === "builtin") {
    if (id === "node") return Promise.resolve(isElectron() ? process.versions.node : process.version.slice(1));
    if (id === "pnpm") return Promise.resolve(pnpmVersion());
  }
  if (!r.path) return Promise.resolve(null);
  const key = r.path;
  if (!state.versions.has(key)) {
    const env = id === "git" && r.source === "builtin" ? portableGitEnv(builtinGitDir()) : {};
    state.versions.set(key, runVersion(r.path, ["--version"], env));
  }
  return state.versions.get(key);
}

/**
 * One row per tool for Settings → Tools:
 * {id, name, uses, mode, source, path, version, missing, macPath, fixed?}
 */
export async function toolsInfo() {
  const rows = [];
  for (const id of TOOL_IDS) {
    const r = resolve(id);
    rows.push({
      id,
      name: NAMES[id],
      uses: USES[id],
      mode: r.mode,
      source: r.source,
      path: r.source === "builtin" && id === "node" ? process.execPath : r.path,
      version: await versionOf(id, r),
      missing: r.missing,
      macPath: findOnMac(id),
    });
  }
  const p = resolve("pnpm");
  rows.push({
    id: "wrangler",
    name: NAMES.wrangler,
    uses: USES.wrangler,
    mode: "builtin",
    source: "fetched",
    path: null,
    version: WRANGLER_VERSION,
    missing: false,
    macPath: null,
    fixed: true,
    via: p.source === "builtin" ? `${BRAND.name}'s pnpm` : "this Mac's pnpm",
  });
  return rows;
}

/* ------------------------------------------------------------ missing tools */

/** Where to get the tools page backends ask for most. Anything else: a web search. */
const HELP = {
  python: "https://www.python.org/downloads/macos/",
  python3: "https://www.python.org/downloads/macos/",
  pip: "https://www.python.org/downloads/macos/",
  pip3: "https://www.python.org/downloads/macos/",
  node: "https://nodejs.org",
  npm: "https://nodejs.org",
  npx: "https://nodejs.org",
  deno: "https://docs.deno.com/runtime/getting_started/installation/",
  bun: "https://bun.sh",
  go: "https://go.dev/dl/",
  ruby: "https://www.ruby-lang.org/en/documentation/installation/",
  gem: "https://www.ruby-lang.org/en/documentation/installation/",
  bundle: "https://bundler.io",
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
  uvx: "https://docs.astral.sh/uv/getting-started/installation/",
  docker: "https://docs.docker.com/desktop/setup/install/mac-install/",
  cargo: "https://rustup.rs",
  rustc: "https://rustup.rs",
  php: "https://www.php.net/downloads",
  java: "https://adoptium.net",
  brew: "https://brew.sh",
  git: "https://git-scm.com/downloads/mac",
  make: "https://developer.apple.com/xcode/resources/",
};

/** A link that explains how to get `tool` on a Mac. */
export function toolHelpUrl(tool) {
  const t = String(tool || "").toLowerCase();
  const base = t.replace(/[\d.]+$/, "");
  return HELP[t] || HELP[base] || `https://duckduckgo.com/?q=${encodeURIComponent(`install ${tool} on macOS`)}`;
}
