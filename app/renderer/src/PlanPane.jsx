// Settings → Plan (docs/hosting-api.md "Plans and billing (Pro)"): the plan, Noteblock AI
// credits, published sites, and buying Pro or credits. Prices, limits and packs all come from
// GET /api/billing (api.billing()); nothing here is hard-coded. Checkout and the portal open in the
// browser, so the pane reads the plan again when the window gets focus back.
import { useEffect, useRef, useState } from "react";
import { StableLabel } from "./PublishingPane.jsx";

const clean = (e) => String(e?.message || e || "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** 500 → "$5", 499 → "$4.99". */
export function money(cents) {
  const n = Math.max(0, Number(cents) || 0);
  return "$" + (n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2));
}

/** Credits as shown: whole credits, rounded down, with a thousands separator. */
export function creditCount(n) {
  return Math.floor(Math.max(0, Number(n) || 0)).toLocaleString("en-US");
}

const count = (n) => Math.max(0, Number(n) || 0).toLocaleString("en-US");

function size(bytes) {
  const mb = (Number(bytes) || 0) / (1024 * 1024);
  if (mb >= 1024) return `${Math.round((mb / 1024) * 10) / 10} GB`;
  return mb >= 10 || Number.isInteger(mb) ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

// In UTC: the server's dates are midnight UTC (credits reset on the 1st, UTC), which would read
// as the day before west of Greenwich.
const day = (ms, year = true) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });

function Meter({ value, max, label }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className="plan-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value * 100) / 100}>
      <span className={"plan-meter-fill" + (pct <= 0 ? " is-empty" : "")} style={{ width: pct + "%" }} />
    </span>
  );
}

export default function PlanPane({ api }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(""); // a checkout item, "portal" or "signin"
  const [waiting, setWaiting] = useState(""); // the item whose checkout is open in the browser
  const alive = useRef(true);

  const load = () =>
    api.billing().then(
      (next) => {
        if (!alive.current) return;
        setInfo(next || { signedIn: false });
        setError("");
      },
      (e) => alive.current && setError(clean(e)),
    );

  useEffect(() => {
    alive.current = true;
    load();
    const onFocus = () => {
      setWaiting("");
      load();
    };
    window.addEventListener("focus", onFocus);
    const off = api.onHostingChanged?.(() => load());
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
      if (typeof off === "function") off();
    };
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (kind, fn) => {
    setBusy(kind);
    setError("");
    try {
      await fn();
      setWaiting(kind);
    } catch (e) {
      const msg = clean(e);
      if (!/cancelled/i.test(msg)) setError(msg);
    } finally {
      if (alive.current) setBusy("");
    }
  };
  const buy = (item) => open(item, () => api.billingCheckout(item));

  if (!info) return error ? <p className="settings-error" role="alert">{error}</p> : null;

  if (!info.signedIn) {
    return (
      <>
        <div className="editor-list pub-list" data-setting="plan.current">
          <div className="editor-row">
            <div className="editor-label">
              Not signed in
              <span className="editor-sub">{busy === "signin" ? "Finish signing in in your browser." : "Sign in to see your plan and AI credits."}</span>
            </div>
            {busy === "signin" ? (
              <button type="button" className="settings-button pub-action" onClick={() => api.hostingCancelSignIn().catch(() => {}).then(() => setBusy(""))}>
                <StableLabel value="Cancel" options={["Sign in", "Cancel"]} />
              </button>
            ) : (
              <button
                type="button"
                className="settings-button is-primary pub-action"
                onClick={async () => {
                  setBusy("signin");
                  setError("");
                  try {
                    await api.hostingSignIn();
                  } catch (e) {
                    if (!/cancelled/i.test(clean(e))) setError(clean(e));
                  }
                  setBusy("");
                  load();
                }}
              >
                <StableLabel value="Sign in" options={["Sign in", "Cancel"]} />
              </button>
            )}
          </div>
        </div>
        <p className="settings-error pub-error" role="alert">{error}</p>
      </>
    );
  }

  const plan = info.plan || { id: "free" };
  const isPro = plan.id === "pro";
  const credits = info.credits || {};
  const pro = info.plans?.pro || null;
  const packs = Array.isArray(info.packs) ? info.packs : [];
  const usage = info.usage || {};
  const limits = info.limits || {};
  const finish = (item, text) => (waiting === item ? "Finish in your browser" : text);

  let planSub = "";
  if (isPro) {
    if (plan.status === "past_due") planSub = "Payment failed. Update your card in Manage billing.";
    else if (plan.renewsAt && (plan.cancelAtPeriodEnd || plan.status === "canceled")) planSub = `Ends ${day(plan.renewsAt)}`;
    else if (plan.renewsAt && plan.status === "trialing") planSub = `Trial ends ${day(plan.renewsAt)}`;
    else if (plan.renewsAt) planSub = `Renews ${day(plan.renewsAt)}`;
  }
  const interval = plan.interval === "year" ? "Yearly" : plan.interval === "month" ? "Monthly" : "";

  const monthlyLeft = Number(credits.monthlyLeft) || 0;
  const purchased = Number(credits.purchased) || 0;
  const creditsLabel = monthlyLeft > 0 || !purchased ? `${creditCount(monthlyLeft)} credits left this month` : "No monthly credits left";

  return (
    <>
      {info.fake ? <p className="settings-hint plan-fake">Debug data ({info.fake}). Checkout and billing don't open.</p> : null}

      <div className="activity-section-head">
        <span className="vault-field-label">Plan</span>
      </div>
      <div className="editor-list pub-list" data-setting="plan.current">
        <div className="editor-row">
          <div className="editor-label">
            {isPro ? ["Pro", interval].filter(Boolean).join(" · ") : "Free"}
            {planSub ? <span className={"editor-sub" + (plan.status === "past_due" ? " plan-warn" : "")}>{finish("portal", planSub)}</span> : waiting === "portal" ? <span className="editor-sub">Finish in your browser</span> : null}
          </div>
          {isPro ? (
            <button type="button" className="settings-button" disabled={!!busy} onClick={() => open("portal", () => api.billingPortal())}>
              Manage billing
            </button>
          ) : null}
        </div>
      </div>

      {!isPro && pro ? (
        <>
          <div className="activity-section-head pub-section" data-setting="plan.upgrade">
            <span className="vault-field-label">Upgrade to Pro</span>
          </div>
          <p className="settings-hint plan-hint">
            {count(pro.credits)} AI credits a month, {count(pro.sites)} sites, {size(pro.bytesPerSite)} per site.
          </p>
          <div className="editor-list pub-list">
            {pro.priceYearCents ? (
              <div className="editor-row">
                <div className="editor-label">
                  Yearly
                  <span className="editor-sub">{finish("pro-year", `${money(pro.priceYearCents / 12)} a month, billed ${money(pro.priceYearCents)} a year`)}</span>
                </div>
                <button type="button" className="settings-button is-primary" disabled={!!busy} onClick={() => buy("pro-year")}>
                  Upgrade
                </button>
              </div>
            ) : null}
            {pro.priceMonthCents ? (
              <div className="editor-row">
                <div className="editor-label">
                  Monthly
                  <span className="editor-sub">{finish("pro-month", `${money(pro.priceMonthCents)} a month`)}</span>
                </div>
                <button type="button" className="settings-button" disabled={!!busy} onClick={() => buy("pro-month")}>
                  Upgrade
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="activity-section-head pub-section">
        <span className="vault-field-label">AI credits</span>
      </div>
      <div className="editor-list pub-list" data-setting="plan.credits">
        <div className="editor-row">
          <div className="editor-label plan-usage">
            {creditsLabel}
            <Meter value={monthlyLeft} max={Number(credits.monthly) || 0} label="AI credits left this month" />
            <span className="editor-sub">
              {[purchased > 0 ? `${creditCount(purchased)} bought credits` : null, credits.resetsAt ? `${creditCount(credits.monthly)} more on ${day(credits.resetsAt, false)}` : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        </div>
      </div>

      {packs.length ? (
        <>
          <div className="activity-section-head pub-section" data-setting="plan.buy">
            <span className="vault-field-label">Buy credits</span>
          </div>
          <div className="editor-list pub-list">
            {packs.map((p) => (
              <div className="editor-row" key={p.id}>
                <div className="editor-label">
                  {creditCount(p.credits)} credits
                  <span className="editor-sub">{finish(p.id, money(p.priceCents))}</span>
                </div>
                <button type="button" className="settings-button" disabled={!!busy} onClick={() => buy(p.id)}>
                  Buy
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {limits.sites ? (
        <>
          <div className="activity-section-head pub-section">
            <span className="vault-field-label">Published sites</span>
          </div>
          <div className="editor-list pub-list" data-setting="plan.sites">
            <div className="editor-row">
              <div className="editor-label plan-usage">
                {count(usage.sites)} of {count(limits.sites)} sites
                <Meter value={Number(usage.sites) || 0} max={limits.sites} label="Sites used" />
                {limits.bytesTotal ? (
                  <span className="editor-sub">
                    {size(usage.bytes)} of {size(limits.bytesTotal)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : null}

      <p className="settings-error pub-error" role="alert">{error}</p>
    </>
  );
}
