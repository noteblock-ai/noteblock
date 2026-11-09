// The person's own Cloudflare account, through wrangler: who's logged in (`wrangler whoami
// --json`), `wrangler login` (opens the browser OAuth and finishes on its own) and `wrangler
// logout`. publish.mjs deploys with the same pinned wrangler. wrangler isn't shipped (its
// workerd runtime is ~135 MB per arch): `pnpm dlx wrangler@<WRANGLER_VERSION>` fetches that
// exact version once, run with Quire's own pnpm and Node (tools.mjs). QUIRE_WRANGLER=<executable>
// replaces it (scripts/smoke-hosting.mjs and screenshots use a fake one).
import { spawn } from "node:child_process";
import { WRANGLER_VERSION, wranglerCommand } from "./tools.mjs";

export const WRANGLER = `wrangler@${WRANGLER_VERSION}`;
const WHOAMI_TTL_MS = 60_000;

/** [command, args, extra env] for a wrangler invocation. */
function wranglerCmd(args) {
  const fake = process.env.QUIRE_WRANGLER;
  return fake ? [fake, args, {}] : wranglerCommand(args);
}

/**
 * Run wrangler; resolves {ok, output} (stdout + stderr, in order) and never rejects.
 * @param {string[]} args
 * @param {{cwd?: string, env: NodeJS.ProcessEnv, onLog?: (s: string) => void, ci?: boolean, onChild?: (c: import("node:child_process").ChildProcess) => void}} opts
 */
export function runWrangler(args, { cwd, env, onLog, ci = true, onChild }) {
  const [cmd, argv, extra] = wranglerCmd(args);
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(cmd, argv, { cwd, env: { ...env, ...extra, FORCE_COLOR: "0", NO_COLOR: "1", ...(ci ? { CI: "1" } : {}) } });
    onChild?.(child);
    const add = (b) => {
      const s = b.toString();
      output += s;
      onLog?.(s);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("error", (err) => add(`\n${err.message}`));
    child.on("close", (code) => resolve({ ok: code === 0, output }));
  });
}

/** The JSON object in wrangler's output (pnpm may print around it). */
function parseJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

let cached = null; // {at, value}
let login = null; // {child, promise}

/**
 * Who wrangler is logged in as: {loggedIn, email, accounts: [{id, name}]}. Cached for a minute;
 * `fresh` skips the cache.
 */
export async function cloudflareAccount({ env, fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < WHOAMI_TTL_MS) return cached.value;
  const r = await runWrangler(["whoami", "--json"], { env });
  const json = parseJson(r.output);
  let value;
  if (json && typeof json.loggedIn === "boolean") {
    value = {
      loggedIn: json.loggedIn,
      email: json.email || null,
      accounts: (Array.isArray(json.accounts) ? json.accounts : []).map((a) => ({ id: String(a.id), name: String(a.name || "") })),
    };
  } else if (/not authenticated|not logged in|wrangler login/i.test(r.output)) {
    value = { loggedIn: false, email: null, accounts: [] };
  } else {
    throw Object.assign(new Error("Couldn't ask wrangler who's logged in to Cloudflare."), { output: r.output });
  }
  cached = { at: Date.now(), value };
  return value;
}

/** The account a deploy goes to: CLOUDFLARE_ACCOUNT_ID, or the only (first) one wrangler sees. */
export async function cloudflareAccountId({ env }) {
  if (env.CLOUDFLARE_ACCOUNT_ID) return env.CLOUDFLARE_ACCOUNT_ID;
  try {
    const a = await cloudflareAccount({ env });
    return a.accounts[0]?.id || null;
  } catch {
    return null;
  }
}

/** The Cloudflare dashboard page of a Worker. Without an account id, the dashboard picks one. */
export function dashboardUrl(accountId, worker) {
  const p = `workers/services/view/${encodeURIComponent(worker)}/production`;
  return accountId ? `https://dash.cloudflare.com/${accountId}/${p}` : `https://dash.cloudflare.com/?to=/:account/${p}`;
}

/**
 * `wrangler login`: it opens the browser and returns once the person allowed (or refused) it.
 * onLog streams its output. Resolves to the account afterwards. One at a time.
 */
export function cloudflareLogin({ env, onLog }) {
  if (login) return login.promise;
  const state = { child: null, cancelled: false };
  const promise = runWrangler(["login"], { env, onLog, ci: false, onChild: (c) => (state.child = c) })
    .then(async (r) => {
      cached = null;
      if (state.cancelled) throw new Error("Cloudflare login cancelled.");
      if (!r.ok) throw Object.assign(new Error("Logging in to Cloudflare didn't finish."), { output: r.output });
      return cloudflareAccount({ env, fresh: true });
    })
    .finally(() => {
      login = null;
    });
  login = { state, promise };
  return promise;
}

export function cloudflareLoginRunning() {
  return !!login;
}

export function cancelCloudflareLogin() {
  if (!login) return false;
  login.state.cancelled = true;
  login.state.child?.kill();
  return true;
}

export async function cloudflareLogout({ env }) {
  const r = await runWrangler(["logout"], { env });
  cached = null;
  if (!r.ok && !/not logged in|not authenticated/i.test(r.output)) {
    throw Object.assign(new Error("Logging out of Cloudflare failed."), { output: r.output });
  }
  return cloudflareAccount({ env, fresh: true });
}
