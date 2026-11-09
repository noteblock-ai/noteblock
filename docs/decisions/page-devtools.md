# DevTools for one page

Status: built, 2026-10-22 (spike, then `app/main/page-devtools.mjs` and `app/main/devtools-relay.mjs`).

## The question

⌘⌥J opened Electron's DevTools for the whole window: the app UI, every page iframe and every
embed in one Elements tree, one console with a context dropdown. Can each page (and each
embed) get its own full DevTools window that sees only that page?

## Why it is possible

Since per-page origins (PR #56, `app/main/origins.mjs`) every page is at `quire://p-<id>/`, its
own site, so Chromium puts it in its own renderer process as an out-of-process iframe (OOPIF).
An OOPIF is a CDP target of its own (`type: "iframe"`, `url: quire://p-<id>/<path>/`). A DevTools
frontend connected to that target alone is scoped to the page by Chromium itself: `Runtime`,
`DOM`, `Network`, `Debugger`, `Page` on that session only ever see that frame.

## Spike findings (Electron 44.8.0, Chromium 1d4f427)

1. **CDP without a debugging port.** `win.webContents.debugger.attach("1.3")` works, and on that
   connection `Target.getTargets`, `Target.getTargetInfo` and `Target.attachToTarget({flatten:
   true})` are all allowed (not only `setAutoAttach`). `getTargets` lists every target in the
   browser, other windows included, so a window's own iframes are found by walking `parentId`
   up to the window's own target (`Target.getTargetInfo()` with no id). Commands for the page go
   through `debugger.sendCommand(method, params, sessionId)`, events arrive on
   `debugger.on("message", (e, method, params, sessionId))`.
2. **Coexists with Electron's DevTools.** `debugger.attach` succeeds while the window's own
   DevTools are open, and opening or closing them later leaves the debugger attached and the
   page inspector connected. Chromium allows several clients per target; nothing to handle.
3. **Frontend: option (a) works.** A normal `BrowserWindow` loads
   `devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:<port>/<token>` (the frontend
   Electron ships in its resources; no npm package, version always matches the Chromium).
   `InspectorFrontendHost` is the stub, which is fine: everything except the embedder-only bits
   (dock buttons, "save as" for files) works. `inspector.html` loads too. Options (b)
   (`setDevToolsWebContents`) and (c) (`chrome-devtools-frontend` package) were not needed.
4. **What the frontend sends.** On connect it enables ~25 domains on the root session and
   sends `Target.setAutoAttach {autoAttach, waitForDebuggerOnStart: true, flatten: true}`,
   `Target.setDiscoverTargets` and `Target.setRemoteLocations` (not supported on a page
   session; the frontend shrugs). `Autofill.*` is not in Electron; also harmless.
5. **The Electron crash.** Any command that names a flat session which has already detached
   (a command *on* it, or `Target.detachFromTarget({sessionId})` for it) takes down the main
   process: SIGBUS or SIGSEGV, or a hang, immediately or 300 ms later. Detaching a live session,
   and iframe teardown with domains enabled, are fine. So the hub keeps an exact set of live
   sessions (updated synchronously from `attachedToTarget` / `detachedFromTarget`, with the
   children of a gone session dropped too) and refuses to send anything for a session outside
   it. Events are delivered synchronously, so the check right before a send cannot race a
   detach. Worth an Electron bug report.

## How it works

- `Hub` per window (main window, floating note): attaches the debugger when that window's
  first inspector opens and detaches with its last, so with no inspector open nothing is
  attached. `Target.setDiscoverTargets` on the window's own session tells waiting inspectors
  when their page's iframe is back.
- `Inspector` per (window, page id, holder page id for an embed): a `BrowserWindow` titled
  "<Page title> — DevTools" and a relay. When the frontend connects, the inspector attaches a
  fresh flat session to the page's current iframe target; when it disconnects, it detaches it,
  which also drops every domain, breakpoint and override the frontend set.
- The relay (`devtools-relay.mjs`): a minimal RFC 6455 server, 127.0.0.1 only, random port,
  48-hex-digit token path, one connection at a time (a second gets 409), Origin must be
  `devtools://…` or absent (a page's `quire://` origin gets 403). No `ws` dependency.
- Message rewriting: a message without `sessionId` goes to the page's session; one with a
  `sessionId` must be a child the frontend was told about (workers). `Target.setDiscoverTargets`,
  `getTargets`, `setRemoteLocations` are answered locally (nothing about other targets leaks);
  `attachToTarget`, `createTarget`, `closeTarget` and the like are refused. The frontend's
  `setAutoAttach` is forwarded with `waitForDebuggerOnStart: false`. An auto-attached child that
  is another page's iframe (an embed) is detached instead of reported, so the page's Elements
  shows the embed as an opaque iframe and its console and network never mix in.
- Which target: for a page, the iframe of that id whose parent is the window itself; for an
  embed, the iframe of that id whose parent is the holder page's iframe. ⌘⌥J asks the top
  page frame for `document.activeElement` (400 ms timeout, so a frozen page still gets an
  inspector) and walks into a focused embed, up to four levels.
- Lifecycle: the iframe going away (a reload or recovery remounts it, a tab switch removes it)
  ends the session; 400 ms later the inspector reconnects to the page's new iframe, or shows a
  "isn't showing" page until `targetCreated` / `targetInfoChanged` reports it. It closes when
  the page is deleted (`tree-changed`), when the window's open tabs no longer include the page
  (or, for an embed, its holder: `quire:devtoolsOpenPages` from App.jsx and Floating.jsx), when
  the vault changes, or with its window.

## What each panel sees

Verified by `scripts/verify-devtools.mjs`: Elements (the page's document only), Console (its
logs; evaluates with `document.title` = the page; the execution-context list is the page's
origin only), Network (its requests, `/api/…` included, nothing from the app window or the
holder page). Sources lists the page's files and the `quire://runtime/` scripts it loads.
Performance and Memory run on the page's session, so they profile its renderer process; not
checked beyond the panel opening. Application shows the page origin's storage.

## Not done / limits

- No "pause on start" for workers a page starts (the frontend's `waitForDebuggerOnStart` is
  forced off so an embed it is not shown never sits paused).
- The embed head has no Inspect button (the head already holds the title and Open; it did not
  fit cleanly). Inspect is in the embed's right-click menu and on ⌘⌥J with focus in the embed.
- The frontend's dock/undock buttons do nothing (no embedder).
