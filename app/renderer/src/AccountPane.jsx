// Settings → Account: who is signed in, the plan, and signing in or out. The profile and plan
// come from GET /api/billing (api.billing()), the same call Settings → Plan makes.
import { useEffect, useRef, useState } from "react";
import { Avatar, StableLabel } from "./PublishingPane.jsx";
import { BRAND } from "../../../core/brand.mjs";

const clean = (e) => String(e?.message || e || "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export default function AccountPane({ api, onOpenTab }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(""); // "signin" | "signout" | "portal"
  const alive = useRef(true);

  const load = () =>
    api.billing().then(
      (next) => alive.current && (setInfo(next || { signedIn: false }), setError("")),
      (e) => alive.current && setError(clean(e)),
    );

  useEffect(() => {
    alive.current = true;
    load();
    window.addEventListener("focus", load);
    const off = api.onHostingChanged?.(() => load());
    return () => {
      alive.current = false;
      window.removeEventListener("focus", load);
      if (typeof off === "function") off();
    };
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (kind, fn) => {
    setBusy(kind);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (!/cancelled/i.test(clean(e))) setError(clean(e));
    } finally {
      if (alive.current) setBusy("");
      load();
    }
  };

  if (!info) return error ? <p className="settings-error" role="alert">{error}</p> : null;

  if (!info.signedIn) {
    return (
      <>
        <div className="editor-list pub-list" data-setting="account.profile">
          <div className="editor-row">
            <div className="editor-label">
              Not signed in
              <span className="editor-sub">{busy === "signin" ? "Finish signing in in your browser." : `Sign in to publish pages and use ${BRAND.name} AI.`}</span>
            </div>
            {busy === "signin" ? (
              <button type="button" className="settings-button pub-action" onClick={() => api.hostingCancelSignIn().catch(() => {}).then(() => setBusy(""))}>
                <StableLabel value="Cancel" options={["Sign in", "Cancel"]} />
              </button>
            ) : (
              <button type="button" className="settings-button is-primary pub-action" onClick={() => run("signin", () => api.hostingSignIn())}>
                <StableLabel value="Sign in" options={["Sign in", "Cancel"]} />
              </button>
            )}
          </div>
        </div>
        <p className="settings-error pub-error" role="alert">{error}</p>
      </>
    );
  }

  const user = info.user || {};
  const plan = info.plan || { id: "free" };
  const isPro = plan.id === "pro";
  const interval = plan.interval === "year" ? "Yearly" : plan.interval === "month" ? "Monthly" : "";

  return (
    <>
      <div className="editor-list pub-list" data-setting="account.profile">
        <div className="editor-row">
          <div className="pub-who">
            <Avatar user={user} />
            <div className="editor-label">
              {user.name || user.email || "Signed in"}
              {user.name && user.email ? <span className="editor-sub">{user.email}</span> : null}
            </div>
          </div>
          <button type="button" className="settings-button" disabled={!!busy || !!info.fake} onClick={() => run("signout", () => api.hostingSignOut())}>
            Sign out
          </button>
        </div>
      </div>

      <div className="activity-section-head pub-section">
        <span className="vault-field-label">Plan</span>
      </div>
      <div className="editor-list pub-list" data-setting="account.plan">
        <div className="editor-row">
          <div className="editor-label">
            {isPro ? ["Pro", interval].filter(Boolean).join(" · ") : "Free"}
            <span className="editor-sub">{busy === "portal" ? "Opening in your browser…" : isPro ? "Billing, invoices and your card are managed in the browser." : "Credits, sites and upgrading are in Plan."}</span>
          </div>
          {isPro ? (
            <button type="button" className="settings-button" disabled={!!busy || !!info.fake} onClick={() => run("portal", () => api.billingPortal())}>
              Manage billing
            </button>
          ) : (
            <button type="button" className="settings-button" onClick={() => onOpenTab?.("plan")}>
              See plans
            </button>
          )}
        </div>
      </div>
      <p className="settings-hint">
        Your sign-in comes from Google or GitHub, so change your name and picture there. To delete your account, email{" "}
        <a href="mailto:support@noteblock.ai" target="_blank" rel="noreferrer">support@noteblock.ai</a>.
      </p>
      <p className="settings-error pub-error" role="alert">{error}</p>
    </>
  );
}
