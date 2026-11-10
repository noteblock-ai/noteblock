// Settings → Feedback: one address that reaches us.
import { BRAND } from "../../../core/brand.mjs";

export const SUPPORT_EMAIL = "support@noteblock.ai";

export default function FeedbackPane() {
  const href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${BRAND.name} feedback`)}`;
  return (
    <>
      <div className="editor-list pub-list" data-setting="feedback.email">
        <div className="editor-row">
          <div className="editor-label">
            {SUPPORT_EMAIL}
            <span className="editor-sub">Bugs, ideas, questions. A person reads every email.</span>
          </div>
          <a className="settings-button" href={href} target="_blank" rel="noreferrer">
            Send email
          </a>
        </div>
      </div>
    </>
  );
}
