import { useEffect, useState } from "react";
import { Spinner } from "./icons.jsx";
import Switch from "./Switch.jsx";
import { BRAND } from "../../../core/brand.mjs";

/** Captions stacked in one grid cell: the widest sets the size, so switching never resizes. */
export function StableLabel({ value, options }) {
  return (
    <span className="stable-label">
      {options.map((o) => (
        <span key={o} aria-hidden={o !== value} className={o === value ? "" : "is-hidden"}>
          {o}
        </span>
      ))}
    </span>
  );
}

function Avatar({ user }) {
  const [broken, setBroken] = useState(false);
  const letter = (user?.name || user?.email || "?").trim().charAt(0).toUpperCase();
  if (user?.image && !broken) return <img className="pub-avatar" src={user.image} alt="" onError={() => setBroken(true)} />;
  return (
    <span className="pub-avatar" aria-hidden="true">
      {letter}
    </span>
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Settings → Publishing: the hosting account, and publishing to your own Cloudflare. */
export default function PublishingPane({ api }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(""); // "signin" | "signout" | "cf-login" | "cf-logout" | "toggle"
  const [error, setError] = useState("");
  const [cfLog, setCfLog] = useState("");

  const load = (fresh) =>
    api.publishingInfo(fresh).then(
      (next) => {
        setInfo(next);
        if (next?.cloudflare?.loggingIn) setBusy("cf-login");
        if (next?.quire?.signingIn) setBusy("signin");
      },
      (e) => setError(String(e?.message || e)),
    );
  useEffect(() => {
    load(true);
    const offs = [
      api.onHostingChanged?.(() => load(false)),
      api.onCloudflareStatus?.((msg) => {
        if (!msg) return;
        if (msg.state === "waiting") {
          setBusy("cf-login");
          if (msg.log) setCfLog((l) => (l + msg.log).slice(-4000));
        } else {
          setBusy((b) => (b === "cf-login" ? "" : b));
          if (msg.state === "error" && !/cancelled/i.test(msg.error)) setError(msg.error);
          load(false);
        }
      }),
    ];
    return () => offs.forEach((off) => typeof off === "function" && off());
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (kind, fn) => {
    setBusy(kind);
    setError("");
    try {
      await fn();
    } catch (e) {
      const msg = String(e?.message || e);
      if (!/cancelled/i.test(msg)) setError(msg);
    } finally {
      setBusy((b) => (b === kind ? "" : b));
      load(false);
    }
  };

  if (!info) return error ? <p className="settings-error" role="alert">{error}</p> : null;
  const q = info.quire || {};
  const cf = info.cloudflare;
  const host = q.host || "your-page-quire.harborapps.org";

  return (
    <>
      <p className="settings-hint">A published page is on the web at a link anyone can open.</p>

      <div className="activity-section-head">
        <span className="vault-field-label">{BRAND.name} account</span>
      </div>
      <div className="editor-list pub-list" data-setting="publishing.account">
        {q.signedIn ? (
          <div className="editor-row">
            <div className="pub-who">
              <Avatar user={q.user} />
              <div className="editor-label">
                {q.user?.name || q.user?.email || "Signed in"}
                <span className="editor-sub">
                  {[q.user?.name ? q.user?.email : null, q.offline ? "Offline" : q.usage && q.limits ? `${q.usage.sites} of ${plural(q.limits.sites, "site", "sites")}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            </div>
            <button type="button" className="settings-button" disabled={!!busy} onClick={() => run("signout", () => api.hostingSignOut())}>
              Sign out
            </button>
          </div>
        ) : (
          <div className="editor-row">
            <div className="editor-label">
              Not signed in
              <span className="editor-sub">{busy === "signin" ? "Finish signing in in your browser." : `Pages you publish get a link like ${host}.`}</span>
            </div>
            {busy === "signin" ? (
              <button type="button" className="settings-button pub-action" onClick={() => api.hostingCancelSignIn().catch(() => {}).then(() => setBusy(""))}>
                <StableLabel value="Cancel" options={["Sign in", "Cancel"]} />
              </button>
            ) : (
              <button type="button" className="settings-button is-primary pub-action" disabled={!!busy} onClick={() => run("signin", () => api.hostingSignIn())}>
                <StableLabel value="Sign in" options={["Sign in", "Cancel"]} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="activity-section-head pub-section pub-selfhost-head" data-setting="publishing.selfhost">
        <span className="vault-field-label" id="pub-selfhost-label">
          Self-hosting
        </span>
        <Switch
          id="pub-selfhost"
          labelledBy="pub-selfhost-label"
          checked={!!info.selfHost}
          disabled={busy === "toggle"}
          onChange={(on) => {
            setInfo((i) => ({ ...i, selfHost: on }));
            run("toggle", () => api.setSelfHost(on));
          }}
        />
      </div>
      <p className="settings-hint pub-selfhost-hint">Publish to a Worker in your own Cloudflare account.</p>
      <div className={"editor-list pub-list" + (info.selfHost ? " pub-selfhost-rows" : "")} hidden={!info.selfHost}>
        {info.selfHost ? (
          <div className="editor-row" data-setting="publishing.cloudflare">
            {busy === "cf-login" ? (
              <>
                <div className="editor-label">
                  Cloudflare
                  <span className="editor-sub pub-waiting">
                    <Spinner size={12} /> Waiting for you to allow access in the browser
                  </span>
                </div>
                <button type="button" className="settings-button" onClick={() => api.cloudflareCancelLogin().catch(() => {})}>
                  Cancel
                </button>
              </>
            ) : !cf ? (
              <div className="editor-label">
                Cloudflare
                <span className="editor-sub pub-waiting">
                  <Spinner size={12} /> Checking
                </span>
              </div>
            ) : cf.loggedIn ? (
              <>
                <div className="editor-label">
                  Cloudflare
                  <span className="editor-sub">{[cf.email, cf.accounts?.[0]?.name].filter(Boolean).join(" · ") || "Logged in"}</span>
                </div>
                <button type="button" className="settings-button" disabled={!!busy} onClick={() => run("cf-logout", () => api.cloudflareLogout())}>
                  Log out
                </button>
              </>
            ) : (
              <>
                <div className="editor-label">
                  Cloudflare
                  <span className="editor-sub">{cf.error || "Not logged in"}</span>
                </div>
                <button
                  type="button"
                  className="settings-button"
                  disabled={!!busy}
                  onClick={() => {
                    setError("");
                    setCfLog("");
                    setBusy("cf-login");
                    api.cloudflareLogin().catch((e) => {
                      setBusy("");
                      setError(String(e?.message || e));
                    });
                  }}
                >
                  Log in to Cloudflare
                </button>
              </>
            )}
          </div>
        ) : null}
        {info.selfHost ? (
          <div className="editor-row" data-setting="publishing.default">
            <label className="editor-label" htmlFor="pub-default">
              Publish to
              <span className="editor-sub">{cf?.loggedIn ? "Where Publish goes first. The other one stays in its menu." : "Log in to Cloudflare to make it the default."}</span>
            </label>
            <select
              id="pub-default"
              className="settings-input editor-select"
              value={cf?.loggedIn ? info.defaultHost || "quire" : "quire"}
              disabled={!cf?.loggedIn || busy === "default"}
              onChange={(e) => {
                const host = e.target.value;
                setInfo((i) => ({ ...i, defaultHost: host }));
                run("default", () => api.setDefaultHost(host));
              }}
            >
              <option value="quire">{BRAND.name} hosting</option>
              <option value="cloudflare">My Cloudflare</option>
            </select>
          </div>
        ) : null}
      </div>
      {busy === "cf-login" && cfLog.trim() ? <pre className="pub-log">{cfLog.trim().split("\n").slice(-4).join("\n")}</pre> : null}
      <p className="settings-error pub-error" role="alert">{error}</p>
    </>
  );
}
