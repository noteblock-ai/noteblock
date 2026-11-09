// Per-vault git: one local repo, everything commits straight to main.
//
// Two flavours: the sync one (CLI, MCP, quit, explicit user actions) and commitAllAsync for
// the app's autosave. In the Electron main process a sync git call freezes the browser
// process, and with it keyboard input to every window, for as long as git runs (~200-300 ms
// per commit on a 5k-file vault), so anything that runs while someone types must be async.
import { execFile, execFileSync } from "node:child_process";
import { BRAND } from "./brand.mjs";

const AGENT_AUTHOR = "Claude <claude@quire.local>";

// Which git runs. The CLI and MCP server use the one on PATH; the app points this at the git it
// ships (app/main/tools.mjs) unless Settings → Tools says to use the Mac's.
const gitCmd = { bin: "git", env: null };

/**
 * Run git as `bin` with `env` added to the environment (GIT_EXEC_PATH and friends for a
 * portable git). No arguments = the git on PATH.
 * @param {{bin?: string, env?: Record<string, string>|null}} [opts]
 */
export function useGit({ bin = "git", env = null } = {}) {
  gitCmd.bin = bin || "git";
  gitCmd.env = env && Object.keys(env).length ? env : null;
}

/** The git that runs now: {bin, env} (env: extra variables, or null). */
export function gitCommand() {
  return { bin: gitCmd.bin, env: gitCmd.env };
}

const gitEnv = () => (gitCmd.env ? { ...process.env, ...gitCmd.env } : undefined);

/** Per-process counters (QUIRE_PERF / scripts/measure-typing.mjs read them). */
export const gitStats = { syncCalls: 0, syncMs: 0, asyncCalls: 0, asyncMs: 0 };

const LOCK_RETRY_MS = 3000;
const isLockError = (err) => /index\.lock|Unable to create .*\.lock/i.test(String(err && (err.stderr || err.message)));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function fail(args, err) {
  const msg = String(err.stderr || err.message || "").trim().split("\n")[0];
  return new Error(`git ${args[0]} failed: ${msg}`);
}

function git(vault, args, { allowFail = false } = {}) {
  const t0 = performance.now();
  try {
    // An async autosave commit may hold the index lock for a moment: wait it out.
    for (const until = Date.now() + LOCK_RETRY_MS; ; ) {
      try {
        return execFileSync(gitCmd.bin, ["-C", vault, ...args], {
          encoding: "utf8",
          env: gitEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        if (!isLockError(err) || Date.now() > until) throw err;
        sleepSync(25);
      }
    }
  } catch (err) {
    if (allowFail) return null;
    throw fail(args, err);
  } finally {
    gitStats.syncCalls++;
    gitStats.syncMs += performance.now() - t0;
  }
}

function gitAsync(vault, args, { allowFail = false } = {}) {
  const t0 = performance.now();
  const until = Date.now() + LOCK_RETRY_MS;
  return new Promise((resolve, reject) => {
    const attempt = () =>
      execFile(gitCmd.bin, ["-C", vault, ...args], { encoding: "utf8", env: gitEnv(), maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && isLockError({ stderr }) && Date.now() < until) return setTimeout(attempt, 25);
        gitStats.asyncCalls++;
        gitStats.asyncMs += performance.now() - t0;
        if (!err) return resolve(stdout);
        if (allowFail) return resolve(null);
        reject(fail(args, { stderr, message: err.message }));
      });
    attempt();
  });
}

function configured(vault, key) {
  const out = git(vault, ["config", "--get", key], { allowFail: true });
  return out ? out.trim() : "";
}

/** Commit flags: no signing, and a fallback identity when the machine has none. */
function commitArgs(names, author, message) {
  const pre = ["-c", "commit.gpgsign=false"];
  const fallback = splitAuthor(author) || { name: BRAND.name, email: "quire@quire.local" };
  if (!names.name) pre.push("-c", `user.name=${fallback.name}`);
  if (!names.email) pre.push("-c", `user.email=${fallback.email}`);
  const args = [...pre, "commit", "-q", "--no-verify", "-m", message || "Update"];
  if (author) args.push(`--author=${author}`);
  return args;
}

/** Parse "Name <email>" into parts. */
function splitAuthor(author) {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(author || "");
  return m ? { name: m[1] || BRAND.name, email: m[2] || "quire@quire.local" } : null;
}

/** Turn a `by` value ("Claude", "Rhett", "Ann <a@b.c>") into a git author string. */
export function authorFor(by) {
  if (!by) return AGENT_AUTHOR;
  if (/<[^>]*>/.test(by)) return by;
  const slug = by.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `${by} <${slug}@quire.local>`;
}

/**
 * Repo settings every vault has, on every OS, so a vault synced between a Mac and a PC reads
 * the same: no line-ending conversion (Windows' git defaults to autocrlf=true, which would
 * rewrite every page on checkout) and long paths (a page's node_modules passes 260 characters
 * fast; ignored outside Windows). Only writes what differs.
 */
const REPO_CONFIG = { "core.autocrlf": "false", "core.longpaths": "true" };

export function configureRepo(vault) {
  for (const [key, value] of Object.entries(REPO_CONFIG)) {
    const have = git(vault, ["config", "--local", "--get", key], { allowFail: true });
    if (!have || have.trim() !== value) git(vault, ["config", "--local", key, value], { allowFail: true });
  }
}

export function gitInit(vault) {
  git(vault, ["init", "-q", "-b", "main"]);
  configureRepo(vault);
}

/**
 * `git add -A && git commit`. Returns the new sha, or null when there is nothing to commit.
 * @param {string} vault
 * @param {string} message
 * @param {{author?: string}} [opts] author as "Name <email>"; omitted = git default identity
 */
export function commitAll(vault, message, { author } = {}) {
  git(vault, ["add", "-A"]);
  const status = git(vault, ["status", "--porcelain"]);
  if (!status.trim()) return null;
  // Fallback identity when this machine has none configured (committer is always required).
  const names = { name: configured(vault, "user.name"), email: configured(vault, "user.email") };
  git(vault, commitArgs(names, author, message));
  return git(vault, ["rev-parse", "HEAD"]).trim();
}

/**
 * Commit only `paths` (vault-relative files or folders, added, changed or removed), leaving
 * anything else in the working tree or index alone: an agent's locked page, another page's
 * pending autosave. Returns the new sha, or null when those paths have nothing to commit.
 * @param {string} vault
 * @param {string} message
 * @param {string[]} paths
 * @param {{author?: string}} [opts]
 */
export function commitPaths(vault, message, paths, { author } = {}) {
  const specs = [...new Set((paths || []).filter(Boolean))];
  if (!specs.length) return null;
  // A path that is neither on disk nor in git (created and removed again) fails the whole add:
  // then one at a time, so the others still go in.
  if (git(vault, ["add", "-A", "--", ...specs], { allowFail: true }) == null) {
    for (const p of specs) git(vault, ["add", "-A", "--", p], { allowFail: true });
  }
  const status = git(vault, ["status", "--porcelain", "--", ...specs]);
  if (!status.trim()) return null;
  const names = { name: configured(vault, "user.name"), email: configured(vault, "user.email") };
  const args = commitArgs(names, author, message);
  // Only the paths with staged changes: `git commit -- <path>` fails on a path git doesn't know.
  // --no-renames: a rename's old path is listed too, so the removal is committed with it.
  const staged = (git(vault, ["diff", "--cached", "--name-only", "--no-renames", "-z", "--", ...specs]) || "").split("\0").filter(Boolean);
  if (!staged.length) return null;
  git(vault, [...args, "--", ...staged]);
  return git(vault, ["rev-parse", "HEAD"]).trim();
}

/**
 * commitAll without blocking the event loop: same result, git runs in child processes the
 * caller awaits. Five git calls instead of six (the identity check is one `config`).
 * Returns the new sha, or null when there was nothing to commit.
 * @param {string} vault
 * @param {string} message
 * @param {{author?: string}} [opts]
 */
export async function commitAllAsync(vault, message, { author } = {}) {
  await gitAsync(vault, ["add", "-A"]);
  const status = await gitAsync(vault, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.trim()) return null;
  const ids = (await gitAsync(vault, ["config", "--get-regexp", "^user\\.(name|email)$"], { allowFail: true })) || "";
  const names = { name: /^user\.name /m.test(ids), email: /^user\.email /m.test(ids) };
  try {
    await gitAsync(vault, commitArgs(names, author, message));
  } catch (err) {
    // Someone else (a sync commit on quit, the CLI) committed it between our add and commit.
    const left = await gitAsync(vault, ["status", "--porcelain", "--untracked-files=no"], { allowFail: true });
    if (left != null && !left.trim()) return null;
    throw err;
  }
  return (await gitAsync(vault, ["rev-parse", "HEAD"])).trim();
}

/** Recent commits, newest first. Empty array for a repo with no commits. */
export function gitLog(vault, n = 10) {
  const out = git(
    vault,
    ["log", `-n${Number(n) || 10}`, "--format=%H%x1f%aI%x1f%an <%ae>%x1f%s%x1e"],
    { allowFail: true },
  );
  if (!out) return [];
  return out
    .split("\x1e")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, date, author, message] = rec.split("\x1f");
      return { sha, date, author, message };
    });
}

/** Uncommitted changes as porcelain lines ("?? Notes/index.html"). */
export function gitStatus(vault) {
  const out = git(vault, ["status", "--porcelain"], { allowFail: true }) || "";
  return out.split("\n").filter((l) => l.trim());
}
