// Vault trust ("restricted mode"), docs/contract.md "Trust" and docs/decisions/sandboxing.md.
//
// A vault is trusted or restricted per machine. The answer lives in <configDir>/trust.json
// (core/vault.mjs readTrustStore), keyed by the vault's real path, never in the vault itself:
// anything inside the vault could have been written by whoever sent it.
//
// - Trusted without asking: a vault this app or CLI created from an empty folder
//   (core createVault), and, once, every vault config.json already knew when this code first ran
//   (migrateTrust), so existing vaults never prompt.
// - Anything else is "ask": the window shows the trust prompt, and until it is answered the
//   vault is treated as restricted.
// - Restricted: no backend starts, no build runs, page RPCs only reach the calling page, pages
//   get a CSP that keeps them on their own origin, and Noteblock AI can't be started from a page.
//
// In a trusted vault, commands are approved per page: `backend.run` and `build` commands are
// recorded as sha256 hashes per page id. The rule, kept simple on purpose:
// - every command present when the vault became trusted (or the migration ran) is approved
//   (the baseline, taken the first time the app opens the vault after that);
// - a command written from inside this app (the editor saving the manifest, a page made from a
//   template) or by an agent holding the page's `quire edit` lock is approved;
// - anything else (a sync pull, another program writing the folder) is new, and the app asks
//   once, showing the command, before running it. "Don't run" is remembered too.
// Only the command text is checked: a changed server.js behind an approved `node server.js`
// still runs. See sandboxing.md for what is still open.
import crypto from "node:crypto";
import { findPage, isVaultDir, listLocks, listTree, loadConfig, markVaultTrusted, readTrustStore, trustKey, walkTree, writeTrustStore } from "../../core/index.mjs";

export const TRUSTED = "trusted";
export const RESTRICTED = "restricted";
/** Not in the store yet: the window asks; enforced as restricted meanwhile. */
export const ASK = "ask";

/** Cached trust.json. Only this process writes it while the app runs (the CLI only adds a vault it creates). */
let cache = null;
const store = () => (cache ||= readTrustStore());
function save(next) {
  cache = next;
  writeTrustStore(next);
}
/** Re-read trust.json (the CLI may have created and trusted a vault since). */
export function reloadTrust() {
  cache = null;
}

/* ------------------------------------------------------------ vault state */

/**
 * First launch with this code: every vault config.json knows (current + recent) becomes trusted,
 * so nobody's own vaults start prompting. Runs once; trust.json records that it did.
 */
export function migrateTrust() {
  const s = readTrustStore();
  if (s.migrated) {
    cache = s;
    return false;
  }
  const cfg = loadConfig();
  const now = new Date().toISOString();
  for (const v of [cfg.current, ...(cfg.vaults || [])]) {
    if (!v || !isVaultDir(v)) continue;
    const key = trustKey(v);
    if (!s.vaults[key]) s.vaults[key] = { state: TRUSTED, since: now, how: "migrated" };
  }
  s.migrated = now;
  save(s);
  return true;
}

/** "trusted" | "restricted" | "ask" for a vault on this machine. */
export function vaultTrust(vault) {
  if (!vault) return ASK;
  const entry = store().vaults[trustKey(vault)];
  if (!entry) {
    // The CLI may have just created (and trusted) it: look once more before asking.
    reloadTrust();
    const again = store().vaults[trustKey(vault)];
    return again && (again.state === TRUSTED || again.state === RESTRICTED) ? again.state : ASK;
  }
  return entry.state === TRUSTED || entry.state === RESTRICTED ? entry.state : ASK;
}

export const isTrusted = (vault) => vaultTrust(vault) === TRUSTED;

/** Set a vault trusted or restricted. Trusting it approves the commands in it right now. */
export function setVaultTrust(vault, state) {
  if (state !== TRUSTED && state !== RESTRICTED) throw new Error(`Unknown trust state: ${state}`);
  const s = store();
  const key = trustKey(vault);
  const cur = s.vaults[key] || {};
  s.vaults[key] = { ...cur, state, since: new Date().toISOString(), how: "chosen" };
  if (state === TRUSTED) s.vaults[key].approved = baselineOf(vault, cur.approved);
  save(s);
  pending.forEach((req, k) => req.vault === trustKey(vault) && pending.delete(k));
  return state;
}

/** A vault that was created trusted (core createVault) or migrated gets its command baseline the first time it's opened. */
export function ensureBaseline(vault) {
  const s = store();
  const key = trustKey(vault);
  const entry = s.vaults[key];
  if (!entry || entry.state !== TRUSTED || entry.approved) return;
  entry.approved = baselineOf(vault, null);
  save(s);
}

/** Renamed or moved: the trust (and approvals) follow the vault. */
export function moveTrust(from, to) {
  const s = store();
  const a = trustKey(from);
  const b = trustKey(to);
  if (a === b || !s.vaults[a]) return;
  s.vaults[b] = s.vaults[a];
  delete s.vaults[a];
  save(s);
}

/** Drop a vault from the store, so the next open asks again (QUIRE_TRUST=ask, for checks). */
export function forgetTrust(vault) {
  const s = store();
  if (!s.vaults[trustKey(vault)]) return;
  delete s.vaults[trustKey(vault)];
  save(s);
}

/** Trust a vault this app just made (New vault, the first-run vault). */
export function trustCreated(vault) {
  if (vaultTrust(vault) !== ASK) return;
  markVaultTrusted(vault, "created");
  reloadTrust();
}

/* ------------------------------------------------------------ commands */

const sha = (cmd) => crypto.createHash("sha256").update(String(cmd)).digest("hex");
const pageKey = (node) => node.id || "path:" + node.path;

/** A page's commands: [{kind: "backend", name, cmd} | {kind: "build", cmd}]. */
export function commandsOf(node) {
  const out = [];
  if (node && node.backend) for (const [name, cmd] of Object.entries(node.backend.run || {})) out.push({ kind: "backend", name, cmd });
  if (node && node.build) out.push({ kind: "build", cmd: node.build });
  return out;
}

/** Every page's commands now, as approvals (added to `prev`). */
function baselineOf(vault, prev) {
  const approved = { ...(prev || {}) };
  let nodes = [];
  try {
    nodes = [...walkTree(listTree(vault))];
  } catch {}
  for (const n of nodes) {
    if (n.kind !== "page") continue;
    const hashes = commandsOf(n).map((c) => sha(c.cmd));
    if (hashes.length) approved[pageKey(n)] = [...new Set([...(approved[pageKey(n)] || []), ...hashes])];
  }
  return approved;
}

function entryOf(vault) {
  return store().vaults[trustKey(vault)] || null;
}

/** Approve a page's current commands: the person (or their agent under a lock) wrote them in this app. */
export function approveCommands(vault, nodeOrPath) {
  const node = typeof nodeOrPath === "string" ? safeFind(vault, nodeOrPath) : nodeOrPath;
  if (!node || !isTrusted(vault)) return;
  const hashes = commandsOf(node).map((c) => sha(c.cmd));
  if (!hashes.length) return;
  const s = store();
  const entry = s.vaults[trustKey(vault)];
  const k = pageKey(node);
  const have = new Set((entry.approved ||= {})[k] || []);
  if (hashes.every((h) => have.has(h))) return;
  entry.approved[k] = [...new Set([...have, ...hashes])];
  if (entry.declined && entry.declined[k]) entry.declined[k] = entry.declined[k].filter((h) => !hashes.includes(h));
  save(s);
  pending.delete(trustKey(vault) + "\0" + k);
}

function safeFind(vault, ref) {
  try {
    return findPage(vault, ref);
  } catch {
    return null;
  }
}

/* Pages an agent holds with `quire edit`: what they write is the person's. Locks seen per vault,
 * so a lock that went away (quire done) approves what the agent left, even when the watcher
 * reports the manifest change before the lock removal. */
const seenLocks = new Map();

/** Note the vault's locks now; approve the commands of pages whose lock just went away. */
export function noteLocks(vault) {
  const key = trustKey(vault);
  let now = [];
  try {
    now = listLocks(vault);
  } catch {}
  const ids = new Set(now.map((l) => l.id).filter(Boolean));
  const before = seenLocks.get(key) || new Set();
  seenLocks.set(key, ids);
  for (const id of before) if (!ids.has(id)) approveCommands(vault, id);
  return ids;
}

/* ------------------------------------------------------------ the gate */

/** Approvals waiting for the person: "<vault key>\0<page key>" → request. */
const pending = new Map();
let notify = () => {};
/** Main wires this to the windows ("trust-request"). */
export function onTrustRequest(fn) {
  notify = fn;
}

/** Requests still waiting for an answer in this vault (a window that just loaded shows them). */
export function pendingRequests(vault) {
  const key = trustKey(vault);
  return [...pending.values()].filter((r) => r.vault === key).map(publicRequest);
}

const publicRequest = (r) => ({ page: r.page, title: r.title, commands: r.commands.map(({ kind, name, cmd }) => ({ kind, name: name || null, cmd })) });

/**
 * May this page's commands run? Called right before a backend starts or a build runs.
 * @returns {{ok: true} | {ok: false, reason: "restricted" | "unapproved" | "declined", message: string}}
 */
export function commandGate(vault, node) {
  const state = vaultTrust(vault);
  if (state !== TRUSTED) return { ok: false, reason: "restricted", message: "Restricted mode. Commands don't run in this vault." };
  const cmds = commandsOf(node);
  if (!cmds.length) return { ok: true };
  ensureBaseline(vault);
  const k = pageKey(node);
  // An agent holding the page writes for the person.
  const locked = noteLocks(vault);
  if (node.id && locked.has(node.id)) {
    approveCommands(vault, node);
    return { ok: true };
  }
  const entry = entryOf(vault) || {};
  const approved = new Set((entry.approved || {})[k] || []);
  const missing = cmds.filter((c) => !approved.has(sha(c.cmd)));
  if (!missing.length) return { ok: true };
  const declined = new Set((entry.declined || {})[k] || []);
  if (missing.every((c) => declined.has(sha(c.cmd)))) return { ok: false, reason: "declined", message: "You chose not to run this command." };
  const req = { vault: trustKey(vault), vaultPath: vault, page: node.path, title: node.title || node.path, id: k, commands: missing };
  const key = req.vault + "\0" + k;
  const prev = pending.get(key);
  pending.set(key, req);
  if (!prev || JSON.stringify(prev.commands) !== JSON.stringify(missing)) notify(publicRequest(req));
  return { ok: false, reason: "unapproved", message: "Waiting for you to allow a new command." };
}

/** Ask about a page's unapproved commands again (Start in the Backend panel after a "Don't run"). */
export function askAgain(vault, nodeOrPath) {
  const node = typeof nodeOrPath === "string" ? safeFind(vault, nodeOrPath) : nodeOrPath;
  if (!node || !isTrusted(vault)) return;
  const s = store();
  const entry = s.vaults[trustKey(vault)];
  const k = pageKey(node);
  if (entry && entry.declined && entry.declined[k]) {
    delete entry.declined[k];
    save(s);
  }
}

/**
 * The person answered a command prompt. run: approve the page's current commands; otherwise
 * remember them as declined so the prompt doesn't come back until they change.
 * @returns {object|null} the page node (to start its backend / build), or null
 */
export function answerCommands(vault, pagePath, run) {
  const node = safeFind(vault, pagePath);
  if (!node) return null;
  const k = pageKey(node);
  pending.delete(trustKey(vault) + "\0" + k);
  if (!isTrusted(vault)) return null;
  if (run) {
    approveCommands(vault, node);
    return node;
  }
  const s = store();
  const entry = s.vaults[trustKey(vault)];
  const approved = new Set((entry.approved || {})[k] || []);
  const hashes = commandsOf(node).map((c) => sha(c.cmd)).filter((h) => !approved.has(h));
  (entry.declined ||= {})[k] = [...new Set([...(entry.declined[k] || []), ...hashes])];
  save(s);
  return null;
}

/* ------------------------------------------------------------ pages */

/**
 * The Content-Security-Policy for pages in a restricted vault: everything from the page's own
 * origin ('self') and the shared runtime, embeds of other pages, nothing from the network.
 * Inline scripts and eval stay allowed: plenty of pages are one HTML file.
 */
export function restrictedCsp({ runtime = "quire://runtime" } = {}) {
  const local = `'self' ${runtime}`;
  return [
    `default-src ${local}`,
    `script-src ${local} 'unsafe-inline' 'unsafe-eval' blob:`,
    `style-src ${local} 'unsafe-inline'`,
    `img-src ${local} data: blob:`,
    `font-src ${local} data:`,
    `media-src ${local} data: blob:`,
    `connect-src ${local}`,
    `worker-src 'self' blob:`,
    // Embeds are other pages on their own quire:// origins; never the web.
    `frame-src 'self' quire:`,
    `child-src 'self' quire: blob:`,
    `form-action 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
  ].join("; ");
}
