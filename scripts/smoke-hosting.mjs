// Hosting smoke: against a fake hosting server (scripts/fakes/hosting-server.mjs) and a fake
// wrangler, sign in through the loopback handoff, publish a page to Quire (multipart with
// index.html and the _quire/ runtime), publish again on the same slug, unpublish, treat an old
// `public` record (no host) as cloudflare, move a page between hosts, and sign out. Also the
// window's rule for when Publish asks to sign in to Quire first (publishPlan.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startFakeHosting } from "./fakes/hosting-server.mjs";
import { BRAND, pageHost } from "../core/brand.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-hosting-"));
const fake = await startFakeHosting({ sitesLimit: 10 });
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");
process.env.QUIRE_HOSTING_URL = fake.url;
process.env.QUIRE_WRANGLER = path.join(here, "fakes", "wrangler.mjs");
process.env.FAKE_WRANGLER_LOGGED_IN = "1";

const { createVault, createPage, readManifest, writeManifest, findPage } = await import("../core/index.mjs");
const hosting = await import("../app/main/hosting.mjs");
const { publishPage, unpublishPage, publishStatus } = await import("../app/main/publish.mjs");
const { publishStep } = await import("../app/renderer/src/publishPlan.mjs");

// Plain Node has no safeStorage; a stand-in cipher proves the token never lands in plain text.
hosting.setTokenCipher({
  encrypt: (s) => Buffer.from(s, "utf8").map((b) => b ^ 0x5a),
  decrypt: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString("utf8"),
});

const env = { ...process.env };
const vault = createVault(path.join(tmp, "Vault"), { name: "Vault", seed: false });
createPage(vault, "Trip budget");
const page = "Trip budget";
const manifest = () => readManifest(findPage(vault, page).dir) || {};

try {
  // The window's sign-in gate: only work that touches Quire's hosting asks for the account.
  const out = { quireSignedIn: false, cloudflare: true };
  const ok = { quireSignedIn: true, cloudflare: true };
  const onQuire = { host: "quire", slug: "x" };
  const onCf = { host: "cloudflare", worker: "w" };
  assert.equal(publishStep({ host: "quire", targets: out }), "signin");
  assert.equal(publishStep({ host: null, targets: out }), "signin"); // nothing live: Quire
  assert.equal(publishStep({ host: "cloudflare", targets: out }), "go"); // self-publish, no Quire prompt
  assert.equal(publishStep({ host: null, live: onCf, targets: out }), "go"); // Update on Cloudflare
  assert.equal(publishStep({ kind: "unpublish", live: onCf, targets: out }), "go");
  assert.equal(publishStep({ host: null, live: onQuire, targets: out }), "signin"); // Update on Quire
  assert.equal(publishStep({ host: "cloudflare", live: onQuire, targets: out }), "signin"); // move off Quire
  assert.equal(publishStep({ kind: "unpublish", live: onQuire, targets: out }), "signin");
  assert.equal(publishStep({ host: "quire", targets: ok }), "go");
  assert.equal(publishStep({ host: "quire", targets: null }), "go"); // not loaded: main's check decides

  // Signed out: publishing to Quire says so in a plain sentence.
  assert.equal((await hosting.account()).signedIn, false);
  await assert.rejects(publishPage(vault, page, { env, host: "quire" }), new RegExp(`Sign in to ${BRAND.name} to publish`));

  // Sign in: the "browser" follows the server's redirect to our loopback callback.
  let opened = null;
  const acct = await hosting.signIn({
    openExternal: async (url) => {
      opened = new URL(url);
      const r = await fetch(url); // follows the 302 to http://127.0.0.1:<port>/callback
      assert.equal(r.status, 200);
    },
  });
  assert.equal(opened.pathname, "/auth/desktop");
  assert.ok(Number(opened.searchParams.get("port")) > 1024);
  assert.ok(opened.searchParams.get("state").length >= 20);
  assert.equal(acct.signedIn, true);
  assert.equal(acct.user.email, "ada@example.com");
  assert.deepEqual(acct.limits.sites, 10);
  const stored = fs.readFileSync(path.join(tmp, "config", "hosting.json"), "utf8");
  const token = [...fake.tokens][0];
  assert.ok(!stored.includes(token), "token stored in plain text");
  assert.ok(!fs.existsSync(path.join(tmp, "config", "config.json")) || !fs.readFileSync(path.join(tmp, "config", "config.json"), "utf8").includes(token));

  // A callback with the wrong state is refused, and the listener is gone once signed in.
  const p2 = hosting.signIn({
    openExternal: async (url) => {
      const port = new URL(url).searchParams.get("port");
      const bad = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=wrong`);
      assert.equal(bad.status, 400);
      hosting.cancelSignIn();
    },
  });
  await assert.rejects(p2, /cancelled/);

  // Publish to Quire.
  const first = await publishPage(vault, page, { env, host: "quire" });
  const pub = manifest().public;
  assert.equal(pub.host, "quire");
  assert.equal(pub.slug, "trip-budget");
  assert.equal(pub.url, `https://${pageHost("trip-budget")}/`);
  assert.equal(first.public.url, pub.url);
  const files = fake.sites.get("trip-budget").files.map((f) => f.name);
  assert.ok(files.includes("index.html"), files.join(", "));
  assert.ok(files.includes("_quire/runtime.js"), files.join(", "));
  assert.ok(files.includes("_quire/theme.css"), files.join(", "));
  assert.ok(!files.some((f) => f.startsWith(".") || f.includes("/.")), "dotfiles uploaded");
  assert.equal(publishStatus(vault, page).upToDate, true);
  assert.equal((await hosting.account({ fresh: true })).usage.sites, 1);

  // Publish again: same slug, no new site, new version.
  const creates = () => fake.log.filter((r) => r.method === "POST" && r.path === "/api/sites").length;
  const before = creates();
  fs.appendFileSync(path.join(findPage(vault, page).dir, "index.html"), "<p>More</p>\n");
  assert.equal(publishStatus(vault, page).upToDate, false);
  await publishPage(vault, page, { env }); // no host: stays where it's live
  assert.equal(creates(), before);
  assert.equal(manifest().public.slug, "trip-budget");
  assert.equal(manifest().public.version, 2);
  assert.equal(fake.sites.size, 1);

  // Unpublish removes the site and the record.
  await unpublishPage(vault, page, { env });
  assert.equal(fake.sites.size, 0);
  assert.equal(manifest().public, undefined);

  // An old record (from before hosts) is a cloudflare one, with a dashboard link.
  const m = manifest();
  writeManifest(findPage(vault, page).dir, { ...m, public: { url: "https://quire-trip-budget.ada.workers.dev", worker: "quire-trip-budget", publishedAt: "2026-10-01T00:00:00Z", fingerprint: "x" } });
  const old = publishStatus(vault, page).public;
  assert.equal(old.host, "cloudflare");
  assert.match(old.dashboardUrl, /^https:\/\/dash\.cloudflare\.com\/\?to=\/:account\/workers\/services\/view\/quire-trip-budget\/production$/);
  // Update keeps it on Cloudflare, and records the account's dashboard URL.
  await publishPage(vault, page, { env });
  assert.equal(manifest().public.host, "cloudflare");
  assert.equal(manifest().public.dashboardUrl, "https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/services/view/quire-trip-budget/production");
  assert.equal(fake.sites.size, 0);

  // Moving to Quire takes it off Cloudflare first, then makes a site.
  await publishPage(vault, page, { env, host: "quire" });
  assert.equal(manifest().public.host, "quire");
  assert.equal(manifest().public.worker, undefined);
  assert.equal(fake.sites.size, 1);

  // A site removed on the server: the next publish makes a new one.
  fake.sites.clear();
  await publishPage(vault, page, { env });
  assert.equal(fake.sites.size, 1);
  assert.equal(manifest().public.host, "quire");

  // The server's sentence comes through as is (here: out of sites).
  createPage(vault, "Second");
  for (let i = 0; i < 9; i++) fake.sites.set("filler-" + i, { title: "f", files: [], version: 1 });
  await assert.rejects(publishPage(vault, "Second", { env, host: "quire" }), /You've used all 10 sites/);

  // A token the keychain can no longer decrypt (the app's keychain item changed) reads as signed
  // out, never an error, and signing in again replaces it.
  const good = { encrypt: (s) => Buffer.from(s, "utf8").map((b) => b ^ 0x5a), decrypt: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString("utf8") };
  hosting.setTokenCipher({ ...good, decrypt: () => { throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString."); } });
  const lost = await hosting.account({ fresh: true });
  assert.equal(lost.signedIn, false);
  await assert.rejects(publishPage(vault, page, { env, host: "quire" }), new RegExp(`Sign in to ${BRAND.name} to publish`));
  hosting.setTokenCipher(good);
  const again = await hosting.signIn({ openExternal: async (url) => assert.equal((await fetch(url)).status, 200) });
  assert.equal(again.signedIn, true);

  // Sign out revokes the token and forgets it.
  await hosting.signOut();
  assert.equal(fake.tokens.size, 1); // the one from before the keychain change was never revoked
  assert.equal(fs.existsSync(path.join(tmp, "config", "hosting.json")), false);
  assert.equal((await hosting.account()).signedIn, false);
  console.log("hosting smoke ok");
} finally {
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
