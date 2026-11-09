import { useEffect, useRef, useState } from "react";
import { QuireMark, Spinner, Wordmark } from "./icons.jsx";
import { BRAND } from "../../../core/brand.mjs";

/**
 * "Sign in to publish": shown before a Quire publish while signed out. Sign in opens the
 * browser (api.hostingSignIn) and waits; once signed in it calls onSignedIn, which goes on with
 * the publish. With `cloudflare`, it also offers publishing to the user's own Cloudflare.
 * Esc cancels (and stops a sign-in that's waiting).
 */
export default function SignInDialog({ api, quireHost, noun = "Pages", cloudflare, initialWaiting = false, onSignedIn, onCloudflare, onCancel }) {
  const [waiting, setWaiting] = useState(initialWaiting);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const primary = useRef(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    primary.current?.focus();
  }, [waiting]);

  const cancel = () => {
    if (waiting) api.hostingCancelSignIn?.().catch(() => {});
    onCancel();
  };
  const signIn = () => {
    setError("");
    setWaiting(true);
    api.hostingSignIn().then(
      (acct) => {
        if (!alive.current) return;
        if (acct?.signedIn) return onSignedIn();
        setWaiting(false);
        setError("That didn't sign you in. Try again.");
      },
      (e) => {
        if (!alive.current) return;
        setWaiting(false);
        const msg = String(e?.message || e);
        if (!/cancelled/i.test(msg)) setError(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      },
    );
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="confirm signin" role="dialog" aria-modal="true" aria-labelledby="signin-title" aria-describedby="signin-body">
        <div className="signin-brand">
          <QuireMark size={40} />
          <Wordmark />
        </div>
        {waiting ? (
          <>
            <h2 id="signin-title">Finish signing in in your browser</h2>
            <p id="signin-body" className="signin-waiting">
              <Spinner size={12} /> Waiting for the browser
            </p>
            <div className="confirm-foot">
              <button type="button" ref={primary} className="settings-button" onClick={cancel}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="signin-title">Sign in to publish</h2>
            <p id="signin-body">{noun} you publish with {BRAND.name} go to <span className="signin-host">{quireHost || `a link on ${BRAND.domain}`}</span>.</p>
            {error ? (
              <p className="settings-error signin-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="confirm-foot">
              <button type="button" className="settings-button" onClick={cancel}>
                Cancel
              </button>
              <button type="button" ref={primary} className="settings-button is-primary" onClick={signIn}>
                Sign in
              </button>
            </div>
            {cloudflare ? (
              <div className="signin-alt">
                <button type="button" className="settings-button" onClick={onCloudflare}>
                  Publish to your Cloudflare instead
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
