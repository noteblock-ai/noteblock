# Sandboxing pages and backends

Status: partly shipped. Proposed 2026-10-21. Per-page origins and rpc `from` from the origin
shipped 2026-10-22. Per-vault trust ("restricted mode", `app/main/trust.mjs`, contract "Trust")
shipped 2026-11-05: it takes the place of the per-page trusted bit below, plus a CSP for
restricted vaults. The two "today" sections below describe the app as it is now; what each
attack looked like before is kept in the git history of this file.

## The question

If you download a template whose code says "scan this laptop for secrets and send them to
this address", do the default macOS permission prompts stop it?

Short answer: for the page's HTML and JavaScript, mostly yes for files outside the vault, but
not for the vault itself, and nothing stops it sending what it can read to the internet. For a
page backend or a build command, no. Those are shell commands running as you, and macOS only
asks about a short list of folders and devices. Your SSH keys, cloud credentials and the
wrangler token are readable without any prompt.

## What a page's HTML and JS can do today

Since 2026-11-05 this depends on whether the vault is trusted on this machine (contract
"Trust"). A vault the app made from nothing, and every vault the config knew when trust
shipped, is trusted. Anything else opened (a folder someone sent, a cloned repo) asks first and
is restricted until the person says otherwise.

In a **restricted** vault a page gets a Content-Security-Policy on every `quire://` response
(`restrictedCsp` in `trust.mjs`, set by `protocol.mjs` `toResponse`): scripts, styles, images,
fonts, media, `fetch` and forms only from its own origin and `quire://runtime`, frames only
other `quire://` pages, `object-src 'none'`. A `fetch`, `<img>` beacon or form post to the web
is blocked by Chromium. `query`, `files.read` and `embed.setHeight` refuse any page but the
caller. `ai.start` from a page is refused. A link the page navigates to opens in the browser
only after a native "Open this link in your browser?" (`main.mjs` `openFromFrame`), since
opening a URL is itself a way to send data out. The browser server sends the same CSP.

In a **trusted** vault pages behave as below, as they always have.

The app window runs with `contextIsolation: true`, `nodeIntegration: false` and
`sandbox: true` (`app/main/main.mjs:162-168`). Pages are shown in an iframe with
`sandbox="allow-scripts allow-same-origin allow-forms"` at `quire://vault/<page>/`
(`app/renderer/src/App.jsx:1124-1131`), and embeds use the same attributes
(`app/runtime/runtime.js:419-422`). The preload's `window.quireApp` is exposed to the app
window, which is a `file://` document (`main.mjs:222`, `app/main/preload.cjs:24`), so a page
in a `quire://` iframe cannot touch it or Node directly. That part is sound.

What a page can still do:

- Read any file in the vault through `quire://vault/...`. The protocol refuses `..`, dotfiles,
  `data/`, `.quire` and the page's backend folder (`app/main/protocol.mjs:131-133`, `:148`,
  `:155`, `:162`), and stays inside the vault root (`protocol.mjs:138`, `:181`). But every
  page shares the one origin `quire://vault`, so page A can `fetch` page B's files, embed B
  and reach into its DOM, and share its localStorage.
- Read any page's data. The `query` RPC opens any page's store by path, and `pages` returns the
  whole tree (`runRpc` in `ipc.mjs`). Restricted vaults refuse `query` for other pages.
- Write any page's data and rewrite its text. Store, kv and save calls act on `params.from`
  (`ipc.mjs:91-93`), which the page sets itself (`runtime.js:100-104`). The renderer accepts an
  RPC from any frame that posts to it, without checking which frame it came from, and passes
  the page's own `from` through (`App.jsx:611-640`). `save` replaces body elements with
  whatever HTML it is given (`ipc.mjs:173-180`, `core/html.mjs:138`), so one page can plant a
  `<script>` in another page, and the autosave commits it and sync pushes it.
- Start other pages' backends and call their APIs: loading `quire://vault/B/` starts B's
  backend (`main.mjs:342`) and `quire://vault/B/api/...` is proxied to it (`protocol.mjs:156`,
  `:290`).
- Talk to the internet freely, in a trusted vault. There is no Content-Security-Policy there, and
  the scheme is registered with `corsEnabled` and fetch support (`main.mjs`). CORS limits
  reading responses, not sending: a POST with `mode: "no-cors"` or an image URL carrying data
  gets out. A restricted vault's CSP stops this.
- Use the camera, microphone or location after a single macOS prompt. There is no
  `setPermissionRequestHandler` in `app/main/`, and Electron approves every permission request
  unless one is set ([Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)).
  macOS asks once whether Quire may use the camera; after that every page gets it.

Links to `http(s)` open in the browser (`main.mjs:209-219`) and the iframe has no
`allow-top-navigation` or `allow-popups`, so a page cannot take over the window.

## What a backend or build can do today

In a restricted vault (or one whose prompt isn't answered yet) nothing below runs: `ensureBackend`
and the build queue both ask `commandGate` (`trust.mjs`) first and stop there. A built page
with committed output still shows; one without shows a note that it needs a build. Publishing a
page that builds is refused.

In a trusted vault, a backend or build command runs only when this machine approved that exact
command for that page (sha256 per page id in `trust.json`). Commands present when the vault
became trusted, commands saved from the app's editor, pages made from a template and whatever an
agent writes under a `quire edit` lock are approved. A command that arrives any other way, a
sync pull in particular, waits for "Run" / "Don't run" in a prompt that shows it verbatim.

What an approved command can then do is unchanged:

A backend is `/bin/sh -c <cmd>` from `.quire`, run in the backend folder with your login PATH,
the page's `.env` and your full environment (`app/main/backend.mjs:146`, `:194-200`). A build
is the same, run in the page folder (`core/build.mjs:46`). Neither is sandboxed. They run with
your user's privileges and can read anything you can, open any network connection and spawn
anything.

Approved commands still run without being asked each time. A backend starts the first time its
page or an embed of it is served (`protocol.mjs` `onEntry`), and whenever that page's manifest
changes on disk; a build runs when a page's source files change on disk. Both include sync
pulls. The gate checks only the command text: a sync that changes `server.js` behind an approved
`node server.js`, or a `package.json` script a build runs, still runs. Closing that needs
sandbox-runtime (below) or a hash of the whole backend folder.

macOS privacy controls (TCC) do not cover this. They prompt for Desktop, Documents, Downloads,
iCloud Drive, removable and network volumes, plus contacts, calendars, photos, camera,
microphone and similar ([protected folders, Tahoe](https://eclecticlight.co/2026/04/15/privacy-which-folders-are-protected-in-tahoe/)).
The prompt names Quire as the responsible app, so once Quire has Documents access every backend
has it. Everything else in your home folder is unprotected: `~/.ssh`, `~/.aws`, `~/.config`
(including wrangler's plaintext OAuth token at `~/.config/.wrangler/config/default.toml`,
per [wrangler docs](https://developers.cloudflare.com/workers/wrangler/commands/general/)),
`~/.npmrc`, `~/.netrc`, shell history, git credentials in files, and every other Quire vault.
The default vault is `~/Quire/...` (`main.mjs:83`), outside the protected folders. The macOS
firewall only filters incoming connections, so outgoing traffic is never prompted
([Apple: firewall](https://support.apple.com/guide/mac-help/block-connections-to-your-mac-with-a-firewall-mh34041/mac)).
Gatekeeper checks apps you open, not `node server.js` run by a shell.

So the template in the question no longer runs when someone sends you the vault: it opens
restricted. It still works if you trust that vault, or approve its command when a sync brings
it in, or if it rides inside code an approved command runs. A page folder dropped on the
sidebar of a trusted vault asks before its commands run, since nothing approved them.

## Options

1. Per-page capabilities in `.quire`, approved on first run. The brief already planned this
   (`docs/brief.md:38-42`). Capabilities: `backend`, `build`, `network` (with a host list),
   `read-pages`, `write-pages`, `camera`/`microphone`. Cheap, and the approval screen is the
   moment to show what will run.
2. A trusted bit. Pages you created in this app on this Mac are trusted and skip the prompt.
   Pages that arrive by import, artifact import, download or sync from another person are
   untrusted until approved. Store it in local config keyed by page id and a hash of the
   backend and build commands, never in the synced `.quire`, or a template could ship
   `"trusted": true`.
3. Sandbox backends with `sandbox-exec`. Deprecated as a command but still working on current
   macOS and used under the App Sandbox
   ([sandbox-exec notes](https://gastown.dev/docs/research/macos-sandbox-exec)). Anthropic's
   `@anthropic-ai/sandbox-runtime` wraps it with a deny-by-default network proxy and filesystem
   rules, Apache-2.0 ([sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)).
   A profile for Quire: write only the page folder and a temp dir, deny reads of `~/.ssh`,
   `~/.aws`, `~/.config`, other vaults and the rest of home, network only to the allowlisted
   hosts plus localhost for its own port.
4. App Sandbox for the whole app. Needs entitlements and security-scoped bookmarks for the
   vault, and breaks running the user's own `node` and `pnpm`. Not worth it while backends run
   user toolchains.
5. Lock down the renderer side: one origin per page, CSP, RPC checks.

## Recommendation

Do 5 and 2 first, then 1, then 3. Renderer fixes close the cross-page writes and cost little.
The trusted bit with "backends and builds off until approved" closes the template attack
without a sandbox. Capabilities make the approval specific. `sandbox-exec` through
sandbox-runtime then limits what an approved backend can reach, which also protects against a
backend you approved that later turns hostile through a sync.

## What to build

- [x] Renderer: accept RPCs only from page frames and set `from` from the frame's origin,
      ignoring the page's own value. Done: `App.jsx` / `Floating.jsx` pass `MessageEvent.origin`
      to main, which maps `quire://p-<id>` to the page and refuses anything else
      (`ipc.mjs` "quire:rpc"); `runRpc` ignores `params.from`. `embed.setHeight` is refused
      unless the caller embeds the target.
- [x] Give each page its own origin so pages cannot read each other's files, DOM or storage;
      keep cross-page reads behind `query`. Done: `quire://p-<page id>/<page path>/`
      (`app/main/origins.mjs`), one renderer process per page. Electron skips CORS for custom
      schemes, so a `session.webRequest` guard (`protocol.mjs` `originGuard`) refuses
      cross-page fetches, subresources and `/api` calls; cross-page reads go through `query`
      and the new read-only `quire.files.read`. Old shared localStorage is copied into each
      page once (`page-storage.mjs`). Dotfiles in a page (`.env`) are no longer served. Still
      open: an iframe or link can load (and so start the backend of) another page, as embeds
      need; the browser server ("Open in browser") keeps one shared origin.
- [~] Add a CSP to served pages. Done for restricted vaults (`restrictedCsp`, no network at
      all). Still open: a CSP for trusted vaults with hosts from a `network` capability.
- [ ] `session.setPermissionRequestHandler` that denies by default and asks per page.
- [x] Untrusted-by-default, per vault rather than per page: a vault this machine didn't make or
      already know opens restricted until trusted (`trust.mjs`, contract "Trust").
- [x] Trust stored locally (`<configDir>/trust.json`) per vault, with approvals per page id plus a
      sha256 of each `backend.run` and `build` command; a command that arrives from outside the
      app asks again, showing it. Backends don't start from manifest changes until approved.
- [ ] `capabilities` in `.quire` (`docs/contract.md`), shown on first run.
- [ ] Run backends and builds under sandbox-runtime with a per-page profile and network
      allowlist; opt out per page only for pages you made.
- [ ] Strip the parent environment for backends down to PATH, HOME, the page's `.env` and
      Quire's own variables (`backend.mjs:194`), so tokens in the app's environment do not leak.
