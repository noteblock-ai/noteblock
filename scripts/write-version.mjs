// app/main/version.json: the commit a packaged app was built from (shown in About) and the
// update feed it checks (app/main/updater.mjs): siteUrl("/updates/") from core/brand.mjs.
// QUIRE_UPDATE_FEED overrides it (a test feed baked into a build).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { siteUrl } from "../core/brand.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

// NOTEBLOCK_CHANNEL=next builds Noteblock Next, which has its own feed (docs/release.md).
const channel = () => process.env.NOTEBLOCK_CHANNEL || null;
export const updateUrl = () => process.env.QUIRE_UPDATE_FEED || siteUrl(channel() ? `/updates/${channel()}/` : "/updates/");

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = {
    sha: git("rev-parse", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    builtAt: new Date().toISOString(),
    updateUrl: updateUrl(),
    ...(channel() ? { channel: channel() } : {}),
  };
  fs.writeFileSync(path.join(root, "app", "main", "version.json"), JSON.stringify(version, null, 2) + "\n");
  console.log(`app/main/version.json ${version.branch} ${version.sha.slice(0, 7)} feed ${version.updateUrl}`);
}
