// Where a Publish click goes, and whether it needs a Quire sign-in first. Pure, so the hosting
// smoke can check it without a window.

/** The host a publish lands on: the one asked for, else where the page is live, else Quire. */
export function publishTarget(host, live) {
  return host || live?.host || "quire";
}

/**
 * Whether the action touches Quire's hosting: publishing to it, or taking a page down from it
 * (unpublish, or a move to Cloudflare). kind: "publish" | "unpublish".
 */
export function needsQuire({ kind = "publish", host = null, live = null }) {
  if (live?.host === "quire") return true;
  return kind === "publish" && publishTarget(host, live) === "quire";
}

/**
 * "signin" when the action needs a Quire account the user doesn't have, else "go". targets is
 * publishTargets() ({quireSignedIn, ...}), or null before it loads. A Cloudflare-only publish or
 * unpublish never asks.
 */
export function publishStep({ kind = "publish", host = null, live = null, targets = null }) {
  // Targets not loaded yet: go, and the main process's own check asks if it has to.
  if (!targets || !needsQuire({ kind, host, live })) return "go";
  return targets.quireSignedIn ? "go" : "signin";
}
