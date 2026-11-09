# Noteblock v0 — the contract

Every part of v0 (core, Electron main, renderer, page runtime, CLI, MCP, examples) builds
against this file. If code and this file disagree, fix one of them in the same change.

Plain ESM JavaScript everywhere (`.mjs`), with JSDoc where it helps. No TypeScript, and no
build step except the renderer (Vite) and the vendor bundle (esbuild). Node ≥ 22.13 and
Electron 44 both ship `node:sqlite`, so no native modules are needed.

## Naming: public vs internal

The product is renamed by editing **`core/brand.mjs`**, which is pure and imported by main,
renderer (Vite), CLI, MCP, scripts and the site: `BRAND.name` (prose, menus, window titles),
`BRAND.word` + `BRAND.tld` (the wordmark), `BRAND.domain`, `siteUrl(path)` (site, sign-in, API,
downloads, update feed) and `pageHost(slug)` (published pages). Every string a person reads
comes from there. The places that can't import it are checked against it instead:
`package.json` `build.productName` and the `artifactName`s (`scripts/release.mjs` refuses to
release on a mismatch) and the iOS `CFBundleDisplayName` in `ios/project.yml` /
`ios/Quire/Info.plist` (`scripts/build-mobile-host.mjs` fails the build; Swift reads it back
as `Brand.name`), and the Android `app_name` in `android/app/src/main/res/values/strings.xml`
(same check; Kotlin reads it back as `Brand.name`). The example vault's text says the name in plain prose.

Internal, and staying `quire` through any rename: the `quire://` protocol, `window.quire` /
`window.quireApp`, the MCP tool names (`quire_*`), the CLI's file `cli/quire.mjs` and its `quire`
name (kept beside `noteblock`, the name to use), the default vault folder
`~/Quire`, `QUIRE_*` env vars (`QUIRE_CONFIG_DIR` is still read, see below), the appId
`org.harborapps.quire` and iOS bundle id `org.harborapps.quire.mobile` (also the Android application id; the Kotlin package is
`org.harborapps.quire`), the Xcode target/product `Quire` and the Gradle project `Quire`, the R2 bucket
`quire-releases`, the publish host id `"quire"`, Cloudflare self-host Worker names
`quire-<folder>`, and code identifiers (`QuireMark`, `QuireHost`…).

On-disk names were renamed in 0.3.3 (`core/names.mjs`); the old ones are still read:

| What | Written as | Also read (older installs) |
| --- | --- | --- |
| page manifest | `<page>/.noteblock` | `<page>/.quire` |
| vault metadata | `<vault>/.noteblock/` (`vault.json`, `locks/`, `snapshots/`) | `<vault>/.quire/` |
| app config | `~/.noteblock` | `~/.quire` (left as a symlink to `~/.noteblock`) |
| dev app config | `~/.noteblock-dev` | `~/.quire-dev` (left as a symlink) |
| config override | `NOTEBLOCK_CONFIG_DIR` | `QUIRE_CONFIG_DIR` |

- **Readers accept both, preferring the new name.** A folder is a page if it holds `.noteblock`
  or `.quire`; a vault is a vault if it holds `.noteblock/vault.json` or `.quire/vault.json`;
  when both exist the `.noteblock` one wins. Locks are listed from both `locks/` dirs. Anything
  that hides or skips the manifest (watcher, protocol, `files.read`, publish, templates,
  artifact and Obsidian import, trash) treats both names alike.
- **Writers always write the new names.** `writeManifest` writes `.noteblock` and deletes a
  `.quire` beside it; vault.json, locks and snapshots go under `.noteblock/`. The vault's
  `.gitignore` ignores `locks/` and `snapshots/` under both names.
- **Config dir.** The first `configDir()` call with no override set (app main and CLI both
  pass through it) moves `~/.quire` to `~/.noteblock` when `~/.noteblock` doesn't exist and
  `~/.quire` is a real directory, then leaves `~/.quire` as a symlink to it so older apps and
  CLIs keep working. The dev app does the same for `~/.quire-dev` → `~/.noteblock-dev` in
  `main.mjs`. Never when `NOTEBLOCK_CONFIG_DIR` / `QUIRE_CONFIG_DIR` is set.
- **Vault migration** (`migrateVaultNames(vault)`, `core/vault.mjs`), run when the app opens a
  vault (`setVault`) and when the CLI or MCP server resolves one (`resolveVault`), before
  anything reads it: `<vault>/.quire/` → `<vault>/.noteblock/` (when both exist, entries the
  new one lacks move over, recursively, and the old dir is removed); every page's `.quire` →
  `.noteblock` (walking plain folders, skipping dot-dirs, `node_modules` and `data`, never
  inside a page; when a page has both, `.quire` is deleted); `.gitignore` gains a
  `.noteblock/…` line for each line naming `.quire/…`. Then it commits only those paths as
  "Rename Quire files to Noteblock". Nothing to rename = no change, no commit. A page synced
  in later with only `.quire` is still read and is renamed on the next open. Templates in
  `<configDir>/templates` are renamed the same way (no commit) the first time they're listed.

Kept for continuity with 0.2.x installs: before `ready` the Electron app names itself `Quire`
(`Quire Dev` from a checkout) and pins userData to `<appData>/Quire`, because Chromium names the
macOS keychain item behind safeStorage after the app's name at that point (`Quire Safe
Storage`); `BRAND.name` replaces it once ready. An updated install stays at
`/Applications/Quire.app` on disk. The feed keys (`updates/latest-mac.yml`, `updates/latest.yml`,
`downloads/latest.json`) never change name, and `BRAND.legacyDomain` keeps serving them.

## Repo layout

```
core/            shared library: vault, pages, names (on-disk names), html, lock, git, store (used by main, CLI, MCP)
app/main/        Electron main process (main.mjs, preload.cjs, protocol.mjs, ipc.mjs)
app/renderer/    React UI (Vite): sidebar, page host, source view, lock banner
app/runtime/     served INTO each page iframe: runtime.js, theme.css, vendor/ (built)
cli/quire.mjs    the `noteblock` command (also linked as `quire`)
mcp/server.mjs   stdio MCP server
examples/My First Vault/   the seed vault copied on first run
skills/noteblock/SKILL.md   the Claude skill (symlinked into ~/.claude/skills/noteblock)
skills/noteblock-artifact/SKILL.md   "make a Noteblock page instead of a claude.ai artifact" + import
```

## Vault format

```
<vault>/
  .git/                     one repo per vault, local only, everything commits to main
  .gitignore                data/, .noteblock/{snapshots,locks}/ and .quire/{snapshots,locks}/,
                            .DS_Store, node_modules/, .venv/, .env*
  .noteblock/
    vault.json              {"name": "My First Vault", "version": 2}
    locks/<id>.json         present while an agent is editing that page (gitignored)
    snapshots/<id>/         copy of that page's own files taken when the lock began (gitignored)
  Welcome/                  a PAGE: a folder holding a `.noteblock` file
    .noteblock              {"id": "k3m9x2p7qa", "entry": "index.html", "title"?: "...",
                             "renderer"?: "quire"|"view"|"source",
                             "build"?: "pnpm build", "source"?: "index.html",
                             "origin"?: {"kind": "claude-artifact", "url"?, "importedAt"}}
    index.html | index.md   the entry named by .noteblock (default: index.html, else index.md)
    data/<user>.sqlite      this person's data for this page (gitignored)
    anything else           js/css/assets/subfolders the page uses, served relative to the entry
  Kyoto trip/               a FOLDER: no .noteblock file, only groups pages and folders
    Overview/  Trip budget/  Packing list/
```

- **A folder with a `.noteblock` file is a page; any other folder is just a folder.** (The vault's
  own `.noteblock/` is a directory, so the root is never a page.) Directories starting with `.`
  and `node_modules` are never rows.
- **Plain files.** Any other file directly in a folder (or at the top of the vault), not inside
  a page, is a tree node of kind `"file"` (`path`, `title` = its name). The sidebar lists it
  among the pages and opens it in the file view: images, PDFs, video and audio are shown as
  themselves (served at `quire://vault/<path>`), text files open in the editor, and anything
  else offers "Open in default app". Dotfiles are never listed.
- **Pages are leaves.** Folders hold pages, folders and plain files; a page never holds pages. Directories
  inside a page are its own files and never appear in the sidebar. `createPage` /
  `createFolder` refuse a parent that is a page.
- **A path** is the plain vault-relative path: `Kyoto trip/Trip budget` ↔
  `<vault>/Kyoto trip/Trip budget/`. Every API, CLI command and MCP tool addresses pages this
  way. Anything that takes a page ref also accepts the page's `id`.
- **Title** = `.noteblock` `title` if set, else the folder name.
- **Renderer** = how the app opens the page: `quire` (default; Noteblock's in-place editor),
  `view` (rendered, no text editing) or `source` (source + live preview). The picker in the
  top bar switches for now and can save the current one as the page's default.
- **Built pages.** `build` is a shell command run (`/bin/sh -c`; `cmd.exe /d /s /c` on Windows, `core/build.mjs` `shellSpawn`) in the page folder; `entry`
  is its output (`dist/index.html`) and `source` the HTML template it's built from. Prose
  edits are applied to `source` (and to `entry` right away, so they show before the rebuild),
  then the app rebuilds. Element numbering lines up because bundlers keep body markup in
  place and put their scripts in `<head>` (or append them); keep the template's module script
  last in `<body>`. The app also rebuilds when a page file outside the output folder,
  `node_modules`, `data/` and lockfiles changes, and reloads the page after a code rebuild.
  `endEdit` (`quire done`) runs the build before committing. In the app, prose edits on a built
  page are saved with ⌘S (the top bar shows "Unsaved · ⌘S"), not autosaved, since every save
  rebuilds; the page is never reloaded by its own build's file churn.
- **Backends.** `.noteblock` `"backend": {"dir"?: "backend", "run": "<cmd>" | {"<name>": "<cmd>"},
  "proxy"?: "<name>"}` (a bare string is named `main`; names are `[a-z][a-z0-9_-]*`). The app
  (`app/main/backend.mjs`) runs each command with `/bin/sh -c` (`cmd.exe` on Windows, where a stop is `taskkill /T /F` and the `ps` watchdog limits are off for now) in the backend folder, with the
  login shell's PATH (Noteblock's `node`/`pnpm` shims first, see **Tools Noteblock ships**) plus `backend/.env`, `PORT` (this process), `PORT_<NAME>` (every process
  of the page, upper-cased, `-` → `_`) and `QUIRE_PAGE`. They start the first time the page's
  entry is served (opening it, or an embed of it) and run until they go idle, the app quits or
  it switches vault; a change under the backend folder (outside `data/`, `node_modules`) restarts them,
  debounced 400 ms, without reloading the page; a non-zero exit restarts after 1, 2, 4… s (max
  30) until `backends.crashLimit` crashes (default 5, `0` = never give up) within
  `backends.crashWindowMinutes` (default 2), then it stays `crashed` with `reason: "kept
  crashing (N times in M min) — restart to try again"` and `limitHit: "crashes"` until a
  Restart (or a file change), which clears the count; editing `.noteblock`'s backend restarts with the new config. Ports come from 47000–48999,
  one per `<page id>:<name>`, kept in `configDir()/ports.json` and reused while free. Output is
  kept per process (last 256 KB) in `configDir()/logs/<id>-<name>.log`; `quire logs` prints it.
  Requests to `quire://p-<id>/<page>/api/…` (and `/api/…` on the page's origin) are forwarded to `http://127.0.0.1:<proxy port>/api/…`
  (method, headers, body; path and query unchanged); on the shared `quire://vault` origin (iOS)
  the runtime rewrites `fetch`/XHR of `/api/…` to that page-relative URL. Other pages can't
  call it (the origin guard, below). The backend folder is never served to the page and never
  published. The vault's `.gitignore` covers `.env` and `.env.*` (except `.env.example`), and
  `data/` anywhere. The top bar shows a Backend pill (worst process state) that opens the
  processes, ports and logs with Restart / Stop (also View → Backend Logs).
  An idle `node server.js` holds ~40 MB, so backends are bounded. A use is the page or an embed
  of it being served, an `/api` request, or `backendStatus` for it (the selected page, the
  Backend panel). A backend with no use for `backends.idleMinutes` (`configDir()/config.json`,
  default 15, `0` = never) is stopped (SIGTERM to its process group, SIGKILL after
  `backends.stopGraceSeconds`, default 5); at most
  `backends.maxRunning` (default 12, `0` = no cap) run at once, and starting another first stops
  the least recently used. Either way its status procs read `state: "stopped"` with
  `reason: "idle"` or `"cap"` (a Stop from the panel has no reason), and the next use starts it
  again on the same ports: the `/api` proxy waits up to 15 s for the proxy process to listen,
  then answers 503 with a message naming the process and port (or the limit that stopped it).
  A watchdog checks every running backend process every `backends.checkSeconds` (default 2;
  first check 250 ms after a start, at most 500 ms apart for its first 10 s) with one
  `ps -A -o pid=,ppid=,pgid=,rss=,pcpu=`. A process's usage is its process group plus every
  descendant by parent pid (a `setsid` child that stays a descendant counts; one reparented to
  launchd in a new session can't be tracked). Over `backends.maxProcesses` (default 64) the
  whole tree is SIGSTOPped, re-listed, and SIGKILLed with no grace; over `backends.maxMemoryMB`
  (default 1024, total RSS) or at/over `backends.cpuPercent` (default 90, 100 = one core) for
  `backends.cpuSeconds` (default 60) it gets SIGTERM then SIGKILL after the grace. `0` turns
  each off. When `ps` doesn't answer within 250 ms (it can't during a fork storm on macOS), every
  backend group is frozen, listed, judged, and the rest SIGCONTed. A process stopped this way
  reads `state: "stopped"`, `reason` ("too many processes (N)", "used too much memory (X MB)",
  "used X% CPU for Ns") and `limitHit` (`processes` | `memory` | `cpu`), its log gets
  `[quire] stopped: too many processes (130 > 64)`, and it stays stopped until a Restart. Every
  limit lives in `app/main/limits.mjs` (`limits()`, read on each check; `limitsSchema()`,
  `setLimits()`, `resetLimits()`) and is stored in `configDir()/config.json` under `pages` /
  `backends`.
- **Activity & limits.** Settings → Activity & limits (`app/main/activity.mjs`, `quireApp.activity()`) shows
  memory and CPU for Noteblock itself (`app.getAppMetrics()` summed into Main / Renderer and pages /
  GPU / Utility, plus "Pages: N processes, X MB" with the five biggest page renderers by page
  title, from every frame's `osProcessId`, `page-health.mjs` `pageProcesses()`) and for every page backend process in the vault, running or not, with its
  state and reason, process count, port, last use and restarts, plus running builds. A
  backend's memory, CPU and processes are its process group and every descendant (the same
  `backendUsage` the watchdog uses), from one `ps -A` per snapshot. The tab polls every 2 s while it is open and nothing else; asking for a snapshot
  doesn't count as a use. Each row has Stop, Restart and Logs (opens the page with its Backend
  panel); Stop all stops every backend. Below, a Limits section renders `limitsSchema()` in two
  groups, Pages (`unresponsiveSeconds`, `autoReloadCrashed`, `autoReloadLimit`, `errorBadge`)
  and Backends (the rest), each saved on change through `setLimits` (applied at once: idle ones
  stop, the least recently used stop until the cap fits, the watchdog re-times), with "Off" for
  0 where 0 disables, errors inline in place of the help line, and Reset to defaults.
  `setBackendPolicy({idleMinutes, maxRunning})` still works as a thin wrapper.
- **Publishing.** The top bar's Publish button builds the page and stages it as a static site
  (the transformed entry as `index.html`, the build output or the page's own files (never the
  backend folder), Noteblock's runtime under `/_quire/`), then puts it on one of two hosts:
  - `quire` (the default, `app/main/hosting.mjs`): Noteblock's managed hosting. The first publish
    creates a site (`POST /api/sites`), every publish uploads the whole staged folder
    (`PUT /api/sites/:slug`, multipart, one `file` part per file named by its site path), and it
    is served at `https://<slug>.noteblock.ai/` (`pageHost(slug)`, core/brand.mjs). Needs a Noteblock account; publishing while signed
    out signs in first, then goes on. The server's API is `docs/hosting-api.md`; its base URL is
    `QUIRE_HOSTING_URL`, default `https://noteblock.ai` (`siteUrl()`). Pages published from
    0.2.x keep their old `<slug>-quire.harborapps.org` URL in `public.url`; the server
    redirects those to `pageHost(slug)`.
  - `cloudflare` (only with self-hosting on and wrangler logged in): `wrangler deploy` (pinned
    `wrangler@4`, `app/main/cloudflare.mjs`) as a Worker with static assets named
    `quire-<folder>` on workers.dev, in the person's own Cloudflare account.
  `.noteblock` `"public"` records what's live: `{host: "quire", slug, url, version, publishedAt,
  fingerprint}` or `{host: "cloudflare", url, worker, accountId, dashboardUrl, publishedAt,
  fingerprint}`, where `dashboardUrl` is
  `https://dash.cloudflare.com/<accountId>/workers/services/view/<worker>/production`
  (accountId from `CLOUDFLARE_ACCOUNT_ID` or `wrangler whoami --json`). A record without `host`
  (from before hosts) is `cloudflare`, and gets a `dash.cloudflare.com/?to=/:account/…` link.
  The fingerprint hashes the page's source files, so a different hash shows "Changes not live".
  A page is live on one host at a time: publishing to the other host (Move to …, after a
  confirm) unpublishes from the current one first. Publish again without a host keeps the
  current one. Unpublish deletes the site or the Worker. The live menu has Open, Copy link,
  Open in Cloudflare dashboard (cloudflare), Update / Publish changes, Move to …, Unpublish.
  On the web, the runtime runs standalone: `quire.store` and `quire.kv` keep data in each
  visitor's localStorage, `quire.query`/`pages` return nothing, and embeds show a placeholder.
  An entry in a subfolder is served with `<base href>` set to that folder, so relative asset
  URLs resolve.
  A page staged for `quire` gets a "Made with Noteblock" link to `siteUrl()` at the end of its
  body (`withBadge`), so never in the app, the local page server or a Cloudflare publish. It is
  not in the fingerprint: a page already live gets it on its next publish.
- **Publishing a folder.** `publishFolder` (`app/main/publish.mjs`) puts a plain folder on `quire`
  as one site. Every page with a build is built in turn (a failure names the pages and uploads
  nothing), then the site is staged: a generated `index.html` (the folder's name, a nested list in
  sidebar order, the badge), one shared `/_quire/`, each page at `/<slugified relative path>/`
  (`-2` on a clash), plain files likewise. A page with a backend publishes static, as it does
  alone; a page with no entry file is left out and named in the output. Links in a staged page
  resolve as in the app, so `../Other/`, `/Folder/Other/` and `quire://vault/Folder/Other/` point
  at the staged path; a link to a folder goes to its row in the list; an `<a>` to anywhere else
  (outside the folder, or missing) becomes its text. Media `src`s are repointed but never removed.
  An empty folder, or one over the site limits, stops with a sentence before anything uploads.
  `<vault>/.noteblock/published-folders.json` is `{"<folder path>": {host: "quire", slug, url,
  fingerprint, updatedAt}}`. It is committed, so it travels with the vault as a page's `public`
  does, and republishing reuses the slug. Moving a folder through the app moves its record.
- **Settings → Publishing.** *Noteblock account*: Sign in opens the browser at
  `<base>/auth/desktop?port&state` while main listens on `127.0.0.1:<random port>`; the server
  redirects to `/callback?code&state` (state checked), main swaps the code at
  `POST /api/desktop/token` for an API token, and every call sends `Authorization: Bearer`.
  The token is kept in `configDir()/hosting.json` → `{base, token, user, signedInAt}`, `token`
  being the base64 of Electron `safeStorage.encryptString` (never plain text, never in
  config.json); it only counts for the same `base` (or, on the default server, a token stored
  for the old `https://quire.harborapps.org`), and a 401 forgets it. A token that won't decrypt
  (another keychain key) reads as signed out; the next sign-in overwrites it. Signed in shows the
  avatar, name, email and "N of M sites" (`GET /api/me`, cached 30 s); Sign out calls
  `POST /api/desktop/logout` and deletes the file. *Self-hosting*: "Also publish to my own
  Cloudflare account" is `publishing.selfHost` in config.json. When on, the Cloudflare row
  runs `wrangler login` (it opens the browser and finishes by itself; its output streams as
  `cloudflare-status`) or `wrangler logout`, and shows `wrangler whoami --json`'s email and
  account. With self-hosting on and wrangler logged in, Publish is a dropdown: "Publish with
  Noteblock — <slug>.noteblock.ai" or "Publish to your Cloudflare". `QUIRE_WRANGLER=<executable>`
  replaces `pnpm dlx wrangler@4` (scripts/fakes/wrangler.mjs, for tests and screenshots).
- **Links.** A click follows a link, in the editor too (unless it ends a text selection).
  Links between pages are ordinary relative links to the other page's folder URL
  (`../../Garden/Watering/` from `Garden/Home`). Any `quire://` URL but the runtime (`vault` or a
  page's own origin; the path is always the vault path) opens in Noteblock
  via `quire.navigate`: a page or plain file opens as itself, a path inside a page opens that
  page's file in the file view. `http(s):`, `mailto:` and `tel:` links open in the browser.
  `#anchors` keep their default. Moving or renaming a page or folder repoints the links, embeds
  and `quire://` URLs that reach it, and a moved page's own relative ones, in every page's entry or
  build source (core/relink.mjs). Only the link's bytes change, and the files go in the move's
  commit. A locked page is skipped and named in `skipped`; links in scripts aren't followed.
- **Trash.** ⌘⌫ (outside text fields), File → Move to Trash, or the sidebar's right-click menu
  moves the selected page, folder, plain file or open page file to the macOS Trash
  (`shell.trashItem`), then commits "Delete <path>". A page's `.noteblock`, the vault's `.noteblock/`
  and `.git`, and anything Claude is editing are refused. A confirm dialog asks first (Enter
  confirms) unless `"confirmDelete": false` in config.json (Settings → Vault, or the dialog's
  "Don't ask again").
- **Frontmatter.** A markdown entry may start with a YAML block (`---` … `---`). It isn't
  rendered, and saving from the Noteblock editor keeps it. An HTML page imported from a note with
  frontmatter keeps the YAML text in `.noteblock` as `"frontmatter"`.
- **Import from Obsidian** (`core/obsidian.mjs`; Settings → Import, File → Import from
  Obsidian…): every `.md` note becomes a page under a chosen folder, either kept as markdown
  (`index.md`, frontmatter and all) or converted to an HTML page (`index.html`). Obsidian's
  folders become folders; a note next to a folder of the same name goes inside it, since pages
  are leaves; name clashes get " 2". `[[wikilinks]]` (aliases, `#heading` dropped, `\|` in
  tables) and relative markdown links to notes become page links; `![[note]]` becomes a Noteblock
  embed (`![[/path]]`); linked images and files are copied into the page folder (HEIC converted
  to JPEG). Every file no note links (PDFs, `.canvas` boards, stray images) is copied as a plain
  file into its folder, so nothing is left behind. Pages without a leading `# ` heading get one from the note name. Callouts become a
  bold title in the blockquote, `==text==` becomes `<mark>`, `%%comments%%` and `^block-ids` are
  dropped; code is left alone. Dot-folders (`.obsidian`, `.trash`) aren't imported; links that
  match no note are kept as text and listed. The whole import is one commit: "Import <name> from Obsidian". The source is only read.
- **Import Claude artifacts** (`core/artifacts.mjs`, `quire import-artifact`): a claude.ai
  artifact saved locally (an `.html` or `.md` file, or a folder holding `index.html` /
  `index.md` / a single `.html` plus its supporting files) becomes a page in the
  **`Artifacts/`** folder (or `folder`), created with a `.gitkeep` per new segment like any
  folder. The entry is copied as `index.html` (or `index.md`), the rest as is (dotfiles,
  `node_modules` and `data/` skipped). Name = `name`, else the `<title>`, else the first
  `<h1>` / `# `, else the file name; clashes get " 2". `.noteblock` `title` is set only when that
  title differs from the folder name. The manifest records where it came from in `"origin":
  {"kind": "claude-artifact", "url"?, "importedAt"}` (not `source`, which already names a built
  page's template). Importing a `url` some page's `origin.url` already has replaces that
  page's files in place (same id, same path, `data/` kept; refused while it is locked) instead
  of adding a page. One commit: "Import artifact <path>" or "Update artifact <path>". Noteblock
  can't fetch private artifacts itself; Claude Code's Artifact tool `read` saves one to disk.
- **Order**: folders first, then pages, each by name (numeric-aware), unless the folder has a
  `.noteblock-order.json` (a JSON list of row names, written by dragging a row onto another
  row's top or bottom edge, `core/order.mjs`). Listed names come first in that order; the rest
  follow in the default order. A rename keeps its place; the file is committed with the vault.
- **Names.** A new page, folder, template or vault name is refused, on every OS, when Windows
  couldn't hold it as a folder: `< > : " \ | ? *` or control characters, a trailing dot or
  space, or a reserved device name (CON, PRN, AUX, NUL, COM1–9, LPT1–9, with any extension)
  (`core/pages.mjs` `nameProblem` / `checkName`). Importers make names portable instead
  (`portableName`: bad characters → `-`, `CON` → `CON page`). Existing pages aren't checked.
- **A new page** is `<Title>/.noteblock` (`{id, entry}`) plus `index.html` containing
  `<!doctype html><html><head><meta charset="utf-8"><title>Title</title></head><body></body></html>`,
  or `index.md` holding `# Title\n`. **A new folder** is `<Name>/.gitkeep`.
- **Relative page refs** (embeds, `quire.navigate`, `quire.query` from an embed `src`) resolve
  against the folder holding the page, like files: from `Kyoto trip/Overview`, `Trip budget`
  is `Kyoto trip/Trip budget`. A leading `/` starts at the vault root.
- **User** = `os.userInfo().username`, lowercased, reduced to `[a-z0-9_-]`. Data file is
  `data/<user>.sqlite`.
- **Migration:** vault.json `version` 2. A version-1 vault (`Name.app/` dirs with `app.json`,
  nested child pages) is migrated the first time it is opened or resolved: each `.app`
  becomes a page folder (`app.json` → `.noteblock`), and an `.app` with children becomes a folder
  holding those children plus a page of the same name with its own content. Committed as
  "Move pages to plain folders"; skipped while any lock exists.

Config: `~/.noteblock/config.json` → `{"current": "/abs/vault", "vaults": ["/abs/vault", …]}`.
The default vault is `~/Quire/My First Vault`, created and seeded from `examples/My First Vault` the
first time the app (or `quire vault create`) runs.

### Templates

Page templates live outside every vault, in `<configDir>/templates/` (`~/.noteblock/templates`, or
`$NOTEBLOCK_CONFIG_DIR/templates`; Noteblock Dev uses `~/.noteblock-dev`). A template is a page folder,
exactly like a vault page: a `.noteblock` manifest plus its files. Two optional manifest fields
are for templates only: `title` (shown in the picker; default the folder name) and
`description`. Plain subfolders group templates; the picker shows the subfolder as the
category (`Notes/Daily note` → category `Notes`).

- The first time the folder is missing, it is seeded from `examples/Templates` (Daily note,
  Habits, Checklist). Never overwritten; "Restore starter templates" copies back only the
  starters that are missing.
- New from template copies the template into a vault folder (the same rule as New page),
  named by the person (default: the template title, de-duped with " 2", " 3"…), with a fresh
  `id`, and without `title`, `description`, `public`, `origin` or `sourceUrl`. `data/`, `node_modules`,
  dotfiles other than the manifest, and a built page's output folder are never copied, so a built
  template is rebuilt in place. The app commits it through autosave and opens it.
- Save as template copies a page the same way into the templates folder, keeping a `title`
  and dropping its `id`.
- Add from GitHub (the picker's bottom row; `addTemplateFromUrl`) takes `https://github.com/owner/repo`,
  `…/tree/<ref>/<subdir>`, `owner/repo` or any `https://….git`, and shallow-clones it with the
  app's git: https only, no prompts, 60 s. A folder with a manifest is one template; one with
  `index.html` or `index.md` and no manifest is one template with a manifest generated; otherwise
  each immediate subfolder with a manifest becomes one, in a category named after the repo.
  `.git`, `node_modules`, dotfiles, `data/` and symlinks are never taken. Over 50 MB or 2,000
  files is an error, and so is finding nothing. Names and titles that collide get " 2".
- A template from a repo never gains code silently. `backend` and `build` are dropped unless the
  person chooses "Add and allow" on a confirm naming the exact commands; the allow only counts
  for that list, so a repo that changes between the confirm and the add asks again. `public`,
  `origin` and `id` are always dropped. The address is kept as `sourceUrl`, a template-only field
  that pages made from it don't get. The picker offers an X on these templates (to the Trash).

core: `templatesDir()`, `listTemplates()` → `[{path, name, title, description, category,
format, files, dir}]`, `findTemplate(ref)` (path, or a unique folder name / title),
`seedTemplates({restore?})`, `createFromTemplate(vault, templateRel, folderRel, name?)` → Page,
`saveAsTemplate(vault, pageRef, name?)`, `templatePath(rel)`, `parseTemplateUrl(address)`,
`addTemplateFromUrl(address, {allowCode?, commands?})` → `{added}` or `{needsConfirm: {commands}}`.

Vault resolution (CLI, MCP): `--vault <dir>` → nearest ancestor of cwd holding `.noteblock/vault.json` (or `.quire/vault.json`)
→ `config.current`.

- **Requires** (optional, informational). `.noteblock` `"requires": {"python": "3.12", "uv": true}`
  names the tools a page's backend or build expects on the Mac (`parseRequires`: keys
  `[A-Za-z0-9._+-]`, values a version string, a number or `true` = any). Noteblock installs
  nothing from it: the Backend panel shows it ("Needs python 3.12, uv") and the missing-tool
  banner uses it to name the version.
- **Missing tools.** When a backend process exits 127 (`sh: python3: command not found`,
  `env: python3: No such file or directory` from a shebang), or Apple's developer-tools stub
  answers for it (`xcode-select: note: No developer tools were found`), its status gets
  `missingTool: "<program>"` and `missingHelp: "<url>"` (`toolHelpUrl` in `app/main/tools.mjs`:
  python3, node, deno, bun, go, ruby, uv, docker, cargo… else a web search), it is not
  restarted, and the page shows a banner: "This page's backend needs `python3`, which isn't on
  this Mac." with How to get it and Show log. Restart (or a file change) tries again.

## Tools Noteblock ships

Noteblock bundles the tools its own features use, and nothing else. Everything else a page's
backend runs (python3, deno, go, uv, a venv…) comes from the Mac's login-shell PATH; Noteblock
doesn't manage it (`.venv/` and `node_modules/` stay out of git, see `.gitignore` above).

| Tool | Version | From | Used for |
| --- | --- | --- | --- |
| git | 2.53.0 (dugite-native v2.53.0-4, pinned by the `dugite` 3.2.3 devDependency) | `Contents/Resources/git/darwin-<arch>/` | vault commits (`core/git.mjs`) and sync (`app/main/sync.mjs`) |
| Node | Electron's (24.22 in Electron 44) | the app binary with `ELECTRON_RUN_AS_NODE=1` | pnpm, wrangler, page builds and backends that call `node` |
| pnpm | 10.34.6 (`pnpm` dependency, `bin/pnpm.cjs`) | `app/node_modules/pnpm` | page builds; `pnpx`/`npx` shims |
| wrangler | 4.147.0 (`WRANGLER_VERSION`) | not bundled (workerd is ~135 MB per arch): `pnpm dlx wrangler@4.147.0`, fetched on first publish | publishing to your own Cloudflare |

- **Windows.** git is MinGit from the same dugite release, `resources/git/win32-<arch>/cmd/git.exe`
  (Git Credential Manager kept: it is Windows' only credential store), with `GIT_EXEC_PATH` set
  and MinGit's own system config. The shims are `node.cmd`, `pnpm.cmd`, `pnpx.cmd` and `npx.cmd`
  (+ `npx.cjs`, the npx logic run by Noteblock's Node). Every vault repo gets `core.autocrlf=false`
  and `core.longpaths=true` (`core/git.mjs` `configureRepo`, at init and on every open, on
  every OS), since MinGit's system config turns autocrlf on.
- `app/main/tools.mjs` resolves them. `initTools` (main.mjs, at startup) writes shims into
  `<userData>/tools/bin` — `node` (`ELECTRON_RUN_AS_NODE=1 exec <app binary>`), `pnpm`,
  `pnpx` (= `pnpm dlx`) and `npx` (a project bin runs with `pnpm exec`, anything else with
  `pnpm dlx`) — and `buildEnv()` puts that folder first on PATH for page builds and backends.
  It points `core/git.mjs` at the bundled git with `useGit({bin, env})`: `GIT_EXEC_PATH`,
  `GIT_TEMPLATE_DIR` and `GIT_CONFIG_SYSTEM` = `<userData>/tools/gitconfig`, which includes
  dugite's config (which includes `/etc/gitconfig`) and, when Xcode or the Command Line Tools
  are installed, their `git-credential-osxkeychain` by absolute path (Apple's git sets that in a
  file this git doesn't read). `~/.gitconfig` applies as usual; ssh remotes use `/usr/bin/ssh`.
- Settings → Tools (`ToolsPane.jsx`; `toolsInfo()`, `setToolMode(id, mode)`) lists each tool
  with the version in use, where it comes from and what uses it. "Use the one on this Mac" sets
  `config.json` `tools: {git|node|pnpm: "system"}` (default `"builtin"`): that tool gets no shim
  and Noteblock runs the Mac's. Switched on with none on the Mac: a red "Not found on this Mac" line
  with Use built-in, and Noteblock's own keeps being used meanwhile.
- Node ABI: the bundled Node is Electron's (`process.versions.modules` 149 in Electron 44, not
  Node 24's 137). N-API addons (rolldown/vite, esbuild's binary, most modern ones) load fine;
  addons built for a specific Node ABI (older `better-sqlite3` prebuilds, anything compiled
  with node-gyp against Node headers) may not. Such a page needs "Use the one on this Mac" for
  Node.
- The CLI (`cli/quire.mjs`) and the MCP server run outside the app and use the Mac's git and
  node.

## Git: one repo per vault, straight to main

- `createVault` runs `git init -b main`, writes `.gitignore`, and commits "Create vault". In the
  app that is the bundled git (**Tools Noteblock ships**); the CLI uses the Mac's.
- **The app** commits its own edits 5 s after the last save: `Edit <page path>`. Author is the
  git default.
- **An agent** commits once, when it finishes: `quire done` → `git add -A && git commit -m
  "<message>"`, author `Claude <claude@quire.local>` unless `--by` is given.
- No branches and no remotes. History is the undo: `quire log`, `git -C <vault> revert`.

## Agent edits: lock → edit files → done

1. `beginEdit(vault, page, {by, message})`
   - `ensureManifest`, then copy the page's own files into `.noteblock/snapshots/<id>/`. That's
     everything in the page folder except `data/`.
   - Write `.noteblock/locks/<id>.json`: `{"id", "path", "by", "message", "startedAt"}`.
   - If the page is already locked, throw unless `force`.
2. The agent edits files in the page's directory directly (any tool).
3. `endEdit(vault, page, {message})` deletes the lock and the snapshot, then commits.
   `abortEdit` copies the snapshot back over the page's own files first, then deletes both
   (no commit).

While a lock exists, the app:
- shows a spinner on that row in the sidebar,
- serves the page's own files **from the snapshot**, so you see the page as it was before the
  edit started,
- puts the page in read-only mode (no text editing, `store` writes reject with
  `"Page is read-only while Claude edits it"`; reads still work),
- shows a banner: **"&lt;by&gt; is editing this page"** (the lock's `by`, e.g. "Codex"; **"This
  page is being edited"** when it has none) · the lock message · "You're seeing the
  version from before the edit started."

When the lock disappears, the app reloads the page from the live files.

## core API (`core/index.mjs` re-exports all)

```js
// vault.mjs
loadConfig() → {current, vaults}           saveConfig(cfg)
resolveVault({vault, cwd}) → abs path      // throws "No Noteblock vault found…" if none
createVault(dir, {name, seed=true}) → abs  // seed copies examples/My First Vault/*, git init+commit
vaultName(vault) → string
currentUser() → string
setVaultName(vault, name)          // vault.json name; commits "Rename vault"
moveVault(from, to) → abs          // moves the folder, rewrites config; refused while locked
renameVault(vault, name) → abs     // name + folder together (folder kept if the name is taken)

// pages.mjs
listTree(vault) → Node[]   // folders first, then pages, by name
  // Folder = {kind: "folder", id: null, title, path, dir, children: Node[], lock: null}
  // Page   = {kind: "page", id, title, path, dir, entry, format: "html"|"md"|"none", children: [], lock}
findPage(vault, ref) → Page        // ref = page path or id; throws "No page: <ref>"
pathDir(vault, path) → abs         isPageDir(dir) → bool
createPage(vault, path, {format="html", content}) → Page   // parent folder must exist
createFolder(vault, path) → Folder                          // parent folder must exist
readEntry(vault, ref) → {file, format, content, path}   // file = editFile(node)
writeEntry(vault, ref, content)    // writes editFile(node): `source` when set, else the entry
editFile(node) → name              RENDERERS = ["quire", "view", "source"]

// build.mjs
buildInfo(dir) → {command, entry, source, outDir} | null
isBuildOutput(info, rel) → bool    // outDir, node_modules, data, lockfiles
runBuild(dir, {env}) → Promise<{ok, code, output, ms}>     runBuildSync(dir) → same
readManifest(dir)  writeManifest(dir, obj)  ensureManifest(dir) → manifest  entryFile(dir) → name
migrateVault(vault) → bool         // vault.mjs; v1 .app layout → v2 (see Migration)
listPageFiles(dir) → FileNode[]    // every file in a page folder (skips .DS_Store, node_modules)
readPageFile(dir, rel) → {path, size, binary, tooLarge, content}   // content null if binary or > 2 MB
writePageFile(dir, rel, content)   // existing files only; pageFilePath refuses `..`
rename / move / delete             // NOT YET

// artifacts.mjs
importArtifact(vault, {source, name, folder="Artifacts", url, commit=true})
  → {path, dir, title, updated, commit}      // see "Import Claude artifacts"
findArtifactPage(vault, url) → Page|null     artifactTitle(content, format="html") → string

// html.mjs  — the ONE place top-level body children are numbered
indexBody(html) → html             // adds data-q-i="0..n-1" to each top-level ELEMENT child of <body>
applyRegions(html, regions) → html // see "Saving text edits" below
renderMarkdown(md) → html          // full document; ![[path]] → <quire-embed src="path"></quire-embed>
htmlToMarkdown(bodyHtml) → md      // turndown; <quire-embed src="x"> → ![[x]]; strips data-q-*
TEXT_TAGS = ["P","H1","H2","H3","H4","UL","OL","BLOCKQUOTE","PRE","TABLE","HR","FIGURE","IMG"]

// lock.mjs
beginEdit(vault, ref, {by=detectAgent(), message="", force=false}) → {lock, dir}
endEdit(vault, ref, {message, by}) → {commit: sha|null}
abortEdit(vault, ref)
getLock(vault, id) → Lock|null     listLocks(vault) → Lock[]
snapshotDir(vault, id) → abs

// git.mjs
gitInit(vault)   commitAll(vault, message, {author}) → sha|null (null when clean)
gitLog(vault, n=10) → [{sha, date, author, message}]   gitStatus(vault) → string[]

// store.mjs   one node:sqlite DatabaseSync per (pageDir,user), cached, WAL mode
openStore(pageDir, user) → Store
Store: all(table) → Row[]  get(table,id) → Row|null  insert(table, obj) → Row
       update(table, id, patch) → Row  remove(table, id) → true
       kvGet(key) → any|null  kvSet(key, value) → true   tables() → string[]
// Row = {...data, id, _created, _updated}   (ids: 10-char random unless obj.id given)
// Schema: rows(tbl TEXT, id TEXT, data TEXT, created INTEGER, updated INTEGER, PRIMARY KEY(tbl,id))
//         kv(key TEXT PRIMARY KEY, value TEXT)
```

## Deep links: `noteblock://`

The app is the OS handler for `noteblock://open?path=<encodeURIComponent(vault-relative path)>`,
e.g. `noteblock://open?path=Projects%2Fbillable` (pw's "Open in Noteblock" button). It shows and
focuses the main window (a new one if all are closed), then main sends `open-path` to the renderer
(`quireApp.onOpenPath`; preload holds a path that arrives before App.jsx subscribes): a page opens; a
folder is expanded in the sidebar and opens the page last viewed in it, else its first page. An
unknown action, a missing path, a path with `.` or `..` segments, or one not in the vault only
shows the window. macOS delivers the URL through `open-url`, Windows and Linux through argv (first
launch) and `second-instance`. The scheme is declared in `build.protocols` (package.json), so only
a packaged build registers it with macOS; a dev run registers itself only with
`NOTEBLOCK_DEV_SCHEME=1`.

## Pages in the app: the `quire://` protocol

Electron registers `quire` as a privileged scheme: `{standard, secure, supportFetchAPI,
corsEnabled, stream}`. `standard` makes every host its own origin and its own site.

**One origin per page** (`app/main/origins.mjs`):

- `quire://p-<page id>/<page path>/<file>`: a file from the page dir, e.g.
  `quire://p-ab12cd34ef/Kyoto%20trip/Trip%20budget/index.html`. The host is the page's `.noteblock`
  `id`, so a rename or move keeps the origin and its localStorage / IndexedDB; the path is the
  vault path, so relative URLs written in a page (`./app.js`, `images/x.png`, `../Trip budget/`)
  resolve as they always did. If the page is locked, its own files come from the snapshot.
  `quire://p-<id>/<page path>/` serves the entry (index.html, or index.md rendered); without the
  trailing slash it redirects to it. A page with no id gets one written into its `.noteblock`
  when the vault opens (or when first asked for). Folders copied in Finder share an id and so
  an origin, until one gets a new id.
- On its own origin a page gets only its own files. A path outside the page (a relative link
  that left it) is redirected to that page's own origin when it is a navigation (a link or an
  embed), and 404 otherwise. `/api/…` on a page's origin goes to that page's backend.
- Because Electron runs no CORS checks for a custom scheme, `session.webRequest` refuses every
  other cross-page request (`protocol.mjs` `originGuard`): navigations (page and embed frames)
  are always allowed, the app UI (`file://`) may load anything, and a page may load its own
  origin and `quire://runtime/`, nothing else. So `fetch("../Other page/x.json")`, an `<img>`
  or `<script>` from another page, and another page's `/api` all fail. Use `quire.files.read`
  and `quire.query` instead.
- Every page frame and embed is its own site, so Chromium's site isolation gives each its own
  renderer process (checked with `frame.osProcessId` in Electron 44). Chromium's own renderer
  process limit applies; Noteblock adds none. Settings → Activity & limits lists them under "Noteblock
  app processes" → Pages.
- `quire://vault/<page path>/<file>` (the old shared origin) redirects to the page's own origin,
  keeping the query. The app still uses it for plain files outside any page (the file view), and
  runtime embeds point at it and follow the redirect. The iOS app (its own scheme handler)
  still serves pages at `quire://vault/` and the runtime works on both.
- `quire://runtime/<file>`: `app/runtime/*` (runtime.js, theme.css, vendor/*.mjs, fonts), shared
  by every page, served with `Access-Control-Allow-Origin: *`.
- An HTML entry is served transformed: `indexBody()` is applied, and right after `<head>` it
  gets
  ```html
  <script type="importmap">{"imports":{"react":"quire://runtime/vendor/react.mjs",
    "react-dom/client":"quire://runtime/vendor/react-dom-client.mjs","htm":"quire://runtime/vendor/htm.mjs",
    "htm/react":"quire://runtime/vendor/htm-react.mjs"}}</script>
  <link rel="stylesheet" href="quire://runtime/theme.css">
  <script src="quire://runtime/runtime.js"></script>
  ```
  plus `<meta name="quire-page" content="<page path>">`.
- A markdown entry is served as `renderMarkdown()` output, then the same transform, with
  `<body data-q-format="md">`.

The renderer shows a page in `<iframe sandbox="allow-scripts allow-same-origin allow-forms
allow-pointer-lock" allow="fullscreen; autoplay" src="quire://p-<id>/<path>/">` (`tree.js`
`pageSrc`), in the main window, the Source preview and the floating note; runtime embeds use the
same sandbox with `allow="fullscreen *; autoplay *"` (their src redirects from quire://vault to
the page origin, which the default src allowlist would miss). Pointer lock, fullscreen and autoplay are there so a page can nest a hosted web
app or game (`<iframe src="https://…" allow="pointer-lock; fullscreen">`, see `Apps/Blastside`):
sandbox flags and permissions policy are inherited, so a nested frame gets only what the page
frame has. Links in the app or a page still open in the browser (`opensInBrowser`); a page's own
nested web frame loads in place.

### Storage migration (`app/main/page-storage.mjs`)

Before per-page origins every page shared `quire://vault`, so one localStorage held every
page's keys, and there is no way to tell which page wrote which. On a page's first load on its
own origin, its entry gets `<script type="application/json" id="q-legacy-storage">` with a copy
of **all** the old keys. The runtime, before any page script runs, copies each key the page's
own localStorage doesn't already have, sets `quire:origin-migrated`, removes the element and
sends `storage.migrated`; main records the page id in `<userData>/page-origins.json` and stops
sending the copy to it. So each page starts with every old key, once; later changes are never
overwritten. Main reads the old data once per run from a `quire://vault` frame in a hidden
`file://` window (localStorage is partitioned by top-level site, and pages always ran under the
app's `file://` window); when it is empty it says so in the file and never looks again.
IndexedDB, cookies and Cache Storage are not migrated.

### Open in browser: the local page server (`app/main/browser-server.mjs`)

Right-click a page → Open in browser. A published page (`.noteblock` `public.url`) opens its public
URL. Any other page opens from a local HTTP server, started on first use:

- Bound to `127.0.0.1` only, on a random free port, for the life of the app. Every URL starts
  with a random token (`http://127.0.0.1:<port>/<token>/…`) and the `Host` header must be the
  server's own, so other local processes, other sites and DNS rebinding can't read the vault.
- No per-page origins here: every page shares the server's one origin, as published pages
  share their site. The http paths are unchanged.
- `/<token>/<page path>/…` serves exactly what `quire://vault/…` does (same
  `resolveVaultRequest` and entry transform); `/<token>/_quire/runtime/…` serves
  `quire://runtime/…`. In served HTML, CSS and JS, `quire://runtime/` and `quire://vault/` are
  rewritten to those paths. Only GET/HEAD, except the two below.
- The entry also gets `<meta name="quire-rpc" content="/<token>/_quire/rpc/<page path>">`. The
  runtime, when it's the top window on `http:` and sees that meta, sends rpcs as
  `POST` to that URL with `{page, method, params}` (JSON) → `runRpc` → `{ok}` | `{error}`,
  instead of `postMessage` to the app. The calling page is the one in the URL path; `page` in
  the body is ignored, and a same-server `Referer` naming another page is refused (403). Otherwise the page behaves like a published one
  (`standalone`: no edit mode, embeds show as unpublished).
- A page with `backend.proxy`: `<page>/api/…` and `/api/…` (the page found from the same-origin
  Referer) go to its backend, started if needed.

## Trust: restricted mode (`app/main/trust.mjs`)

Every vault is **trusted** or **restricted** on each machine, like VS Code's workspace trust.
The answer lives in `<configDir>/trust.json` (default `~/.noteblock/trust.json`), keyed by the
vault's real path, never inside the vault, where whoever sent it could have written it:

```json
{
  "version": 1,
  "migrated": "2026-11-05T19:00:00.000Z",
  "vaults": {
    "/Users/me/Quire/My First Vault": {
      "state": "trusted",
      "since": "2026-11-05T19:00:00.000Z",
      "how": "created | migrated | chosen",
      "approved": { "<page id>": ["<sha256 of a command>"] },
      "declined": { "<page id>": ["<sha256 of a command>"] }
    }
  }
}
```

- Trusted without asking: a vault `createVault` makes from an empty or new folder (New vault, the
  first-run vault, the CLI), the app's default vault, and once (`migrated`) every vault
  `config.json` already listed when trust shipped.
- Any other vault (Open Vault on a folder that has files, a vault made elsewhere, a vault picked
  from the list that the store doesn't know) opens in state `ask`: the window asks "Do you trust
  the author of this vault?" with "Trust vault" and "Open in restricted mode" (Enter, Esc and a
  click outside pick restricted). `ask` is enforced as restricted until answered.
- Restricted: no backend starts and no build runs (`commandGate`, called by `ensureBackend` and
  the build queue). A built page whose output is committed still shows; one without says it
  needs a build. `query`, `files.read` and `embed.setHeight` only reach the calling page. Every
  `quire://` response carries a Content-Security-Policy (`restrictedCsp`): the page's own
  origin, `quire://runtime` and embeds of other pages, nothing from the network (the browser
  server sends the same with its own origin). Pages can't start Noteblock AI (`target: "block"`).
  A link a page opens in the browser asks first. A slim bar over the page says so, with "Trust
  vault"; Settings › Vault switches either way (`quireApp.setVaultTrust`).
- Trusted: commands are approved per page id by the sha256 of each `backend.run` and `build`
  command. Approved: everything present when the vault became trusted (taken the first time the
  app opens it after that), commands saved from the app's editor (`quire:writeFile` on the
  manifest), pages made from a template, and anything an agent writes while it holds the page's
  `quire edit` lock (approved when the lock goes). Anything else (a sync pull, another program)
  doesn't run: the window gets `trust-request` `{page, title, commands: [{kind, name, cmd}]}`
  and asks once, "Run" / "Don't run" (`quireApp.answerCommands`). "Don't run" is remembered
  until the command changes; Start in the Backend panel or Build asks again. Publishing a page
  that builds goes through the same gate. Only command text is checked: new code behind an
  approved `node server.js` still runs.
- In any vault, a page's `ai.start` (an /ai block) only goes through within Chromium's
  transient user activation (about 5 s) of a real click or key press in that page frame, with
  the frame focused (`gestureIn` in App.jsx); otherwise it's refused.
- Checks: `QUIRE_VAULT` is trusted unless `QUIRE_TRUST` is `restricted`, or `ask` (drops it from
  the store so the prompt shows).

## Page runtime (`window.quire`, inside each page iframe)

```js
quire.page            // {path, title, id, readOnly}
quire.store.table(name) → {
  all() → Promise<Row[]>, get(id), insert(obj), update(id, patch), remove(id),
  subscribe(cb) → unsubscribe   // cb() after any write to this page's table, from any frame
}
quire.kv.get(key) / quire.kv.set(key, value)          // Promise
quire.query(pagePath, table) → Promise<Row[]>          // read another page's table (read-only)
quire.files.read(pagePath, file) → Promise<string>     // read another page's file as text (read-only)
quire.pages() → Promise<Node[]>                        // tree, no dirs
quire.navigate(pagePath)
quire.ready → Promise                                  // resolves once the parent has answered
```

`<quire-embed src="Child">`: the runtime replaces it with an auto-height iframe of that page.
The height comes from the embedded page's `.noteblock` `"embed": {"height": N}` when set (dragging
the embed's bottom edge in edit mode writes it, double-click clears it), else from the page's
content. A `height="N"` attribute on one `<quire-embed>` overrides both for that embed.
`src` is relative to the current page; a leading `/` means the vault root. The embed shows a
header row with the page title and an "Open" link, styled like the sample page. The embed is
another page's origin and process: its DOM and storage are out of reach of the page holding it.

`quire.files.read(pagePath, file)` (rpc `files.read {page, path}`) is how a page reads another
page's files now that `fetch("../Other page/…")` is refused. `pagePath` is a vault path like
`quire.query`'s (`""` or `null` = this page). It returns the file as UTF-8 text, from the
snapshot while that page is locked, up to 10 MB. It refuses `..`, dotfiles (`.noteblock`, `.env`),
`data/`, `node_modules/` and the page's backend folder. A published page can read only its own
files (a plain `fetch`).

### Messages: page ⇄ renderer (postMessage, every message has `quire: 1`)

- page→parent `{type:"rpc", id, method, params}` → parent→page `{type:"rpc-result", id, result}`
  or `{…, error}`. Methods: `store.all|get|insert|update|remove {page, table, …}`,
  `kv.get|kv.set {page, key, value}`, `query {page, table}`, `pages {}`, `navigate {page}`,
  `save {page, regions}` (html) or `save {page, markdownBody}` (md), `resize {height}`.
  **Exact params (as implemented in runtime.js).** The caller is the page whose origin the
  message came from: the renderer passes `MessageEvent.origin` (`quire://p-<id>`, which a page
  can't forge) to `quireApp.rpc(origin, …)`, and main maps it to the page by id. An rpc from
  any other origin is refused. The runtime still sends `params.from`, which is ignored. Store,
  kv, save and `files.read` with no page act on the caller. `query`, `files.read` and
  `navigate` act on `params.page`, the target page; `pages` returns the tree.
  `embed.setHeight {page, height}` writes the target's `.noteblock` and is refused unless the caller
  embeds that page (a `<quire-embed>` in its entry or source, markdown `![[…]]` too).
  - `store.all {table}` · `store.get {table, id}` · `store.insert {table, obj}` ·
    `store.update {table, id, patch}` · `store.remove {table, id}`
  - `kv.get {key}` · `kv.set {key, value}`
  - `query {page, table}` · `navigate {page}` · `pages {}` ·
    `save {regions}` or `save {markdownBody}`
  - `resize` is NOT an RPC. It's a plain `{quire:1, type:"resize", height}` sent to
    `window.parent` and handled by the page runtime. The renderer ignores it.
  - `files.read {page, path}` · `embed.setHeight {page, height}` · `storage.migrated {}`
  - After any store/kv write, the renderer broadcasts `{type:"store-changed", page: <caller>,
    table}` to the top page frame (`table: null` for kv). The runtime relays it to embeds.
  - The renderer must not reload a page for `page-files-changed` events caused by its own
    `save`. Main skips the watcher event for any file it wrote itself in the last 1.5 s.

  **Routing:** `runtime.js` is a classic (non-module) script, so `window.quire` exists before
  any page module runs. Every runtime posts RPCs straight to `window.top` (the renderer) with
  `params.page` set to its own page path, which it reads from `<meta name="quire-page">`. The
  renderer answers to `event.source`. `resize` is the exception: it goes to `window.parent`,
  the page holding the embed, which sizes that iframe. `mode` and `store-changed` are posted by
  the renderer to the top page frame, and each runtime relays them to its own embed iframes.
  Embedded pages are never text-editable; only the top page gets edit mode. An embed is
  read-only only when its own page is locked.
- parent→page `{type:"mode", edit: bool, readOnly: bool}` and `{type:"store-changed", page, table}`.
- Find in page (⌘F, below): parent→page `{type:"find", seq, query, matchCase}` →
  `{type:"find-count", seq, count}`; `{type:"find-active", seq, index}` (−1 clears) →
  `{type:"find-shown", seq, rect}`; `{type:"find-selection", seq}` → `{…, seq, text}` (the top
  page's selected text; it also remembers focus and caret); `{type:"find-clear", restore}`.
  Each runtime answers to `event.source`, searching its own document and asking its own embed
  frames the same way (500 ms each; a silent embed counts 0), so counts and order follow the
  page. page→top `{type:"find-escape"}` when Esc is pressed in a page while a search is up.
- parent→page `{type:"ping", seq, unresponsive}` → page→`event.source` `{type:"pong", seq, page, heap}`;
  page→top `{type:"page-error", page, error}` and `{type:"embed-kill", page}`. See "Crashes,
  freezes and errors".

### Dropped and resized images

In edit mode an image file dragged in from Finder (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO; not
SVG, which can carry script, and not HEIC, which Chromium can't show) is read in the frame and
sent as a data URL to the `files.addImage` RPC. Main writes it to `<page>/images/<name>` (made
safe, `name 2.png` on a clash, 25 MB at most, refused on built pages) and returns the src
relative to the entry. The editor inserts `<p><img src alt=""></p>` before or after the
top-level block under the pointer (replacing it when it's an empty paragraph); a line shows
where while dragging. A clicked image gets a corner handle: dragging it sets the `width`
attribute (kept as an `<img>` tag in markdown pages). Backspace or Delete removes a picked image.

### Saving text edits (WYSIWYG)

Edit mode is on by default unless the page is read-only. In edit mode the runtime groups each
run of consecutive top-level body children whose tag is in `TEXT_TAGS` into one
`<div data-q-region contenteditable>`. On an empty body it adds one empty region holding a
`<p>`. Everything else (div, section, script, style, custom elements, anything with
`data-app`) stays as an atomic block, outlined on hover.

Only what is in the file is editable. Before building regions the runtime fetches the served
document and compares each top-level block with its counterpart there. A block whose live DOM
differs (a script rendered into it, e.g. a React root or a list filled from an API), and any
top-level node with no `data-q-i` (inserted by a script), is marked `data-q-made`: atomic,
`contenteditable=false`. A
MutationObserver keeps doing this in edit mode for script changes that land later (mutations
within 300 ms of a user event count as editing). On save a `data-q-made` block is written as
the file had it (or dropped when it was never in the file), so script output never reaches the
file. Typing that can't land anywhere editable (the caret is in a `data-q-made` block, or the
page has no editable text at all) shows a short notice at the top for 4 seconds: "This text comes
from the page's code. Edit it in Source." (× hides it until the page reloads). Entering edit mode
shows nothing.

Keys typed into the page's own text belong to the editor. In edit mode, a `keydown`, `keypress`
or `keyup` whose target is text Noteblock made editable (a `data-q-region`) is handled by the editor
and never reaches the page's scripts, so a page-wide shortcut (a game's F for full screen, Space
to jump) doesn't fire while someone types a paragraph. Everything else is untouched: Escape always
reaches the page; so does every key in the page's own `<input>`, `<textarea>`, `<select>` or
contenteditable, in anything its code drew, and every key in Rendered view. `input` and
`beforeinput` events still fire as usual, so a page that reacts to its own text changing should
listen for those, not for keys.

On input (debounced 400 ms) the runtime sends
`regions: [{replace: [i…], before: k|null, html}]` for every region:
- `replace` is the `data-q-i` indices the region started with,
- `before` is the `data-q-i` of the next non-text sibling (or null if none),
- `html` is the region's innerHTML with `data-q-*` and `contenteditable` stripped.

`applyRegions` removes the `replace` elements from the RAW file's body, inserts `html` where
the first one was (or before element `before`, or at the end of body when both are empty), and
leaves every other byte of the file alone (head, scripts, app blocks). Markdown pages send the
whole body instead; main runs `htmlToMarkdown` on it.

The runtime UI inside the page is the selection toolbar (Bold, Italic, Link, H2, H3, Bullets)
and a `/` menu anywhere a word can start (`[[` opens the page-link picker) (Text, Heading, Subheading, Bullet list,
Numbered list, Quote, Code, Divider, Embed page…). It's styled with Ledger tokens.

### The header names the page

When the caret leaves a page's header with changed text (blur, or the caret in another block, Enter
included) and that header said the page's name, the page is renamed to it. The header is the first
`h1` directly in the first text region, which in markdown is the first `# ` line. Comparison is
trimmed, whitespace collapsed, case exact, with `/` read as `-` (`headerName` in `core/html.mjs` and
`runtime.js`; the decision is `shouldRenameFromHeader`).

The runtime saves, then posts `header-rename {name}`; the renderer calls `quire:rename` and answers
`header-rename-result {ok, path?}`. A refused name (empty, a character `checkName` refuses, taken) is
logged and leaves the text as typed, and the header stays tied for the life of the frame: fixing it
renames. The frame stays up through the rename: `usePageSwap.follow` keeps its React key and src, and
the runtime updates its path and `history.replaceState`s its URL. If rewriting links changed the page's
own file, it swaps as for any file change. Skipped in the floating note (its window has no way to
follow a rename), read-only and built pages, embeds, mobile hosts and during an IME composition.

The other way: `quire:rename` changes a first `h1` / `# ` line that said the old name, in the same
commit (`renameHeader`, only those bytes), not on a built page. The file's `<title>` isn't touched
either way. The renderer flushes the page on screen before a sidebar rename.

## Crashes, freezes and errors

**Processes.** The app UI (`file://`) runs in its own renderer. Every page frame is an
out-of-process iframe on its own site (`quire://p-<id>`), so each page, and each embed of
another page, has its own process (checked with `frame.osProcessId` in Electron 44,
`scripts/verify-origins.mjs`). A `while (true) {}`, a memory bomb or a crash in a page stops
that page only: the page holding a frozen embed keeps scrolling and saving, and the sidebar,
tabs and top bar keep working. Two frames of the same page in one window share a process. Electron fires nothing when an out-of-process iframe's process dies (no
`render-process-gone`, no `child-process-gone`), so Noteblock watches pages itself.

**Heartbeat.** The renderer (`RecoveryOverlay.jsx`, `usePageHealth`) posts `{type:"ping", seq,
unresponsive}` to the page frame every second; the runtime answers `{type:"pong", seq, page,
heap}` to `event.source` and passes the ping on to its embeds, which pong to their parent.
When the page has been quiet for `limits().unresponsiveSeconds` (read on every check), the
renderer calls `probePage(src)`: main (`app/main/page-health.mjs`) finds the frame, checks its
process is alive and runs one line of script in it with a 1 s timeout. Answered → fine (a page
without the runtime). Timed out → **frozen**. No frame or no process → **gone**: "ran out of
memory" when its JS heap was over half its limit in the last pongs or main saw its process at
1.5 GB, else "crashed". `probePage` also names every page on the same process.

**Card.** Over the page area: "<title> stopped responding" / "crashed" / "ran out of memory",
one line of detail, **Reload page**, **Open source**, and **Wait** while frozen (hides the
card for another `unresponsiveSeconds`; a pong clears it on its own). A frozen frame can't be
navigated from inside, so Reload (and Open source) first call `killPageProcess(src)`, which
SIGKILLs that renderer (never the app UI's, refused by pid) and waits for it to exit, then the
iframe is re-created and gets a new process. With `autoReloadCrashed` on, a crashed page reloads
by itself up to `autoReloadLimit` times a minute, then shows the card.

**Embeds.** Each runtime watches its embeds' pongs. An embed that has answered once and then
goes quiet for `unresponsiveSeconds`, while its page keeps answering, gets a small card in its
own slot with Reload: the runtime posts `{type:"embed-kill", page}` to the renderer, which
calls `killPageProcess(embedSrc, {keep: pageSrc})` (refused if the embed shares the page's
process), then the runtime reloads that iframe in a new process. The renderer takes the page
that asked from the message's origin. A crashed embed shows the same card in its slot.

**Floating note.** `Floating.jsx` runs the same heartbeat on the note's page: a frozen or
crashed note shows the card inside the note (Reload page, Wait), and embed Reloads in the note
work the same way.

**Window.** The app UI's own renderer: `unresponsive` asks Wait / Reload window (reload =
`forcefullyCrashRenderer()` + `reload()`); `render-process-gone` reloads the window, up to 3
times a minute, then asks.

**Errors.** The runtime forwards uncaught errors and unhandled rejections as `{type:
"page-error", page, error: {key, kind: "error"|"rejection", message, source, line, column, stack,
time, count}}` to `window.top`: at most 20 a minute per page; a repeat of the same error bumps
`count` and is re-sent at most once a second. Line numbers match the page's own file (the
runtime block is injected on the `<head>` line). With `limits().errorBadge` on, the top bar
shows a red-dot "N errors" pill that opens a panel (newest first, file:line, ×count, Copy,
Clear). The list belongs to one load of the page and is cleared on reload or page change.
Embeds' errors land in the same list, marked "in <embed>".

## Preload API (`window.quireApp`, renderer only)

```js
getState() → {vault, vaultName, user}
listTree() → Node[]
readEntry(path) → {file, format, content}       writeEntry(path, content)
createPage(path, {format})  → Page              createFolder(path) → Folder
listTemplates() → {dir, templates}              createFromTemplate(template, folder, name?) → Page
saveAsTemplate(path, name?)  restoreTemplates()  trashTemplate(rel)  // each → {dir, templates}
revealTemplate(rel)  // "" opens the folder     watchTemplates(on)  onTemplatesChanged(cb)
addTemplateFromUrl(url, {allowCode?, commands?}) → {added} | {needsConfirm: {commands}}
contextMenu(items) → id|null                    // native menu; items [{id, label, accelerator?} | {type: "separator"}]
reveal(path)                                    // Finder
copyPath(path) → absolute path                  // vault-relative ("" = vault) → clipboard
openInBrowser(pagePath) → url                   // public URL, or the local page server
publishStatus(path) → {public, upToDate, busy}  publish(path, host?)  unpublish(path)
folderPublishStatus(path) → {public, upToDate, busy}  publishFolder(path)  unpublishFolder(path)  // onPublishStatus events for these carry `folder` instead of `path` (error adds `failed`: page paths whose build failed)
onPublishStatus(cb({path, state: "signin"|"publishing"|"unpublishing"|"done"|"error", …}))  // "signin": needs a Noteblock account (kind, host); the window shows SignInDialog
publishTargets(path) → {quireHost, quireSignedIn, cloudflare, defaultHost}  // what the Publish button offers
publishingInfo(fresh?) → {selfHost, quire: account, cloudflare: {loggedIn, email, accounts} | null}
setSelfHost(on)  hostingSignIn() → account  hostingCancelSignIn()  hostingSignOut() → account
cloudflareLogin()  cloudflareCancelLogin()  cloudflareLogout() → whoami
onHostingChanged(cb)  onCloudflareStatus(cb({state: "waiting"|"done"|"error", log?, account?, error?}))
getShortcuts() → [{id, label, default, accelerator, priority}]   // priority: "quire"|"page"|null (null = default)
setShortcut(id, accelerator) → list             // "" removes; throws "Already used by X"
resetShortcuts() → list    suspendShortcuts(on) // while Settings records a key
getShortcutPriority() → {default: "quire"|"page", overrides: {id: "quire"|"page"}}
setShortcutPriority("quire"|"page") → getShortcutPriority()
setShortcutPriorityOverride(id, "quire"|"page"|null) → getShortcuts()   // null follows the default
rpc(pagePath, method, params) → result          // the page-runtime methods above, run in main
openVault()                                     // folder picker → becomes current, reload
activity() → {app, backends, builds, limits, running, totals}   // Settings → Activity
setBackendPolicy({idleMinutes?, maxRunning?}) → activity()      stopAllBackends() → activity()
limits() → {unresponsiveSeconds, autoReloadCrashed, …}   limitsSchema() → [{name, block, key, value, default, min, max, label, kind}]
setLimits(patch) → limits()   resetLimits() → limits()     // limits.mjs; throws a sentence on a bad value; backend ones apply at once
probePage(src) → {state: "ok"|"frozen"|"gone", pid, pages, reason?}   killPageProcess(src, {keep?})
onTreeChanged(cb)  onLocksChanged(cb(locks))  onPageFilesChanged(cb(path))   // each returns off()
```

Main watches the vault (`fs.watch` recursive) and debounces events by 150 ms. Changes under
`.noteblock/locks` fire `locks-changed`; changes inside a page folder fire `page-files-changed`
with that page path (ignoring `data/` and dotfiles other than `.noteblock`); a page's `.noteblock`
changing, or anything changing outside a page (folders or pages appearing/disappearing),
fires `tree-changed`.

### Sidebar, menus and shortcuts

- Clicking a folder expands/collapses it; clicking a page opens it.
- Right-click a row or the empty sidebar → native menu: New page, New from template…, New folder, Reveal in Finder,
  Copy path (the absolute path of the page folder, folder or file; the vault on empty space),
  Open in browser (pages only, see "Open in browser" above), Move to Trash. A page's own file
  gets no New items. New items go in the clicked folder, the clicked page's folder, or the
  vault root. The name is typed into an inline row in that folder (Enter creates, Esc cancels).
- With Source on, a page's own files (backend/server.js, …) are listed under it. Clicking one
  opens it in the current tab, like a page; ⌘-click opens it in a new tab (or the tab already
  showing that file).
- Tabs: ⌘T new, ⌘W close, ⌘⇧] / ⌘⇧[ next / previous (rebindable), Ctrl+Tab / Ctrl+⇧Tab
  always cycle too, ⌘1…⌘8 pick a tab, ⌘9 the last.
- Developer tools (`app/main/page-devtools.mjs`, `docs/decisions/page-devtools.md`):
  - Inspect page, ⌘⌥J (rebindable, "Inspect page" in Settings → Keyboard shortcuts; also View →
    Inspect Page, "Inspect page" in the top bar's renderer menu, and "Inspect" in an embed's
    right-click menu): a Chrome DevTools window for just the page or embed that has focus, in
    the main window or the floating note. Elements is that page's document (an embed of
    another page shows as an opaque iframe), Console shows its output and evaluates in it,
    Sources its files and the shared quire://runtime/ scripts it loads, Network its requests
    (/api included), Performance and Memory its renderer process. Titled "<Page title> —
    DevTools"; one window per page or embed, so Inspect again brings it forward, and several
    can be open at once. When the page's iframe is replaced (a reload, a recovery Reload, a
    switch to another tab) the window waits and reconnects to the page's next iframe; it closes
    when the page is deleted, no tab of its window shows it (for an embed: no tab shows the
    page holding it), or its window closes.
  - App developer tools, ⌘⌥I (rebindable, "App developer tools"): Electron's own DevTools for
    the whole window in front, for debugging Noteblock itself.
  - How: the window's `webContents.debugger` attaches while an inspector of that window is
    open, `Target.attachToTarget` gives a flat session for the page's iframe target, and a
    WebSocket relay (`app/main/devtools-relay.mjs`) on 127.0.0.1, random port, 48-hex-digit
    token path, one connection, Origin devtools:// only, carries that one session to the
    DevTools frontend bundled with Electron (`devtools://devtools/bundled/devtools_app.html?ws=…`).
    No `--remote-debugging-port`. The frontend can't discover, attach to or create other
    targets; other pages' iframes it would auto-attach are detached instead of shown.
  - In an inspector window Noteblock's shortcuts don't take keys first (⌘P opens a file in
    DevTools).
- Find in page: Edit → Find… `CmdOrCtrl+F` (rebindable, "Find"), Find Next `CmdOrCtrl+G`,
  Find Previous `Shift+CmdOrCtrl+G` (fixed), in the window in front (the floating note
  searches its own page). A bar at the top-right of the page area (`renderer/src/FindBar.jsx`):
  box prefilled with the page's selected text (one line, ≤ 200 chars) or the last search,
  "3 of 12" / "No results", ↑ ↓, Aa (match case), ×. Live as you type (120 ms debounce),
  Enter / ⇧Enter next / previous, Esc (in the bar or in the page) closes it and puts focus and
  the editor's caret back. The search runs in the page runtime, never over Noteblock's chrome:
  rendered text only (hidden elements, editor UI, form fields and the embed card's head are
  skipped, white space collapses, a match never spans blocks), embeds included in document
  order, matches drawn with CSS Custom Highlights (`::highlight(q-find)` /
  `::highlight(q-find-active)` in theme.css), so the document is never changed and nothing of
  a search can be saved. Works in Noteblock editor, Rendered and markdown pages. In Source +
  preview and the file view a code editor takes the keys instead: they open CodeMirror's own
  search panel (and its next / previous).
- App menu shortcuts are Electron accelerators kept in `~/.noteblock/config.json` `shortcuts`
  (only overrides). Defaults: New page `CmdOrCtrl+N`, New page from template
  `CmdOrCtrl+Alt+N`, New window `CmdOrCtrl+Shift+N`, New folder `CmdOrCtrl+Ctrl+N`, Cycle
  view (Noteblock editor → Rendered → Source + preview) `CmdOrCtrl+E`, Open vault `CmdOrCtrl+O`, Settings `CmdOrCtrl+,`, Next tab `Shift+CmdOrCtrl+]`, Previous
  tab `Shift+CmdOrCtrl+[`. ⌘N / ⌘⇧N / ⌃⌘N create in
  the current page's folder. ⌘⇧N opens the template picker (type to filter, ↑↓, Enter, Esc),
  then the inline name row, prefilled with the template title.
- Settings → Templates: the folder path (Reveal in Finder), each template with Reveal and
  Delete (to the Trash), Save current page as template…, Restore starter templates. The list
  follows the folder while the tab is open.
- Settings (⌘,) is a modal with a Keyboard shortcuts section: click a shortcut, press keys
  (needs ⌘, ⌃ or ⌥ unless it's an F-key), Esc cancels, ⌫ removes, per-row Reset, Reset all.
- Shortcut priority, for when a page also listens for one of Noteblock's keys. `config.json`
  `shortcutPriority`: `"quire"` (default, absent) or `"page"`, and
  `shortcutPriorityOverrides: {<shortcut id>: "quire" | "page"}` for single shortcuts
  (Settings → Keyboard shortcuts: "Noteblock first" / "Page first" at the top, the row's ⋯ menu
  for Default / Always Noteblock / Page first; Reset all clears the overrides too).
  - Noteblock first: every window (main and floating note) catches the key in main's
    `before-input-event`, before the page or its iframe (out-of-process ones too) sees it, and
    runs the app-menu item that owns that accelerator (`app/main/keys.mjs`). The page never
    gets the keydown.
  - Page first: the page gets the keydown first (Chromium's default on macOS); if it calls
    `preventDefault` the menu item doesn't fire, otherwise it does.
  - Never routed either way: Edit roles (undo, redo, cut, copy, paste, select all), ⌘S, other
    role items (reload, zoom, quit…), ⌘⌫ (the window's own, for Move to Trash), keys with
    neither ⌘ nor Ctrl, and everything while Settings records a shortcut. The floating note's
    own Esc / ⌘W (hide) still win there.
  - Matching follows the layout for letters (⌘P is the key labelled P) and the physical key
    for digits, brackets, comma and other punctuation, like the menu.

### Floating note

A small always-on-top window (like Raycast's Floating Notes) that shows one vault page in the
editor. It floats over every app and Space, full-screen ones included, and a global shortcut
toggles it from anywhere, also when the main window is closed: hidden → shown and focused,
focused → hidden. Esc and ⌘W hide it. Closing it only hides it. On the Mac it's a non-activating
panel: it takes the keyboard while the app you were in stays frontmost, so the main window doesn't
come forward. Window managers (Raycast, Rectangle) act on the frontmost app, so they can't move it;
drag it instead. A window manager's moves, where they do apply (Windows), are saved as its bounds.

- Any page can be the note. The window (`app/main/floating.mjs`, `renderer/floating.html` →
  `src/Floating.jsx`) hosts the same `quire://vault/<page>/` iframe as the main window and
  answers its rpc messages through the same `quireApp.rpc` → `quire:rpc` path, so edits
  autosave and commit as usual. HTML and markdown pages open in the editor; a page whose
  `renderer` is `view` opens read-only, and a locked page shows its snapshot.
- Pages render compact there: the page frame is named `q-floating`, the runtime sets
  `html.q-floating`, and theme.css shows h1–h3 as bold body text with tight margins and padding.
- ⌘P (the menu's Command Palette shortcut) opens a page picker while the note is focused; the
  main window keeps its own palette. Picking a page saves it as `floating.page`.
- Default page: `Floating note` in the vault root, a blank HTML note created the first time the
  window opens with no page picked (`app/main/floating-page.mjs`). If the picked page is gone
  (deleted, renamed, moved, other vault), also while the note is open, the note says so and
  offers "Pick another page" and "New floating note" (creates `Floating note`, or
  `Floating note 2`, 3, … when taken, and switches to it). It never swaps pages by itself.
- A write from either window (rpc save/store/kv, `writeEntry`, `writeFile`) sends
  `page-files-changed` to the other one, since the watcher skips main's own writes. The note
  doesn't reload while it has unsaved typing.
- Settings → Floating note: on/off, the shortcut (default `CmdOrCtrl+Shift+Space`; one the app
  menu uses, or another app holds, is refused), the page, and an Open button. Stored in
  `~/.noteblock/config.json` as `floating: {enabled, shortcut, page, bounds}` (bounds = the
  window's last size and position, default 380×460 at the top right). Capture runs
  (`QUIRE_CAPTURE`) never register the shortcut; `QUIRE_OPEN_FLOATING=1` captures the note
  instead of the main window (`QUIRE_MENU` and `QUIRE_EVAL_FLOATING=<js>` act on it first).

```js
getFloating() → {enabled, shortcut, default, page, defaultPage, pageExists, registered, error, open}
setFloating({enabled?, shortcut?, page?}) → same     // "" shortcut = none
openFloating()  hideFloating()
floatingPage() → {path, title, build, renderer} | {missing: page}   // creates the default page when none is picked
newFloatingNote() → same      // a new note in the vault root, now the note's page
floatingPicking(on)           // the note's picker is open: Esc closes it, not the note
onFloatingChanged(cb)  onFloatingShown(cb)
```

## Web host (`app/web/server.mjs`)

The editor UI over HTTP from a headless machine, for embedding in an iframe:
`pnpm web --vault <dir> --port <n> --token-file <f>`. Plain Node, no Electron in its import
graph. It runs registerIpc's own handlers behind `POST /api/call/<channel>` and sends what main
would send the window as server-sent events on `GET /api/events`; the vault is served at `/v/`
and `/runtime/` by browser-server.mjs's `createVaultRoutes`. Channels that need a window, a
dialog or Electron answer `{error: "Not available in the web editor"}`. Routes, flags, events
and the security model: [web-host.md](web-host.md).

## CLI (`noteblock`)

```
noteblock vault                       print the current vault path
noteblock vault create <dir> [--no-seed]   create (and make current)
noteblock vault use <dir>             make current
noteblock ls [--json]                 folders and pages, 🔒 when locked
noteblock path <page>                 absolute page folder, the thing to edit
noteblock cat <page>                  print the page's entry
noteblock new <page> [--md]           create a page in an existing folder, print its dir
noteblock new <page> --template <t>   the same, copied from a template (path, folder name or title)
noteblock templates                   list the templates (and the folder they live in)
noteblock mkdir <folder>              create a folder
noteblock edit <page> -m "<what>"     lock + snapshot, print its dir; the app goes read-only
noteblock done <page> [-m "<msg>"]    unlock + commit everything ("<msg>" defaults to the lock message)
noteblock abort <page>                put the snapshot back, unlock, no commit
noteblock data <page> [table]         print the page's stored rows as JSON
noteblock import-artifact <file|dir> [--name N] [--url U] [--folder F]
                                  a Claude artifact → a page in Artifacts/ (same --url updates it)
noteblock status                      locks + uncommitted changes
noteblock log [-n 10]                 recent commits
Global: --vault <dir>   --json where it makes sense
```

Exit 0 on success, 1 with a one-line `noteblock: <reason>` on stderr otherwise.

## MCP (`mcp/server.mjs`, stdio)

Tools, all taking an optional `vault`: `quire_list`, `quire_read {page}`,
`quire_begin_edit {page, message}` → `{dir, files}`, `quire_write_file {page, file, content}`,
`quire_end_edit {page, message}`, `quire_abort_edit {page}`, `quire_new_page {page, format}`,
`quire_new_folder {folder}`,
`quire_data {page, table?}`. Each one is a thin wrapper over core.
