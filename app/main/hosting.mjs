// Managed hosting: the account (a browser sign-in handed back over a loopback port, see the
// electron-auth skill) and the "quire" publish target, which uploads the staged site to the
// hosting server and serves it at https://pageHost(slug)/. The server's API is
// docs/hosting-api.md. Public names and domains come from core/brand.mjs. The API token is kept
// encrypted with Electron's safeStorage in configDir()/hosting.json, never in config.json.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { BRAND, pageHost, siteUrl } from "../../core/brand.mjs";
import { configDir, findPage, readManifest, runBuild, writeManifest } from "../../core/index.mjs";
import { publishFingerprintAsync, stageSite } from "./publish.mjs";
import { billingFake, fakeBilling } from "./billing-debug.mjs";

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const ACCOUNT_TTL_MS = 30_000;
/** Where 0.2.x signed in. A token stored for it is kept when the default server is in use. */
const LEGACY_BASE = `https://${BRAND.legacyDomain}`;

/** The hosting server: QUIRE_HOSTING_URL, or siteUrl() (https://noteblock.ai). */
export function hostingBase() {
  return (process.env.QUIRE_HOSTING_URL || siteUrl()).replace(/\/+$/, "");
}

/** The host a slug is served on (pageHost in core/brand.mjs). */
export function siteHost(slug) {
  return pageHost(slug);
}

/** The slug the server would pick for a title (its rule: [a-z0-9-], 3–40, no "--"). A preview only. */
export function slugFor(title) {
  const s = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s.length >= 3 ? s : (s + "-page").replace(/^-/, "");
}

/* ------------------------------------------------------------------ token storage */

let cipher = null;

/** Tests (plain Node, no Electron) supply their own {encrypt(str) → Buffer, decrypt(Buffer) → str}. */
export function setTokenCipher(c) {
  cipher = c;
}

async function getCipher() {
  if (cipher) return cipher;
  const { safeStorage } = await import("electron");
  if (!safeStorage?.isEncryptionAvailable?.()) return null;
  cipher = { encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) };
  return cipher;
}

function accountFile() {
  return path.join(configDir(), "hosting.json");
}

/** {base, token, user} for the current server, or null. */
async function readAccount() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(accountFile(), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw.token !== "string") return null;
  const sameServer = raw.base === hostingBase() || (raw.base === LEGACY_BASE && hostingBase() === siteUrl());
  if (!sameServer) return null;
  const c = await getCipher();
  if (!c) return null;
  // A token that won't decrypt (another keychain key, e.g. after a rename that changed the
  // app's keychain item) reads as signed out: the next sign-in overwrites it.
  try {
    const token = c.decrypt(Buffer.from(raw.token, "base64"));
    if (!token) return null;
    return { base: hostingBase(), token, user: raw.user || null };
  } catch {
    return null;
  }
}

async function writeAccount(token, user) {
  const c = await getCipher();
  if (!c) throw new Error(`This computer can't store the sign-in securely, so ${BRAND.name} didn't keep it.`);
  fs.mkdirSync(configDir(), { recursive: true });
  const file = accountFile();
  const body = { base: hostingBase(), token: Buffer.from(c.encrypt(token)).toString("base64"), user, signedInAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
}

function forgetAccount() {
  fs.rmSync(accountFile(), { force: true });
  meCache = null;
}

/* ------------------------------------------------------------------ API */

/**
 * A hosting error with a plain sentence; `code: "signin"` means sign in again, `code:
 * "plan_limit"` (with `limit`) that the account's plan doesn't allow it (docs/hosting-api.md).
 */
function hostingError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

async function api(method, pathname, { token, json, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(hostingBase() + pathname, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
  } catch {
    throw hostingError(`Can't reach ${BRAND.name}'s server. Check your connection and try again.`, { code: "offline" });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.ok) return data || {};
  const message = (data && typeof data.error === "string" && data.error) || `${BRAND.name}'s server answered ${res.status}.`;
  if (res.status === 401 && token) {
    forgetAccount();
    throw hostingError(`Sign in to ${BRAND.name} to publish.`, { code: "signin", status: 401 });
  }
  if (data && data.code === "plan_limit") throw hostingError(message, { status: res.status, code: "plan_limit", limit: data.limit || null });
  throw hostingError(message, { status: res.status });
}

/** The desktop API token for the current server, or null when signed out (Noteblock AI, ai.mjs). */
export async function apiToken() {
  return (await readAccount())?.token || null;
}

async function authed() {
  const acct = await readAccount();
  if (!acct) throw hostingError(`Sign in to ${BRAND.name} to publish.`, { code: "signin" });
  return acct;
}

/** The signed-in account, or a `code: "signin"` error. */
export const requireAccount = authed;

/* ------------------------------------------------------------------ the account */

let meCache = null; // {at, value}
let pending = null; // {promise, cancel}

/**
 * The hosting account: {signedIn: false, base, host} or {signedIn: true, base, host, user,
 * usage: {sites, bytes}, limits: {sites, bytesPerSite, filesPerSite}}. `offline: true` when the
 * server couldn't be asked (the stored user is shown). Cached for 30 s.
 */
export async function account({ fresh = false } = {}) {
  const base = hostingBase();
  const host = siteHost("your-page");
  const acct = await readAccount();
  if (!acct) return { signedIn: false, base, host, signingIn: !!pending };
  if (!fresh && meCache && Date.now() - meCache.at < ACCOUNT_TTL_MS) return meCache.value;
  try {
    const me = await api("GET", "/api/me", { token: acct.token });
    const value = { signedIn: true, base, host, user: me.user || acct.user, plan: me.plan || null, usage: me.usage || null, limits: me.limits || null };
    meCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    if (err.code === "signin") return { signedIn: false, base, host, signingIn: !!pending };
    return { signedIn: true, base, host, user: acct.user, plan: null, usage: null, limits: null, offline: true };
  }
}

/* ------------------------------------------------------------------ plans and billing */

/** What /api/billing/checkout sells (docs/hosting-api.md "Plans and billing"). */
export const CHECKOUT_ITEMS = ["pro-month", "pro-year", "credits-350", "credits-1500"];

/**
 * The plan, credits and usage: {signedIn: false} or {signedIn: true, user, plan, credits, usage,
 * limits, plans, packs} (GET /api/billing). With a debug mode on (billing-debug.mjs), made-up
 * data with `fake: <the mode>` and no network.
 */
export async function billing() {
  if (billingFake()) return { signedIn: true, fake: billingFake(), user: { name: "Ada Lovelace", email: "ada@example.com" }, ...fakeBilling() };
  const acct = await readAccount();
  if (!acct) return { signedIn: false };
  try {
    const b = await api("GET", "/api/billing", { token: acct.token });
    return { signedIn: true, user: acct.user, ...b };
  } catch (err) {
    if (err.code === "signin") return { signedIn: false };
    throw err;
  }
}

async function openBilling(pathname, json, openExternal) {
  if (billingFake()) throw hostingError("Debug data is on, so Stripe wasn't opened.", { code: "fake" });
  const acct = await authed();
  const r = await api("POST", pathname, { token: acct.token, json });
  if (!r.url) throw hostingError(`${BRAND.name}'s server didn't send a link.`);
  await openExternal(r.url);
  meCache = null;
  return { url: r.url };
}

/** Start buying `item` (CHECKOUT_ITEMS): Stripe Checkout opens in the browser. Resolves to {url}. */
export function checkout(item, { openExternal }) {
  if (!CHECKOUT_ITEMS.includes(item)) return Promise.reject(hostingError(`Unknown item: ${item}`));
  return openBilling("/api/billing/checkout", { item }, openExternal);
}

/** Open Stripe's customer portal (cancel, switch monthly/yearly, card, invoices). Resolves to {url}. */
export function portal({ openExternal }) {
  return openBilling("/api/billing/portal", {}, openExternal);
}

// The page the browser lands on after the loopback callback, with the mark (build/icon.svg).
const MARK = `<svg width="40" height="40" viewBox="100 100 824 824" role="img" aria-label="${BRAND.name}" style="display:block"><rect x="100" y="100" width="824" height="824" rx="185" fill="#111"/><g transform="translate(192 192) scale(10)"><rect x="8" y="8" width="22" height="22" rx="6" fill="#fff"/><rect x="13" y="14" width="12" height="2.5" rx="1.25" fill="#111"/><rect x="13" y="19" width="12" height="2.5" rx="1.25" fill="#111"/><rect x="13" y="24" width="7" height="2.5" rx="1.25" fill="#111"/><rect x="34" y="8" width="22" height="22" rx="6" fill="#fff" fill-opacity=".45"/><rect x="8" y="34" width="22" height="22" rx="6" fill="#fff" fill-opacity=".45"/><rect x="34" y="34" width="22" height="22" rx="11" fill="#fff" fill-opacity=".75"/></g></svg>`;
const WORDMARK = `<span style="font:600 22px/1 Geist,system-ui,-apple-system,sans-serif;letter-spacing:-0.04em">${BRAND.word}<span style="color:#8a8f98">${BRAND.tld}</span></span>`;
const DONE_PAGE = (msg) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${BRAND.name}</title>` +
  `<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;box-sizing:border-box;background:#fff;color:#15171c;font:15px/1.5 system-ui,-apple-system,sans-serif">` +
  `<main style="width:100%;max-width:360px"><div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">${MARK}${WORDMARK}</div><p style="margin:0">${msg}</p></main></body>`;

/**
 * Sign in: listen on 127.0.0.1:<random port>, open the browser at <base>/auth/desktop, wait for
 * /callback?code&state, swap the code for an API token. Resolves to account().
 * @param {{openExternal: (url: string) => any}} opts
 */
export function signIn({ openExternal }) {
  if (pending) return pending.promise;
  const state = crypto.randomBytes(24).toString("base64url");
  let server;
  let timer;
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
    server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      // Any local process can reach this port; only the browser we sent knows the state.
      const code = u.searchParams.get("code");
      if (!code || u.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE(`That sign-in link isn't the one ${BRAND.name} started. Go back to ${BRAND.name} and try again.`));
        return;
      }
      api("POST", "/api/desktop/token", { json: { code } }).then(
        async (r) => {
          if (!r.token) throw hostingError(`${BRAND.name}'s server didn't send a sign-in token.`);
          await writeAccount(r.token, r.user || null);
          meCache = null;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE(`Signed in to ${BRAND.name}. You can close this tab.`));
          resolve(account({ fresh: true }));
        },
        (err) => {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE(`Signing in didn't work. Go back to ${BRAND.name} and try again.`));
          reject(err);
        },
      );
    });
    server.on("error", reject);
    // Bind first: the port goes in the URL. 127.0.0.1 literally, never localhost or 0.0.0.0.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const url = `${hostingBase()}/auth/desktop?port=${port}&state=${encodeURIComponent(state)}`;
      Promise.resolve(openExternal(url)).catch(reject);
    });
    timer = setTimeout(() => reject(hostingError("Signing in took too long. Try again.")), SIGN_IN_TIMEOUT_MS);
  }).finally(() => {
    clearTimeout(timer);
    server?.close();
    server?.closeAllConnections?.();
    pending = null;
  });
  pending = { promise, cancel: () => settle.reject(hostingError("Sign-in cancelled.", { code: "cancelled" })) };
  return promise;
}

export function cancelSignIn() {
  if (!pending) return false;
  pending.cancel();
  return true;
}

export async function signOut() {
  const acct = await readAccount();
  if (acct) await api("POST", "/api/desktop/logout", { token: acct.token }).catch(() => {});
  forgetAccount();
  return account();
}

/* ------------------------------------------------------------------ the quire target */

/** Every file under `dir`, as [relative path with /, absolute path], sorted. */
function siteFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push([r, path.join(dir, r)]);
    }
  };
  walk("");
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

const MB = 1024 * 1024;
/** docs/hosting-api.md, for when the account's own limits can't be read. */
const DEFAULT_LIMITS = { filesPerSite: 1000, bytesPerSite: 25 * MB };

/** Throw a plain sentence when a site this size can't be uploaded. `noun`: "page" or "folder". */
export async function assertSiteFits({ noun, files, bytes }) {
  const acct = await account().catch(() => null);
  const limits = { ...DEFAULT_LIMITS, ...acct?.limits };
  // The same `code` as the server's refusal, so the window can offer an upgrade.
  const plan = acct?.plan || null;
  if (files > limits.filesPerSite) {
    throw hostingError(`This ${noun} has ${files} files; a ${BRAND.name} site can have ${limits.filesPerSite}.`, { code: "plan_limit", limit: "filesPerSite", plan });
  }
  if (bytes > limits.bytesPerSite) {
    throw hostingError(`This ${noun} is ${(bytes / MB).toFixed(1)} MB; a ${BRAND.name} site can be ${Math.round(limits.bytesPerSite / MB)} MB.`, { code: "plan_limit", limit: "bytesPerSite", plan });
  }
}

/**
 * Upload a staged folder as a site: check it fits, make the site unless `slug` names one, and
 * start over with a new site if that one was removed on the server. Returns {slug, url, version, output}.
 */
export async function uploadSite(site, { acct, title, slug: prevSlug = null, noun }) {
  const files = siteFiles(site);
  let bytes = 0;
  for (const [, abs] of files) bytes += (await fs.promises.stat(abs)).size;
  await assertSiteFits({ noun, files: files.length, bytes });

  const log = [];
  const create = async () => {
    const r = await api("POST", "/api/sites", { token: acct.token, json: { title } });
    log.push(`Created ${r.url}`);
    return r.slug;
  };
  const upload = async (slug) => {
    const form = new FormData();
    for (const [rel, abs] of files) form.append("file", new Blob([await fs.promises.readFile(abs)]), rel);
    return api("PUT", `/api/sites/${encodeURIComponent(slug)}`, { token: acct.token, body: form });
  };

  let slug = prevSlug || (await create());
  let r;
  try {
    r = await upload(slug);
  } catch (err) {
    // The site was removed on the server (another Mac, the website): start a new one.
    if (err.status !== 404 || !prevSlug) throw err;
    slug = await create();
    r = await upload(slug);
  }
  log.push(`Uploaded ${r.files ?? files.length} files (${((r.bytes ?? bytes) / MB).toFixed(2)} MB) to ${r.url}`);
  meCache = null;
  return { slug: r.slug || slug, url: r.url || `https://${siteHost(slug)}/`, version: r.version ?? null, output: log.join("\n") };
}

/**
 * Build, stage and upload the page to managed hosting. The first publish creates the site
 * (POST /api/sites); later ones reuse the slug in `public`. Returns {public, output}.
 */
export async function publishToQuire(vault, pagePath, { env }) {
  const acct = await authed();
  const node = findPage(vault, pagePath);
  if (node.build) {
    const b = await runBuild(node.dir, { env });
    if (!b.ok) throw Object.assign(new Error("The build failed, so nothing was published."), { output: b.output });
  }
  const fingerprint = await publishFingerprintAsync(node.dir);
  const prev = (readManifest(node.dir) || {}).public || {};
  const { site } = await stageSite(node, { badge: true });
  const r = await uploadSite(site, {
    acct,
    title: node.title || node.path.split("/").pop(),
    slug: prev.host === "quire" && prev.slug ? prev.slug : null,
    noun: "page",
  });

  const record = {
    host: "quire",
    slug: r.slug,
    url: r.url,
    version: r.version,
    publishedAt: new Date().toISOString(),
    fingerprint,
  };
  const m = readManifest(node.dir) || {};
  writeManifest(node.dir, { ...m, public: record });
  return { public: record, output: r.output };
}

/** Delete a site on the server (gone already counts). */
export async function deleteSite(slug) {
  const acct = await authed();
  try {
    await api("DELETE", `/api/sites/${encodeURIComponent(slug)}`, { token: acct.token });
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  meCache = null;
}

/** Remove the page's site from managed hosting (gone already counts) and forget it. */
export async function unpublishFromQuire(vault, pagePath) {
  const node = findPage(vault, pagePath);
  const m = readManifest(node.dir) || {};
  const slug = m.public?.host === "quire" ? m.public.slug : null;
  if (slug) await deleteSite(slug);
  delete m.public;
  writeManifest(node.dir, m);
  return null;
}
