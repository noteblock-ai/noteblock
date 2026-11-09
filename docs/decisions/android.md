# Android client: Compose shell, pages in the System WebView

Decided 2026-10-23, for release 0.3.1. Design: the "Android" page of the design canvas
(https://claude.ai/artifact/KoXMtHxjaHGDUj8bPzBh7v), snapshot in
`designs/canvas/project/Android*.dc.html`, built by `designs/canvas/build-android.mjs`.

The Android app is the iOS app (docs/decisions/mobile.md) on Android's parts: a Kotlin +
Jetpack Compose shell (Material 3) around pages that render in Android System WebView with
the same `app/runtime` and the same rpc contract. Same feature set as iOS today: the vault
list, reading and editing a page with a keyboard toolbar and an insert sheet, GitHub sync, plus
a quick note.

## What maps to what

| iOS | Android | Why |
|---|---|---|
| WKWebView + `quire://` scheme handler | System WebView + `WebViewClient.shouldInterceptRequest` on `https://quire.local/` | Chromium won't load ES modules, `fetch()` or fonts from a custom scheme (CORS only allows http(s)). An https origin we answer ourselves behaves like the iOS scheme. |
| `window.webkit.messageHandlers.quire` / `.quireEditor` | the same names, defined by a document-start script over androidx.webkit `WebMessageListener` | runtime.js picks its native transport by looking for `window.webkit.messageHandlers.quire`. Defining it on Android means no runtime.js change, and `WebMessageListener` gives a reply proxy per frame, so an embed's rpc is answered in the embed. |
| JavaScriptCore (`HostJS.swift`) | androidx.javascriptengine `JavaScriptSandbox` | The same `host.js` (mobile/host.mjs: transformEntry, applyRegions, htmlToMarkdown…) in a V8 isolate, no native library to ship. Needs a WebView new enough for the sandbox (Chrome 110+ era); a fallback engine is not in 0.3.1. |
| `ios/Generated/` from `scripts/build-mobile-host.mjs` | `android/app/build/generated/quire/assets/` from the same script (`--platform=android`), run by Gradle's preBuild | One build script for both phones. For Android it rewrites `quire://runtime/` and the runtime's `quire://vault/` page URLs to `https://quire.local/…`; the served page HTML gets the same rewrite as it is served. |
| GRDB-free SQLite (`PageStore.swift`) | `android.database.sqlite` | The same schema, so `data/<user>.sqlite` is the same file as on the Mac. |
| Keychain (GitHub token) | an Android Keystore AES-GCM key encrypting the token in app prefs | The token never sits in plain text; `allowBackup` is off. |
| Documents folder, visible in Files | `filesDir/vaults/<name>` | Private app storage. Exposing it to other apps (a DocumentsProvider) is later work. |
| Floating note (desktop) / widget (iOS design) | Quick Settings tile + launcher shortcut + share target | See below. |

## Quick note: a tile, not a widget

The desktop floating note is one shortcut away from any app. On Android the thing that is one
gesture away from any app is the Quick Settings shade, so the quick note is a tile there
("Quick note"), plus a launcher shortcut (long-press the icon) and a share target ("Share to
Noteblock" appends the text). All three open the `Floating note` page (created in the vault root
when missing, like `app/main/floating-page.mjs`) in a sheet over the current app, keyboard up. A
home-screen widget needs home-screen space and Glance, and comes later.

## Same as iOS, on purpose

- Light only. theme.css has no dark block, so pages are light, and the chrome matches the page
  under it. No dynamic color for the same reason. When theme.css grows a dark theme, both apps
  get a dark scheme.
- No sign-in. Sync uses a GitHub token, exactly as on iOS.
- Page backends and builds are Mac only: those pages open read-only, `/api/…` answers 503.
- Sync runs on open, when the app comes back to the foreground and every 5 minutes while it is
  open. Background sync (WorkManager) is later work, as BGAppRefreshTask is on iOS.

## Ids

Internal ids stay `quire` (docs/contract.md, "Naming: public vs internal"): Gradle project
`Quire`, package and namespace `org.harborapps.quire`, application id
`org.harborapps.quire.mobile` (the iOS bundle id). The launcher name is `app_name` in
`res/values/strings.xml`, which `scripts/build-mobile-host.mjs` checks against `BRAND.name`.
