# Mobile client: SwiftUI shell, pages in WKWebView

Decided 2026-10-22. Design: the "Mobile" page of the design canvas
(https://claude.ai/artifact/KoXMtHxjaHGDUj8bPzBh7v), snapshot in `designs/canvas/project/Mobile*.dc.html`.

## The question

Should the iOS app be SwiftUI or lean on a web view?

A Quire page is HTML and JS, so it renders in a WKWebView whichever way the app is built. A
fully native renderer only works for plain notes and breaks every page with a script or an app
block. The real choice is what owns everything around the page.

## Recommendation: SwiftUI shell

- The editor is `app/runtime/runtime.js` running in the web view in both options, so editing
  parity comes for free and fixes land on both platforms at once. SwiftUI adds the keyboard bar
  and the insert sheet, which call the runtime over a script message handler.
- Local-first is native work anyway: the vault folder (visible in Files), git sync with libgit2
  (the same remote and conflict copies as `app/main/sync.mjs`), page SQLite via GRDB answering
  the same rpc methods as `runRpc` in `app/main/ipc.mjs`, background sync with
  BGAppRefreshTask, and WidgetKit, App Intents and a share extension for the quick note.
- A web app in a wrapper (Capacitor plus the desktop React renderer) gets a demo out faster.
  But the desktop sidebar and tabs don't fit a phone, an HTML keyboard bar fights the keyboard,
  and isomorphic-git is slow on a 5,000-file vault and can't run in the background.

## What the phone can't do

- Page backends (node processes) and page builds are Mac only. Those pages open read-only
  with "Runs on your Mac".
- Page data (`data/<user>.sqlite`) is gitignored, so rows added on the phone don't reach the
  Mac today. Sync has to carry data (a mergeable row log per page), or each device keeps its
  own. This is still to be decided.

## Biggest risk and the first spike

contenteditable in WKWebView: selection handles, the caret going under the keyboard, and
autocorrect and dictation colliding with the editor's own undo history. These hit both options.
A one-week spike: a SwiftUI app opens a vault folder, a scheme handler renders a real page,
type in it for a day, then libgit2 pulls and pushes the vault.
