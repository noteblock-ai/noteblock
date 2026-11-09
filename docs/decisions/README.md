# Decisions

Written answers to questions from the 2026-10-21 backlog. Each one covers the question, how
Quire works today (with file and line references), the options, a recommendation and a
checklist.

- [hosting.md](hosting.md): whose Cloudflare account Publish uses, what a published page can cost, and BYO Cloudflare versus Quire hosting.
- [sandboxing.md](sandboxing.md): what a downloaded page's HTML, backend and build can reach today, and the capability, trust and sandbox plan.
- [many-backends.md](many-backends.md): what 100 running backends cost, the idle-stop and cap work in progress, and what to do after it.
- [open-source.md](open-source.md): which license for which part, and when to open the repo.
- release.md (kept in the private repo): signing, notarizing and shipping builds.
- [page-devtools.md](page-devtools.md): DevTools for one page or embed: how a frontend is scoped to one iframe target, the relay, and the Electron crash it works around.
- [mobile.md](mobile.md): iOS as a SwiftUI shell with pages in WKWebView; backends stay on the Mac.
- [android.md](android.md): Android as a Compose shell with pages in the System WebView, served on https://quire.local; the quick note is a Quick Settings tile.
