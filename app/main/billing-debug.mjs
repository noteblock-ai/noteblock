// Debug rows in Settings (dev and Next builds only, see ipc.mjs quire:debugBilling): show the Plan
// section and Noteblock AI with made-up billing data instead of the account's. The mode lives in
// memory only, so quitting the app (or "Use real data") ends it, and nothing is written anywhere:
// billing() and ai.status() read it, and checkout/portal refuse to open Stripe while it is on.
// The numbers follow docs/hosting-api.md "Plans and billing (Pro)".

/** null | "free" | "pro" | "credits" (out of credits, on Free). */
let mode = null;

export function billingFake() {
  return mode;
}

export function setBillingFake(next) {
  mode = next === "free" || next === "pro" || next === "credits" ? next : null;
  return mode;
}

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

/** The first of next month (UTC), as GET /api/billing's resetsAt. */
function nextMonth(now = new Date()) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/** GET /api/billing's body for a fake mode. */
export function fakeBilling(m = mode) {
  const pro = m === "pro";
  const monthly = pro ? 250 : 25;
  const used = pro ? 12.4 : m === "credits" ? 25 : 6.5;
  const purchased = pro ? 350 : 0;
  const monthlyLeft = Math.max(0, Math.round((monthly - used) * 100) / 100);
  return {
    plan: pro
      ? { id: "pro", interval: "year", status: "active", renewsAt: Date.UTC(new Date().getUTCFullYear() + 1, 0, 1), cancelAtPeriodEnd: false }
      : { id: "free", interval: null, status: null, renewsAt: null, cancelAtPeriodEnd: false },
    credits: { monthly, usedThisMonth: used, monthlyLeft, purchased, left: monthlyLeft + purchased, resetsAt: nextMonth() },
    usage: pro ? { sites: 7, bytes: 18.2 * MB } : { sites: 2, bytes: 3.4 * MB },
    limits: pro ? LIMITS.pro : LIMITS.free,
    plans: PLANS,
    packs: PACKS,
  };
}

/** GET /api/ai/status's `credits` and `plan` for a fake mode. */
export function fakeAiCredits(m = mode) {
  const b = fakeBilling(m);
  return { plan: b.plan.id, credits: { left: b.credits.left, monthlyLeft: b.credits.monthlyLeft, purchased: b.credits.purchased, monthly: b.credits.monthly } };
}
