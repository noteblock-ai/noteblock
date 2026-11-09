import { useEffect, useRef } from "react";

/**
 * A two-choice dialog for vault trust (app/main/trust.mjs), in ConfirmDialog's frame. Unlike
 * ConfirmDialog, the safe choice is the default: Enter, Esc and a click outside all pick
 * `onSafe`. `commands` (optional) are shown verbatim, so the person sees exactly what would run.
 */
export default function TrustDialog({ title, body, commands, riskyLabel, safeLabel, busy, onRisky, onSafe }) {
  const safe = useRef(null);

  useEffect(() => {
    safe.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && !e.isComposing && document.activeElement?.dataset?.trustRisky !== "1")) {
        e.preventDefault();
        if (!busy) onSafe();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onSafe()}>
      <div className="confirm trust-dialog" role="alertdialog" aria-modal="true" aria-labelledby="trust-title" aria-describedby="trust-body">
        <h2 id="trust-title">{title}</h2>
        <p id="trust-body">{body}</p>
        {commands && commands.length ? (
          <ul className="trust-commands">
            {commands.map((c, i) => (
              <li key={i}>
                <span className="trust-command-kind">{c.kind === "build" ? "Build" : c.name && c.name !== "main" ? `Backend · ${c.name}` : "Backend"}</span>
                <code>{c.cmd}</code>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="confirm-foot">
          <button type="button" className="settings-button" data-trust-risky="1" disabled={busy} onClick={onRisky}>
            {riskyLabel}
          </button>
          <button type="button" ref={safe} className="settings-button is-primary" disabled={busy} onClick={onSafe}>
            {safeLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
