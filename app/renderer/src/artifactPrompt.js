// The prompt Settings → Import → Claude artifacts copies for Claude Code. Quire can't read a
// claude.ai account, but Claude Code's Artifact tool can list and read it, and
// `quire import-artifact` turns each saved page into a Quire page. Plain module so the smoke
// test can run it under node.

import { BRAND } from "../../../core/brand.mjs";

const q = (s) => JSON.stringify(String(s));

/**
 * @param {{vault: string, folder: string, which: "all"|"these"|"recent", these?: string,
 *          recent?: number, shared?: boolean, update?: boolean}} o
 */
export function artifactPrompt({ vault, folder, which = "all", these = "", recent = 10, shared = false, update = true }) {
  const scope = shared ? "all" : "mine";
  const lines = String(these)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const count = Math.max(1, Math.floor(Number(recent) || 10));
  const where = folder ? `the "${folder}" folder` : "the top level of the vault";
  const whose = shared ? "my artifacts and ones shared with me" : "my artifacts";

  const pick =
    which === "these"
      ? lines.length
        ? `Only these (match each line by link or title; tell me which lines matched nothing):\n${lines.map((l) => `- ${l}`).join("\n")}`
        : "Only these: (none listed yet)"
      : which === "recent"
        ? `The ${count} most recently updated of ${whose}.`
        : `All of ${whose}.`;

  const limit = which === "recent" ? count : 200;
  const cmd = `quire import-artifact "<saved file>" --vault ${q(vault)} --url "<artifact url>" --name "<artifact title>" --folder ${q(folder)}${update ? "" : " --skip-existing"}`;

  return [
    `Import my claude.ai artifacts into my ${BRAND.name} vault at ${vault}, in ${where}.`,
    "",
    `Which: ${pick}`,
    "",
    "Steps:",
    `1. List them with the Artifact tool: action "list", scope "${scope}", limit ${limit}.${which === "these" ? " Keep only the ones above." : ""}`,
    `2. For each one, call the Artifact tool with action "read" and its url. The result says where it saved the page. If it gives back a summary instead of a file, skip that one.`,
    "3. Import the saved file:",
    `   ${cmd}`,
    update
      ? "   An artifact imported before updates its existing page (same page, data kept)."
      : "   --skip-existing leaves artifacts imported before alone.",
    "4. Finish with one line: how many were imported, updated, skipped and failed.",
    "",
    "If the noteblock-artifact skill is installed, use it.",
  ].join("\n");
}
