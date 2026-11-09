import { useEffect, useRef, useState } from "react";

/**
 * A small yes/no dialog. Enter confirms, Esc or a click outside cancels. With `onDontAsk`, it
 * offers a "Don't ask again" box that's applied when confirming.
 */
export default function ConfirmDialog({ title, body, confirmLabel, error, busy, onConfirm, onCancel, onDontAsk }) {
  const ok = useRef(null);
  const [dontAsk, setDontAsk] = useState(false);
  const confirm = () => {
    if (busy) return;
    if (dontAsk && onDontAsk) onDontAsk();
    onConfirm();
  };

  useEffect(() => {
    ok.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-body">{body}</p>
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
        <div className="confirm-foot">
          {onDontAsk ? (
            <label className="confirm-check">
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
              Don't ask again
            </label>
          ) : null}
          <button type="button" className="settings-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" ref={ok} className="settings-button is-danger" disabled={busy} onClick={confirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
