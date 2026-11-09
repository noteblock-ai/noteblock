# noteblock.ai

The landing page and the download/update host. Source in `site/`, deployed as the Cloudflare
Worker `quire-site` on `noteblock.ai/*` and `www.noteblock.ai/*` (www 301s to the apex), plus the legacy `quire.harborapps.org/*`, where /updates, /download and /downloads are served as before (0.2.x apps poll its feed) and every other path 301s to noteblock.ai. Formerly: the route `quire.<apex>/*` (apex: `jq -r .appDomain
~/projects/claude-scratchpad/hosting.json`). The `quire-hosting` Worker keeps the more specific
`/api/*` and `/auth/*` routes on the same host.

- `site/public/` — static assets: `index.html` (the landing page, moved here from the claude.ai
  artifact "Quire Landing"; edit it here from now on), `favicon.svg` (= `build/icon.svg`),
  `apple-touch-icon.png`, `og.png`, `robots.txt`, `sitemap.xml`, `_headers` (security headers
  and CSP for the static files).
- `site/public/pricing.html` — the pricing page at `/pricing` (served like the legal pages, styled with `legal.css` plus its own `<style>`), linked only from the footers. Its numbers come from "Plans and billing (Pro)" in `docs/hosting-api.md`; change both together. Its buttons go to `/billing/upgrade?item=…` on the hosting Worker.
- `site/public/privacy.html`, `terms.html`, `legal.css` — the legal pages, served at `/privacy` and `/terms` (the asset layer's `auto-trailing-slash` answers both with 200; `/privacy.html` and `/privacy/` 307 to them). They describe what the code does, so change them with the code: new data stored, a new provider, a self-serve account deletion.
- `site/public/fonts/` — Geist and Geist Mono (variable woff2, Latin and Latin Extended, taken from
  Google Fonts v5), preloaded by `index.html` and cached for a year (`_headers`), so the first paint
  is already in Geist. A new font version gets a new file name (`-v6`). The Worker's own 404/503
  pages still load Geist from Google Fonts.
- `site/worker/` — the Worker. It only runs for `/download`, `/download/*`, `/downloads/*`,
  `/updates/*` and paths with no asset; everything else is served by the asset layer.
- `site/scripts/render.cjs` — renders `og.png` and `apple-touch-icon.png`, and takes screenshots,
  in a hidden Electron window.

Cloudflare Web Analytics isn't in the source. The zone injects its beacon into HTML at the edge, on noteblock.ai and on `*.noteblock.ai` including published pages, so a page isn't byte-identical to what `curl` of R2 would give. `/privacy` says so; if the setting is turned off in the dashboard, change that paragraph.

## Routes (the release contract)

R2 bucket `quire-releases`, written by `scripts/release.mjs`:

| Path | Serves |
| --- | --- |
| `/download` | 302 to the DMG named in `downloads/latest.json`. `?arch=x64` / `?arch=arm64`, or the `Sec-CH-UA-Arch` client hint (Chromium only; the landing page asks for it), picks between `dmgX64` and `dmgArm64`; `dmg` (universal) is the fallback. Default arm64, because Safari reports "Intel Mac OS X" on every Mac. With no `latest.json` yet: a 503 "The first build is on its way" page. |
| `/download/mac` | Always the DMG (the same pick as `/download`). |
| `/download/windows` | 302 to `windows.file` in `latest.json` (`Noteblock-<v>-setup.exe`). Before the first Windows release: a 404 "Noteblock for Windows is on its way" page (never the DMG). Once `windows` exists, `/download` sends a User-Agent containing `Windows` there too (`Vary: User-Agent`); without it `/download` is Mac-only, as before. |
| `/download/latest.json` | `downloads/latest.json`, `no-cache` (404 JSON before the first release). |
| `/downloads/*`, `/updates/*` | The R2 object with Content-Type by extension (`.dmg`, `.exe`, `.zip`, `.yml`, `.blockmap`, `.json`), Content-Length, ETag/If-None-Match, single and multi-range requests (`multipart/byteranges`, which electron-updater's differential download uses). `latest*.yml` and `latest.json` are `no-cache`; names with a version number are `immutable`, one year. |

## Commands

```sh
cd site/worker && pnpm install
pnpm check                      # tsc
pnpm exec wrangler dev          # local, with a local R2
pnpm exec wrangler deploy       # deploys to noteblock.ai and the legacy quire.harborapps.org route (no Workers Builds yet)

# Re-render og.png + apple-touch-icon.png (from the repo root; any Electron binary works):
pnpm exec electron site/scripts/render.cjs assets
# Screenshot a URL: shot <url> <out.png> <width> <height> [scrollY]
pnpm exec electron site/scripts/render.cjs shot https://noteblock.ai/ /tmp/shot.png 1440 900 9000
```

Smoke test after a deploy: `/` 200, `/download` 302 (503 before the first release),
`curl -H 'Range: bytes=0-9' .../updates/latest-mac.yml` 206, and `/api/me` still the hosting
Worker's 401 JSON.

## Windows on the landing page

A script in `index.html`, placed just before the three.js `<script>` tag so it runs before the
first paint, picks the button from the visitor's OS (`navigator.userAgentData.platform`, then the
User-Agent; `?os=windows|mac` forces it for a check): Windows visitors get "Download for Windows"
(`/download/windows`) and "Also for Mac", everyone else keeps the Mac button (`/download/mac`)
plus "Also for Windows"; the hero says "on your computer"; and a Windows visitor's demo window
swaps the traffic lights for caption buttons (the demo has no keycaps to swap). It no longer
waits for `latest.json`: waiting, or running after three.js, showed the Mac button first and then
swapped it. The meta description, Open Graph text and JSON-LD stay
Mac-only static copy; change them by hand once Windows ships.
