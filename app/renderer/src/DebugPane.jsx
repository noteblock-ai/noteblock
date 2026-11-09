// Settings → Debug: dev and Next builds only (getState().debug, never a release build). One row per
// flow that's hard to reach for real. Billing rows switch the main process to made-up data held in
// memory (app/main/billing-debug.mjs): nothing is written to the account, the vault or the config,
// and checkout never opens Stripe. "Use real data" (or quitting) ends it.
import { useEffect, useState } from "react";

const clean = (e) => String(e?.message || e || "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export default function DebugPane({ api, page, onOpenTab, onOpenAi, onClose }) {
  const [mode, setMode] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.billing?.().then((b) => setMode(b?.fake || null), () => {});
  }, [api]);

  const run = async (fn) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(clean(e));
    }
  };
  const fake = (next) => api.debugBilling(next).then((m) => setMode(m || null));

  const rows = [
    ["Plan as Free", "Settings › Plan with 25 credits and 2 of 3 sites", () => fake("free").then(() => onOpenTab("plan"))],
    ["Plan as Pro", "Yearly, with bought credits", () => fake("pro").then(() => onOpenTab("plan"))],
    ["AI out of credits", "Opens Noteblock AI with no credits left", () => fake("credits").then(() => onOpenAi())],
    [
      "Plan limit on publish",
      page ? `The error bar on ${page.title || page.path}` : "Open a page first",
      () => api.debugPublishError(page.path).then(() => onClose()),
      !page,
    ],
  ];

  return (
    <>
      <div className="activity-section-head">
        <span className="vault-field-label">Billing</span>
      </div>
      <div className="editor-list pub-list">
        {rows.map(([label, sub, fn, disabled]) => (
          <div className="editor-row" key={label}>
            <div className="editor-label">
              {label}
              <span className="editor-sub">{sub}</span>
            </div>
            <button type="button" className="settings-button" disabled={!!disabled} onClick={() => run(fn)}>
              Show
            </button>
          </div>
        ))}
        <div className="editor-row">
          <div className="editor-label">
            Use real data
            <span className="editor-sub">{mode ? `Showing debug data (${mode})` : "Showing real data"}</span>
          </div>
          <button type="button" className="settings-button" disabled={!mode} onClick={() => run(() => fake(null))}>
            Reset
          </button>
        </div>
      </div>
      <p className="settings-error pub-error" role="alert">{error}</p>
    </>
  );
}
