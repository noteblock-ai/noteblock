// Page builds. A page whose `.noteblock` manifest has a `build` command is compiled by that command, run
// in the page folder: `{"build": "pnpm build", "entry": "dist/index.html", "source": "index.html"}`.
// `entry` is what gets served; `source` is the HTML template prose edits go to.
import { spawn, spawnSync } from "node:child_process";
import { readManifest } from "./pages.mjs";

const MAX_OUTPUT = 20000;
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Build settings for a page folder, or null when it has no build command.
 * outDir is the entry's top folder ("dist" for "dist/index.html"): files the build writes.
 * @returns {{command: string, entry: string|null, source: string|null, outDir: string|null} | null}
 */
export function buildInfo(dir, manifest = readManifest(dir)) {
  const command = manifest && typeof manifest.build === "string" ? manifest.build.trim() : "";
  if (!command) return null;
  const entry = typeof manifest.entry === "string" ? manifest.entry : null;
  const source = typeof manifest.source === "string" ? manifest.source : null;
  const outDir = entry && entry.includes("/") ? entry.split("/")[0] : null;
  return { command, entry, source, outDir };
}

/** True when a page-relative file is build output (or deps), so changing it needs no rebuild. */
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock"]);

export function isBuildOutput(info, rel) {
  const segs = String(rel).split("/");
  const first = segs[0];
  if (segs.length === 1 && LOCKFILES.has(first)) return true; // an install inside the build rewrites it
  return first === "node_modules" || first === "data" || (!!info?.outDir && first === info.outDir);
}

/**
 * [file, args, options] that run a command line in the platform's shell: /bin/sh -c on Mac,
 * cmd.exe /d /s /c on Windows (what Node's `shell: true` does), with no console window.
 * @param {string} command
 */
export function shellSpawn(command) {
  if (process.platform === "win32") {
    return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], { windowsVerbatimArguments: true, windowsHide: true }];
  }
  return ["/bin/sh", ["-c", command], {}];
}

const tail = (s) => (s.length > MAX_OUTPUT ? "…\n" + s.slice(-MAX_OUTPUT) : s);

/**
 * Run the page's build command with the shell (/bin/sh; cmd.exe on Windows) in its folder. onSpawn(pid) gets the shell's pid.
 * @returns {Promise<{ok: boolean, code: number|null, output: string, ms: number}>}
 */
export function runBuild(dir, { env = process.env, timeout = TIMEOUT_MS, onSpawn } = {}) {
  const info = buildInfo(dir);
  if (!info) return Promise.resolve({ ok: true, code: 0, output: "", ms: 0 });
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    const [file, argv, opts] = shellSpawn(info.command);
    const child = spawn(file, argv, { ...opts, cwd: dir, env: { ...env, FORCE_COLOR: "0", NO_COLOR: "1" } });
    if (onSpawn && child.pid) onSpawn(child.pid);
    const add = (b) => {
      output = tail(output + b.toString());
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      add(`\nBuild timed out after ${Math.round(timeout / 1000)} s`);
      child.kill("SIGTERM");
    }, timeout);
    child.on("error", (err) => add(`\n${err.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output, ms: Date.now() - started });
    });
  });
}

/** Same as runBuild, blocking (CLI, endEdit). */
export function runBuildSync(dir, { env = process.env, timeout = TIMEOUT_MS } = {}) {
  const info = buildInfo(dir);
  if (!info) return { ok: true, code: 0, output: "", ms: 0 };
  const started = Date.now();
  const [file, argv, opts] = shellSpawn(info.command);
  const r = spawnSync(file, argv, {
    ...opts,
    cwd: dir,
    env: { ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = tail((r.stdout?.toString() || "") + (r.stderr?.toString() || "") + (r.error ? `\n${r.error.message}` : ""));
  return { ok: r.status === 0, code: r.status, output, ms: Date.now() - started };
}
