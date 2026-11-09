// A fake hosting server (docs/hosting-api.md) on 127.0.0.1, for scripts/smoke-hosting.mjs,
// scripts/smoke-billing.mjs and screenshots. Everything is in memory. `node
// scripts/fakes/hosting-server.mjs [free|pro]` runs one and prints its URL.
//
// Plans and billing: GET /api/billing, POST /api/billing/checkout and /portal (fake Stripe URLs;
// `completeCheckout(item)` stands in for the webhook), GET /api/ai/status with credits, and
// POST /api/ai/v1/messages answering 429 noteblock_ai_credits once the credits are spent (any
// other model call is a 500: the AI smoke has its own fake for those).
import http from "node:http";
import crypto from "node:crypto";
import { BRAND, pageHost } from "../../core/brand.mjs";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(BRAND.reservedSlugs);
const MB = 1024 * 1024;
const LIMITS = {
  free: { sites: 3, bytesPerSite: 25 * MB, bytesTotal: 75 * MB, filesPerSite: 1000, uploadsPerHour: 60 },
  pro: { sites: 1000, bytesPerSite: 50 * MB, bytesTotal: 5 * 1024 * MB, filesPerSite: 5000, uploadsPerHour: 300 },
};
const PLANS = {
  free: { ...LIMITS.free, credits: 25 },
  pro: { ...LIMITS.pro, credits: 250, priceMonthCents: 700, priceYearCents: 6000 },
};
const PACKS = [
  { id: "credits-350", credits: 350, priceCents: 500 },
  { id: "credits-1500", credits: 1500, priceCents: 2000 },
];
const ITEMS = ["pro-month", "pro-year", ...PACKS.map((p) => p.id)];
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {{sitesLimit?: number, plan?: "free"|"pro", creditsUsed?: number, purchased?: number, user?: object}} opts
 * sitesLimit overrides the plan's site count (smoke-hosting runs with 10).
 */
export function startFakeHosting({ sitesLimit, plan = "free", creditsUsed = 0, purchased = 0, user = { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: null } } = {}) {
  const codes = new Map(); // code → true
  const tokens = new Set();
  const sites = new Map(); // slug → {title, files: [{name, size}], version}
  const log = []; // every request: {method, path, auth}
  // The account's plan and credits; tests change these directly or through completeCheckout().
  const billing = { plan, interval: plan === "pro" ? "year" : null, cancelAtPeriodEnd: false, creditsUsed, purchased, customer: plan === "pro", checkouts: [] };
  const limitsOf = () => ({ ...LIMITS[billing.plan], ...(sitesLimit != null ? { sites: sitesLimit } : {}) });
  const credits = () => {
    const monthly = PLANS[billing.plan].credits;
    const monthlyLeft = round2(Math.max(0, monthly - billing.creditsUsed));
    const now = new Date();
    return { monthly, usedThisMonth: billing.creditsUsed, monthlyLeft, purchased: billing.purchased, left: round2(monthlyLeft + billing.purchased), resetsAt: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) };
  };
  const planOf = () =>
    billing.plan === "pro"
      ? { id: "pro", interval: billing.interval, status: "active", renewsAt: Date.UTC(new Date().getUTCFullYear() + 1, 0, 1), cancelAtPeriodEnd: billing.cancelAtPeriodEnd }
      : { id: "free", interval: null, status: null, renewsAt: null, cancelAtPeriodEnd: false };
  /** The webhook's half of a checkout: Pro starts, or a pack's credits are added. */
  const completeCheckout = (item) => {
    billing.customer = true;
    if (item.startsWith("pro-")) {
      billing.plan = "pro";
      billing.interval = item === "pro-year" ? "year" : "month";
    } else {
      billing.purchased += PACKS.find((p) => p.id === item)?.credits || 0;
    }
  };
  const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const urlOf = (slug) => `https://${pageHost(slug)}/`;
  const derive = (title) => {
    let base = String(title || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
    if (base.length < 3) base = (base + "-page").replace(/^-/, "");
    let s = base;
    for (let i = 2; sites.has(s) || RESERVED.has(s); i++) s = `${base}-${i}`;
    return s;
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
    log.push({ method: req.method, path: u.pathname, auth: !!auth });
    const authed = tokens.has(auth);

    // The browser half: the real page asks "Sign in as …?" and a Continue button POSTs; here the
    // GET stands in for both (a test is the person pressing Continue).
    if (req.method === "GET" && u.pathname === "/auth/desktop") {
      const port = Number(u.searchParams.get("port"));
      const state = u.searchParams.get("state");
      if (!(port >= 1024 && port <= 65535) || !state) return json(res, 400, { error: "Bad sign-in link." });
      const code = crypto.randomBytes(12).toString("hex");
      codes.set(code, true);
      res.writeHead(302, { location: `http://127.0.0.1:${port}/callback?code=${code}&state=${encodeURIComponent(state)}` }).end();
      return;
    }
    if (req.method === "POST" && u.pathname === "/api/desktop/token") {
      const { code } = JSON.parse(body.toString() || "{}");
      if (!codes.delete(code)) return json(res, 400, { error: "That sign-in code expired. Try again." });
      const token = "qt_" + crypto.randomBytes(16).toString("hex");
      tokens.add(token);
      return json(res, 200, { token, user });
    }
    if (!u.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found." });
    if (!authed) return json(res, 401, { error: `Sign in to ${BRAND.name} to publish.` });

    if (req.method === "POST" && u.pathname === "/api/desktop/logout") {
      tokens.delete(auth);
      return json(res, 200, { ok: true });
    }
    const usage = () => ({ sites: sites.size, bytes: [...sites.values()].reduce((n, s) => n + s.files.reduce((m, f) => m + f.size, 0), 0) });
    if (req.method === "GET" && u.pathname === "/api/me") {
      return json(res, 200, { user, plan: billing.plan, usage: usage(), limits: limitsOf() });
    }
    if (req.method === "GET" && u.pathname === "/api/billing") {
      return json(res, 200, { plan: planOf(), credits: credits(), usage: usage(), limits: limitsOf(), plans: PLANS, packs: PACKS });
    }
    if (req.method === "POST" && u.pathname === "/api/billing/checkout") {
      const { item } = JSON.parse(body.toString() || "{}");
      if (!ITEMS.includes(item)) return json(res, 400, { error: "Unknown item." });
      if (item.startsWith("pro-") && billing.plan === "pro") return json(res, 409, { error: "You're already on Pro. Use Manage billing to switch." });
      billing.checkouts.push(item);
      return json(res, 200, { url: `https://checkout.stripe.com/c/pay/cs_test_${item}` });
    }
    if (req.method === "POST" && u.pathname === "/api/billing/portal") {
      if (!billing.customer) return json(res, 409, { error: "Nothing to manage yet." });
      return json(res, 200, { url: "https://billing.stripe.com/p/session/test_fake" });
    }
    if (req.method === "GET" && u.pathname === "/api/ai/status") {
      const c = credits();
      return json(res, 200, { enabled: c.left > 0, model: "claude-haiku-5-5", buildModel: null, spentTodayCents: 0, limitCents: 0, plan: billing.plan, credits: { left: c.left, monthlyLeft: c.monthlyLeft, purchased: c.purchased, monthly: c.monthly } });
    }
    if (req.method === "POST" && u.pathname === "/api/ai/v1/messages") {
      const err = (status, type, message) => res.writeHead(status, { "content-type": "application/json", "x-should-retry": "false" }).end(JSON.stringify({ type: "error", error: { type, message } }));
      if (credits().left <= 0) return err(429, "noteblock_ai_credits", "You're out of Noteblock AI credits.");
      return err(500, "api_error", "The fake hosting server doesn't run models.");
    }
    if (req.method === "GET" && u.pathname === "/api/sites") {
      return json(res, 200, { sites: [...sites].map(([slug, s]) => ({ slug, url: urlOf(slug), title: s.title, files: s.files.length })) });
    }
    if (req.method === "POST" && u.pathname === "/api/sites") {
      const max = limitsOf().sites;
      if (sites.size >= max) return json(res, 403, { error: `You've used all ${max} sites. Unpublish one to publish this page.`, code: "plan_limit", limit: "sites" });
      const { title, slug: want } = JSON.parse(body.toString() || "{}");
      if (want && (!SLUG.test(want) || want.includes("--") || RESERVED.has(want))) return json(res, 400, { error: "That name can't be used for a site." });
      const slug = want && !sites.has(want) ? want : derive(title);
      sites.set(slug, { title, files: [], version: 0 });
      return json(res, 200, { slug, url: urlOf(slug) });
    }
    const m = /^\/api\/sites\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      const site = sites.get(slug);
      if (!site) return json(res, 404, { error: "No such site." });
      if (req.method === "DELETE") {
        sites.delete(slug);
        return json(res, 200, { ok: true });
      }
      if (req.method === "PUT") {
        const form = await new Response(body, { headers: { "content-type": req.headers["content-type"] || "" } }).formData();
        const files = form.getAll("file").map((f) => ({ name: f.name, size: f.size }));
        site.files = files;
        site.version += 1;
        const bytes = files.reduce((n, f) => n + f.size, 0);
        return json(res, 200, { slug, url: urlOf(slug), version: site.version, bytes, files: files.length });
      }
    }
    return json(res, 404, { error: "Not found." });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, sites, tokens, log, billing, completeCheckout, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFakeHosting({ plan: process.argv[2] === "pro" ? "pro" : "free" });
  console.log(s.url);
}
