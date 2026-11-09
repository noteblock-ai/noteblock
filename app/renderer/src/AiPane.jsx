// Settings → Noteblock AI (designs/canvas/build-ai.mjs board 13): the account, the model and
// today's spend, and what Noteblock AI may do. ai.status() is read once when the pane opens,
// never polled. Permissions are `allow` | `ask` | `off` in ~/.noteblock/config.json (docs/ai.md).
import { useEffect, useState } from "react";
import { formatAccelerator } from "./platform.js";
import { creditCount } from "./PlanPane.jsx";

export const AI_PERMISSIONS = [
  ["editPage", "Edit the page you asked from", "Text, layout, and the page’s own scripts"],
  ["readPages", "Read other pages", "So it can use what’s in them"],
  ["editOtherPages", "Edit other pages", ""],
  ["createPages", "Create pages and folders", ""],
  ["openPages", "Open pages and tabs", "Switch to a page or open one in a new tab"],
  ["trashPages", "Move pages to Trash", "Recoverable from Trash"],
  ["deleteFiles", "Delete files inside a page", "Scripts, styles, images"],
  ["fetchWeb", "Fetch from the web", "Look up a URL or call a public API while building"],
  ["movePages", "Move and rename pages", "Pages and folders, anywhere in the vault"],
  ["changeSettings", "Change settings", "Never sign-in, API keys or these permissions"],
];
export const AI_PERMISSION_DEFAULTS = {
  editPage: "allow",
  readPages: "allow",
  editOtherPages: "ask",
  createPages: "allow",
  openPages: "allow",
  trashPages: "ask",
  deleteFiles: "ask",
  fetchWeb: "allow",
  movePages: "allow",
  changeSettings: "ask",
};

// "claude-haiku-5-5" → "Haiku 5.5". The product is Noteblock AI; the model is just a size.
export function modelName(id) {
  if (!id) return "";
  const m = String(id).match(/^(?:claude-)?([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (!m) return String(id);
  return m[1].charAt(0).toUpperCase() + m[1].slice(1) + " " + m[2] + (m[3] ? "." + m[3] : "");
}

const dollars = (cents) => "$" + (Math.max(0, Number(cents) || 0) / 100).toFixed(2);

export default function AiPane({ api, shortcuts = [], onOpenTab }) {
  const [status, setStatus] = useState(null);
  const [email, setEmail] = useState("");
  const [perms, setPerms] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.ai?.status?.().then((s) => alive && setStatus(s || {}), () => alive && setStatus({}));
    api.ai?.permissions?.().then((p) => alive && setPerms(p || {}), () => alive && setPerms({}));
    api.publishingInfo?.(false).then((i) => alive && setEmail(i?.quire?.user?.email || ""), () => {});
    return () => {
      alive = false;
    };
  }, [api]);

  const set = async (key, value) => {
    setError("");
    const before = perms;
    setPerms((p) => ({ ...(p || {}), [key]: value }));
    try {
      const next = await api.ai?.setPermissions?.({ [key]: value });
      if (next && typeof next === "object") setPerms(next);
    } catch (e) {
      setPerms(before);
      setError(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

  if (!api.ai) return <p className="settings-hint">Noteblock AI isn't in this build of the app.</p>;

  const keys = formatAccelerator(shortcuts.find((s) => s.id === "ai-bar")?.accelerator || "CmdOrCtrl+J");
  const who = status?.signedIn === false ? "Not signed in, so Noteblock AI is off." : email ? `Signed in as ${email}.` : "";
  const spent = status && status.spentTodayCents != null && status.limitCents != null;
  // Plans and billing: credits replace "$x of $y used today" when the server sends them.
  const credits = status?.credits && typeof status.credits === "object" ? status.credits : null;
  const outOfCredits = !!credits && Number(credits.left) <= 0;
  const usage = credits
    ? [`${creditCount(credits.monthlyLeft)} credits left this month`, Number(credits.purchased) > 0 ? `${creditCount(credits.purchased)} bought` : null].filter(Boolean).join(", ")
    : spent
      ? `${dollars(status.spentTodayCents)} of ${dollars(status.limitCents)} used today`
      : null;

  return (
    <>
      <p className="settings-hint">
        {keys} and /ai. {who} Ask means Noteblock AI stops and asks you in the conversation first.
      </p>

      {status && status.signedIn !== false ? (
        <div className="editor-list ai-pane-account" data-setting="ai.account">
          <div className="editor-row">
            <div className="editor-label">
              {outOfCredits ? "Out of credits" : status.enabled === false ? "Not on for this account" : status.limitReached ? "Paused until tomorrow" : "On"}
              <span className="editor-sub">
                {[status.model ? "Model: " + modelName(status.model) : null, usage].filter(Boolean).join(" · ") || "Noteblock AI"}
              </span>
            </div>
            {credits && onOpenTab ? (
              <button type="button" className={"settings-button" + (outOfCredits ? " is-primary" : "")} onClick={() => onOpenTab("plan")}>
                {outOfCredits ? "Buy credits" : "Plan"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="activity-section-head ai-pane-head">
        <span className="vault-field-label">What Noteblock AI may do</span>
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="editor-list">
        {AI_PERMISSIONS.map(([key, label, sub]) => {
          const value = perms?.[key] || AI_PERMISSION_DEFAULTS[key];
          return (
            <div className="editor-row" key={key} data-setting={"ai." + key}>
              <div className="editor-label" id={"ai-perm-" + key}>
                {label}
                {sub ? <span className="editor-sub">{sub}</span> : null}
              </div>
              <div className="segmented ai-seg" role="group" aria-labelledby={"ai-perm-" + key}>
                {[["allow", "Allow"], ["ask", "Ask"], ["off", "Off"]].map(([v, text]) => (
                  <button key={v} type="button" aria-pressed={value === v} disabled={!perms} onClick={() => value !== v && set(key, v)}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
