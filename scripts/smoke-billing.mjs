// Plans and billing smoke (docs/hosting-api.md "Plans and billing (Pro)"): plain Node, no
// Electron, against the fake hosting server (scripts/fakes/hosting-server.mjs) and the real IPC
// handlers (app/main/ipc.mjs) on a stand-in ipcMain. Covers: billing() signed out and in; the plan
// on /api/me; checkout opening Stripe's URL in the browser, an unknown item, buying Pro twice
// (409), the portal before and after there's a customer; the debug modes (made-up data, Stripe
// never opened, ai.status faked) and their refusal outside dev/Next; ai.status credits and the
// noteblock_ai_credits error → code "credits"; a publish over the site limit → publish-status
// with code "plan_limit" and an upgrade offer (none on Pro), and the local per-site size check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startFakeHosting } from "./fakes/hosting-server.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-billing-"));
// Before core is imported: config writes must never reach ~/.noteblock.
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");
const fake = await startFakeHosting({ plan: "free" });
process.env.QUIRE_HOSTING_URL = fake.url;

const { createVault, createPage } = await import("../core/index.mjs");
const hosting = await import("../app/main/hosting.mjs");
const { createAi } = await import("../app/main/ai.mjs");
const { registerIpc } = await import("../app/main/ipc.mjs");
const { setBillingFake } = await import("../app/main/billing-debug.mjs");
const { flushAutosavesAsync } = await import("../app/main/autosave.mjs");

hosting.setTokenCipher({
  encrypt: (s) => Buffer.from(s, "utf8").map((b) => b ^ 0x5a),
  decrypt: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString("utf8"),
});

const vault = createVault(path.join(tmp, "Vault"), { name: "Vault", seed: false });
for (const t of ["One", "Two", "Three", "Four"]) createPage(vault, t);

// The IPC layer on a stand-in ipcMain and window: handlers by channel, sent messages in a list.
const handlers = new Map();
const sent = [];
const opened = [];
const win = { isDestroyed: () => false, webContents: { send: (channel, msg) => sent.push({ channel, msg }) } };
const makeCtx = (extra) => ({
  dialog: {},
  getVault: () => vault,
  setVault: () => {},
  getWindow: () => win,
  shell: { openExternal: async (url) => opened.push(url) },
  ...extra,
});
registerIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, makeCtx({ dev: "billing-app" }));
const call = async (channel, ...args) => {
  const r = await handlers.get(channel)(null, ...args);
  if (r && "error" in r) throw new Error(r.error);
  return r.ok;
};
// A release build: no dev label, not Next.
const releaseHandlers = new Map();
registerIpc({ handle: (channel, fn) => releaseHandlers.set(channel, fn) }, makeCtx({}));

async function waitFor(pred, what, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    const hit = sent.find(pred);
    if (hit) return hit.msg;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}; sent: ${JSON.stringify(sent.map((s) => [s.channel, s.msg?.state]))}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

try {
  /* ---- signed out */
  assert.deepEqual(await call("quire:billing"), { signedIn: false });
  await assert.rejects(call("quire:billingCheckout", "pro-year"), /Sign in/);

  /* ---- sign in; the plan comes back on /api/me and /api/billing */
  await hosting.signIn({ openExternal: async (url) => assert.equal((await fetch(url)).status, 200) });
  const acct = await hosting.account({ fresh: true });
  assert.equal(acct.plan, "free");
  assert.equal(acct.limits.sites, 3);
  assert.equal(acct.limits.bytesTotal, 75 * 1024 * 1024);

  const b = await call("quire:billing");
  assert.equal(b.signedIn, true);
  assert.equal(b.fake, undefined);
  assert.deepEqual(b.plan, { id: "free", interval: null, status: null, renewsAt: null, cancelAtPeriodEnd: false });
  assert.equal(b.credits.monthly, 25);
  assert.equal(b.credits.left, 25);
  assert.equal(b.plans.pro.priceYearCents, 6000);
  assert.equal(b.plans.pro.priceMonthCents, 700);
  assert.deepEqual(b.packs.map((p) => p.id), ["credits-350", "credits-1500"]);

  /* ---- checkout and the portal open Stripe in the browser */
  await assert.rejects(call("quire:billingPortal"), /Nothing to manage yet/); // 409: no customer yet
  assert.equal(opened.length, 0);
  await assert.rejects(call("quire:billingCheckout", "pro-forever"), /Unknown item/);
  assert.deepEqual(await call("quire:billingCheckout", "pro-year"), { url: "https://checkout.stripe.com/c/pay/cs_test_pro-year" });
  assert.deepEqual(opened, ["https://checkout.stripe.com/c/pay/cs_test_pro-year"]);
  assert.deepEqual(fake.billing.checkouts, ["pro-year"]);
  fake.completeCheckout("pro-year"); // the webhook
  const pro = await call("quire:billing");
  assert.equal(pro.plan.id, "pro");
  assert.equal(pro.plan.interval, "year");
  assert.ok(pro.plan.renewsAt > Date.now());
  assert.equal(pro.credits.monthly, 250);
  assert.equal(pro.limits.sites, 1000);
  await assert.rejects(call("quire:billingCheckout", "pro-month"), /already on Pro/); // 409
  assert.equal(opened.length, 1);
  await call("quire:billingCheckout", "credits-350");
  fake.completeCheckout("credits-350");
  assert.equal((await call("quire:billing")).credits.purchased, 350);
  assert.deepEqual(await call("quire:billingPortal"), { url: "https://billing.stripe.com/p/session/test_fake" });
  assert.equal(opened.at(-1), "https://billing.stripe.com/p/session/test_fake");

  /* ---- Noteblock AI: credits in the status, and the out-of-credits error */
  const events = [];
  const ai = createAi({ getVault: () => vault, send: (e) => events.push(e) });
  let st = await ai.status();
  assert.equal(st.plan, "pro");
  assert.deepEqual(st.credits, { left: 600, monthlyLeft: 250, purchased: 350, monthly: 250 });
  assert.equal(st.enabled, true);

  Object.assign(fake.billing, { plan: "free", interval: null, creditsUsed: 25, purchased: 0 });
  st = await ai.status();
  assert.equal(st.enabled, false);
  assert.equal(st.credits.left, 0);
  assert.equal(st.plan, "free");
  const job = await ai.start({ target: "chat", page: "One", prompt: "make a table" });
  const until = Date.now() + 10_000;
  let end;
  while (!(end = events.find((e) => e.jobId === job.jobId && ["ready", "error", "stopped"].includes(e.type)))) {
    if (Date.now() > until) throw new Error("AI job never ended: " + JSON.stringify(events.map((e) => e.type)));
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(end.type, "error");
  assert.equal(end.code, "credits");
  assert.equal(end.message, "You're out of Noteblock AI credits.");

  /* ---- debug modes: made-up data in memory, Stripe never opened, release builds refuse */
  await assert.rejects(
    (async () => {
      const r = await releaseHandlers.get("quire:debugBilling")(null, "pro");
      if (r.error) throw new Error(r.error);
    })(),
    /only in dev and Next/,
  );
  assert.equal(await call("quire:debugBilling", "pro"), "pro");
  const fakePro = await call("quire:billing");
  assert.equal(fakePro.fake, "pro");
  assert.equal(fakePro.plan.id, "pro");
  assert.equal(fakePro.credits.purchased, 350);
  const before = fake.log.length;
  await assert.rejects(call("quire:billingCheckout", "credits-350"), /Debug data is on/);
  await assert.rejects(call("quire:billingPortal"), /Debug data is on/);
  assert.equal(fake.log.length, before, "debug mode reached the server");
  assert.equal(opened.length, 3);
  assert.equal(await call("quire:debugBilling", "credits"), "credits");
  st = await ai.status();
  assert.equal(st.credits.left, 0);
  assert.equal(st.enabled, false);
  assert.equal(await call("quire:debugBilling", "free"), "free");
  assert.equal((await call("quire:billing")).credits.left, 18.5);
  assert.equal(await call("quire:debugBilling", null), null);
  assert.equal((await call("quire:billing")).fake, undefined);

  /* ---- publishing over the plan's site limit */
  for (const page of ["One", "Two", "Three"]) {
    await call("quire:publish", page, "quire");
    await waitFor((s) => s.channel === "publish-status" && s.msg.path === page && ["done", "error"].includes(s.msg.state), `${page} published`);
    assert.equal(sent.findLast((s) => s.msg?.path === page).msg.state, "done");
  }
  await call("quire:publish", "Four", "quire");
  const refused = await waitFor((s) => s.channel === "publish-status" && s.msg.path === "Four" && s.msg.state === "error", "Four refused");
  assert.equal(refused.code, "plan_limit");
  assert.equal(refused.limit, "sites");
  assert.equal(refused.upgrade, true);
  assert.match(refused.error, /used all 3 sites/);

  // On Pro (with the site count at its limit) the error stays, the upgrade doesn't.
  Object.assign(fake.billing, { plan: "pro", interval: "month" });
  fake.sites.set("filler", { title: "x", files: [], version: 0 });
  for (let i = 0; fake.sites.size < 1000; i++) fake.sites.set(`filler-${i}`, { title: "x", files: [], version: 0 });
  await hosting.account({ fresh: true });
  sent.length = 0;
  await call("quire:publish", "Four", "quire");
  const onPro = await waitFor((s) => s.channel === "publish-status" && s.msg.path === "Four" && s.msg.state === "error", "Four refused on Pro");
  assert.equal(onPro.code, "plan_limit");
  assert.equal(onPro.upgrade, false);

  // The local per-site check carries the same code before anything is uploaded.
  await assert.rejects(hosting.assertSiteFits({ noun: "page", files: 6000, bytes: 1 }), (err) => err.code === "plan_limit" && err.limit === "filesPerSite");

  // The debug publish error goes to the window like a real one.
  sent.length = 0;
  await call("quire:debugPublishError", "One");
  assert.deepEqual(
    sent.map((s) => [s.channel, s.msg.path, s.msg.state, s.msg.code, s.msg.upgrade]),
    [["publish-status", "One", "error", "plan_limit", true]],
  );

  console.log("billing smoke ok");
} finally {
  setBillingFake(null);
  await flushAutosavesAsync().catch(() => {});
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
