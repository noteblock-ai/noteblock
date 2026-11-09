# Web host

`app/web/server.mjs` serves Noteblock's own editor UI over HTTP, so a headless machine
can host a vault and another app can show the editor in an iframe. It is plain
Node 22: nothing in its import graph loads Electron.

The handlers are the desktop app's own. The server calls `registerIpc` (app/main/ipc.mjs) with a
recording `ipcMain`, so `POST /api/call/<channel>` runs exactly what `window.quireApp.call` runs in
the app. Whatever the Electron main process sends the window (`webContents.send`) goes out as a
server-sent event instead. The vault is served by the same routes as "Open in browser"
(`createVaultRoutes` in app/main/browser-server.mjs).

## Running it

```sh
pnpm build    # the editor bundle, app/renderer/dist (the server answers 503 on /embed without it)
pnpm web --vault ~/Quire/Work --port 4790 --token-file ~/.noteblock/web-token
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--vault <dir>` | required | The vault to serve. It must already be a vault (`quire vault create <dir>`). |
| `--port <n>` | required | Port to listen on (`0` picks a free one and prints it). |
| `--token-file <f>` | required | File holding the access token. A missing file gets a new random token, written mode 0600. |
| `--host <addr>` | `127.0.0.1` | Address to bind. Keep it on loopback and put `tailscale serve` in front. |
| `--sync-every <sec>` | `30` | Vault sync interval when the vault has a git `origin`. `0` turns sync off. |

The token file holds one line, at least 16 characters. To rotate the token, replace the file and
restart the server; existing cookies stop working.

The config directory (shortcuts, limits, templates, publishing state) is the normal one,
`~/.noteblock`, or `NOTEBLOCK_CONFIG_DIR` / `QUIRE_CONFIG_DIR` when set. The server never changes
which vault the desktop app has open.

## Routes

Every route except `/embed` needs the cookie `nbw=<token>` or `?t=<token>`; without either it
answers 401. Tokens are compared in constant time.

| Route | What it does |
| --- | --- |
| `GET /embed?folder=<f>&t=<token>` | Sets the cookie (`HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when `X-Forwarded-Proto: https`) and serves `app/renderer/dist/index.html` with `<script>window.__NB_WEB__={folder: "<f>"}</script>` before the bundle. `folder` is vault-relative; the renderer decides what to do with it. |
| `GET /` | Redirects to `/embed`, keeping the query. |
| `POST /api/call/<channel>` | Body `{"args": [...]}`, `Content-Type: application/json` (anything else is 415). Answers 200 `{"ok": result}` or `{"error": message}`, the same envelope the preload unwraps. Unknown channel: 404 `{"error"}`. |
| `GET /api/events` | `text/event-stream`. Each broadcast is `event: <channel>\ndata: <JSON array of args>\n\n`. A `: ping` comment every 25 s keeps proxies from closing it. |
| `GET /v/<page path>/<file…>` | What `quire://vault/…` serves: the page entry (transformed), its files, plain files in folders. `data/`, dotfiles, manifests and the backend folder are never served. |
| `GET /runtime/<file>` | What `quire://runtime/…` serves (runtime.js, theme.css, fonts, vendor). |
| `POST /_quire/rpc` | Page runtime rpc: `{page, method, params}` → `{ok}` or `{error}` (ipc.mjs `runRpc`). |
| `/v/<page>/api/…`, `/api/…` | The page's backend, when its `.noteblock` sets `backend.proxy`. A bare `/api/…` is matched to its page by the Referer. `/api/call/` and `/api/events` are the server's own and take precedence. |
| `GET /<file>` | Any other file of `app/renderer/dist` (the bundle's `./assets/…`). |

In served HTML, CSS and JS from `/v/` and `/runtime/`, `quire://vault/` becomes `/v/` and
`quire://runtime/` becomes `/runtime/`. A page entry gets `<meta name="quire-rpc"
content="/_quire/rpc">`.

### Optional client id

A client that sends `X-NB-Client: <id>` on its calls and opens `/api/events?client=<id>` gets the
desktop's two-window behaviour: when one client writes a page (`writeEntry`, `writeFile`, a page
rpc write), every other client hears `page-files-changed` for it. Without an id, a write tells
nobody, so the writer never reloads the page it is typing into. Disk changes from outside (agents,
sync, the CLI) reach everyone through the watcher either way.

## Events

| Event | Args | From |
| --- | --- | --- |
| `tree-changed` | none | vault watcher: pages or folders added, removed, renamed |
| `locks-changed` | `[locks]` | vault watcher: an agent locked or unlocked a page |
| `page-files-changed` | `[pagePath]` | vault watcher (files changed on disk), or another client's write |
| `build-status` | `[{path, state, …}]` | page builds (builds.mjs) |
| `backend-status` | `[status]` | page backends (backend.mjs) |
| `sync-status` | `[{vault, syncing, last}]` | vault sync (sync.mjs) |
| `publish-status` | `[{path, state, …}]` | publish / unpublish jobs |
| `hosting-changed` | none | publishing settings or account changed |
| `templates-changed` | none | while `quire:watchTemplates(true)` is on |
| `ai-event` | `[event]` | Noteblock AI jobs (ai.mjs) |

`update-status`, `menu`, `cloudflare-status` and the floating-note events never arrive here: there
is no updater, menu bar, Cloudflare login or floating window.

## Channels that answer an error

These answer `{"error": "Not available in the web editor"}` without running, because they need a
window, a native dialog or menu, Electron's session, or this machine's desktop:

- page devtools: `quire:inspectPage`
- spelling dictionary: `quire:dictionaryWords`, `quire:addDictionaryWord`, `quire:removeDictionaryWord`
- native menus and clipboard (the web renderer does these itself): `quire:contextMenu`, `quire:popupAppMenu`, `quire:copyText`, `quire:copyPath`
- Finder and other apps: `quire:reveal`, `quire:revealBackendLog`, `quire:revealUpdateLog`, `quire:revealTemplate`, `quire:openFileExternally`
- file pickers and switching vaults: `quire:pickImportSource`, `quire:importArtifactFiles`, `quire:openVault`, `quire:createVault`, `quire:moveVault`, `quire:switchVault`
- sign-ins that open a browser on the host, and the updater: `quire:hostingSignIn`, `quire:cloudflareLogin`, `quire:runUpdate`
- the floating note: `quire:getFloating`, `quire:setFloating`, `quire:openFloating`, `quire:hideFloating`, `quire:floatingPage`, `quire:newFloatingNote`, `quire:floatingPicking`

Changed on purpose:

- `quire:rpc` takes `[origin, method, params, pagePath]`. Pages under `/v/` share the editor's
  origin, so the page is `pagePath` (the vault path of the frame the message came from), not the
  origin; a missing `pagePath` is an error. `devtools.inspectEmbed` answers the error above.
- `quire:probePage` always answers `{state: "ok", pid: null, pages: []}` and
  `quire:killPageProcess` does nothing: a browser has no page processes to watch.
- `quire:createFolder("A/B/C")` creates the missing parent folders too.

- `quire:openInBrowser` opens nothing. It returns the page's public URL when it's published, else
  `/v/<page>/`, for the browser to open.
- `quire:trash` moves the item to the host user's Trash (`~/.Trash` on macOS) and commits, as in
  the app. Finder's "Put Back" doesn't know about it; git has the history.
- `quire:activity` reports page backends only (no Electron processes to measure).
- `quire:setPref` saves editor settings but can't push them into open page frames; a page picks
  them up on its next load.
- `quire:setSyncRemote` also starts or stops the interval sync.

## Vault sync

When the vault has a git `origin`, the server syncs it (sync.mjs `syncNow`: commit, rebase onto
`origin/main`, push) every `--sync-every` seconds, three seconds after start, and five seconds
after an autosave commit or a watched change. That happens whether or not Settings › Sync is
switched on for this vault, so `quire:syncInfo` can say `enabled: false` while the server syncs.
Each run sends `sync-status`. Git uses the host user's credentials (ssh keys, credential helper),
with prompts off.

## On a headless Mac, behind `tailscale serve`

```sh
# once: the vault and its remote
quire vault create ~/Quire/Work --no-seed     # or clone an existing vault repo there
git -C ~/Quire/Work remote add origin git@github.com:<you>/<vault-repo>.git

# the server, on loopback
cd ~/projects/quire && pnpm build
pnpm web --vault ~/Quire/Work --port 4790 --token-file ~/.noteblock/web-token

# HTTPS on the tailnet, in front of it
tailscale serve --bg --https=4790 http://127.0.0.1:4790
```

The editor is then at `https://<machine>.<tailnet>.ts.net:4790/embed?t=<token>`. Tailscale terminates
TLS and sends `X-Forwarded-Proto: https`, so the cookie is set `Secure`. Keep it running with a
launchd agent (KeepAlive) that runs the `pnpm web …` line with the repo as its working directory.

Embedding: the parent page loads `/embed?folder=<f>&t=<token>` in an iframe. The cookie is
`SameSite=Lax`, so the browser sends it only when the parent page is same-site with the web host.
Two hosts on the same tailnet (`*.<tailnet>.ts.net`) are same-site; a parent on `localhost` or
another domain is not, and then every request after `/embed` is a 401 unless it carries `?t=`.

## Security model

It is an owner-only editor. Two things stand between the network and the vault:

1. **The tailnet.** The server binds `127.0.0.1`; only `tailscale serve` exposes it, and only to
   devices on your tailnet. Never `tailscale funnel` it, and never bind `0.0.0.0`.
2. **The token.** Every request needs it, by cookie or query. The cookie is `HttpOnly`, so page
   scripts can't read it. Calls must be `application/json`, which a cross-site form can't send
   without a CORS preflight the server never answers, so another site can't drive the API with
   the cookie.

What it does not protect against:

- **Pages are trusted.** In the desktop app every page has its own `quire://p-<id>` origin. Here,
  pages under `/v/` share the editor's origin, so a page's script can call `/api/call/*` with the
  cookie and do anything the editor can. Only serve vaults whose pages you wrote or trust.
- Anyone holding the token (or a URL with `?t=` in it) has full read/write access to the vault and
  can start its page backends. The token lands in browser history and in pw's config; treat it
  like a password and rotate it by replacing the file.
- Page backends and builds run as the host user, as they do in the desktop app.
