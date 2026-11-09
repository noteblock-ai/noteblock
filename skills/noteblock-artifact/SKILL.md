---
name: noteblock-artifact
description: Make a Noteblock (formerly Quire) page instead of a claude.ai Artifact. Use whenever you would otherwise publish an Artifact, a claude.ai page, or an HTML page for the user to look at or use (a report, dashboard, explainer, tracker, calculator, plan, mini-app) — build it as a page in the user's Noteblock vault with the `noteblock` CLI. Also use to import existing claude.ai artifacts into Noteblock ("pull my artifacts into Noteblock" or "into Quire", "import that artifact"). Skip it only when the user explicitly asks for a shareable claude.ai link or says to publish an Artifact.
---

# Noteblock pages instead of Artifacts

If you would reach for the Artifact tool (or the `artifact-design` skill) to show the user a
page, make a Noteblock page instead. It lives in their vault, works offline, keeps its own data,
and every change is a git commit.

**When NOT to:** the user explicitly wants a claude.ai link to share with someone, or says
"publish an artifact". Then use the Artifact tool as usual (and offer to import it, below).

## Make the page

The same flow as the `noteblock` skill (read `~/projects/quire/skills/noteblock/SKILL.md` for page
structure, apps, the `quire.store` API and the rules):

The older `quire` command still works and does the same thing.

```bash
noteblock ls                                          # see what's there; pick a folder
noteblock mkdir "Artifacts"                           # once, if the folder doesn't exist
noteblock new "Artifacts/Q3 budget"                   # prints the page folder
noteblock edit "Artifacts/Q3 budget" -m "Build the Q3 budget page"   # lock it
# write index.html (and app.js, style.css…) in that folder
noteblock done "Artifacts/Q3 budget"                  # unlock + commit
```

- Put it in the folder the user's topic already has; `Artifacts/` when nothing fits.
- No CDNs: React and htm come from the import map, the Ledger theme styles plain notes.
  State that should persist goes in `quire.store` / `quire.kv`, not localStorage.
- Tell the user the page path (and `noteblock path <page>`), not a URL.

## Import existing artifacts

Noteblock can't fetch private claude.ai artifacts itself; the Artifact tool can.

1. `Artifact` with `action: "list"` (add `scope: "all"` for shared ones) and pick the URLs the
   user wants.
2. For each one, `Artifact` with `action: "read"` and that `url`. The result names the saved
   local file (or folder) holding the page.
3. `noteblock import-artifact "<saved file or folder>" --url "<artifact url>"` — the page lands in
   `Artifacts/<title>` and commits. Add `--name` or `--folder` to choose where.

Running it again with the same `--url` updates that page in place (same id, data kept), so
re-importing a changed artifact is safe. Add `--skip-existing` to leave already-imported ones alone. A file the user downloaded from claude.ai imports the
same way. Artifacts that call `window.claude.*` runtime APIs won't have them in Noteblock; say so
and offer to port that part to `quire.store`.
