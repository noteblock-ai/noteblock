# Noteblock managed hosting — API contract (shared by the server and desktop agents)

The Worker that serves this API is closed source and lives in the private `noteblock-internal` repo
(`hosting/`). This file is the contract the app builds against.

Domains come from `core/brand.mjs` (`BRAND.domain` = noteblock.ai; never hard-code them anywhere else):
- API + sign-in: https://noteblock.ai/api/* and /auth/* (the landing site owns every other path on noteblock.ai, so the Worker only has those two routes there)
- Published sites: https://<slug>.noteblock.ai/ (one label, covered by the *.noteblock.ai Universal SSL cert). Slugs in `BRAND.reservedSlugs` (and `noteblock`) are refused.
- Legacy (0.2.x apps and old links): quire.harborapps.org/api/* keeps answering; quire.harborapps.org/auth/* and /api/auth/* 307 to noteblock.ai; <slug>-quire.harborapps.org/<path> 301s to <slug>.noteblock.ai/<path>, except pages whose slug is now reserved, which stay on their old host.

Accounts: anyone can sign in (GitHub and Google via Better Auth). Per-account limits (server-enforced, returned by /api/me): 10 sites, 25 MB per site, 1000 files per site, 60 uploads per hour.

Desktop sign-in (electron-auth skill, loopback transport; the custom scheme `quire://` is already used by the app's page protocol, so use loopback in both dev and packaged):
1. Desktop listens on 127.0.0.1:<random port>, opens the system browser at
   https://noteblock.ai/auth/desktop?port=<port>&state=<random>
2. That page signs the person in (Better Auth social sign-in) if needed, then shows "Sign in to Noteblock as <name>?" with a Continue BUTTON (a POST mints the code; a GET never does).
3. Server redirects to http://127.0.0.1:<port>/callback?code=<one-time code, 60s>&state=<state> (built server-side from the validated port only).
4. Desktop POSTs https://noteblock.ai/api/desktop/token {code} → {token, user}. token = long-lived random API token (store only its SHA-256 in the database). All API calls: Authorization: Bearer <token>.
5. POST /api/desktop/logout revokes the token.

Endpoints (JSON unless noted; errors {error: "<plain sentence>"} with a 4xx status):
- GET  /api/me → {user:{id,name,email,image}, usage:{sites, bytes}, limits:{sites, bytesPerSite, filesPerSite}}
- GET  /api/sites → {sites:[{slug, url, title, updatedAt, bytes, files}]}
- POST /api/sites {title, slug?} → {slug, url}. Slug rule: ^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$, no "--", not reserved (www, api, admin, quire, mail, app, …); always the title plus a random 5-character tag (`welcome-k3x9q`; letters and digits that don't read alike), since 0.3.3: nobody gets a bare word on noteblock.ai, so pages never take names we'd want and two people's "Welcome" never compete. `slug` is honoured only for admins (ADMIN_EMAILS); anyone else's is ignored. Sites published before keep their addresses.
- PUT  /api/sites/:slug  multipart/form-data; each file is one part, field name "file", filename = its path relative to the site root (e.g. "index.html", "_quire/runtime.js"). Server writes them under R2 sites/<slug>/<version>/…, then flips the site's current version in Postgres (atomic: a half-finished upload is never served), mirrors it to R2 `pointers/<slug>` (what page serving reads, so a page view never queries the database), and deletes the old version's objects afterwards. → {slug, url, version, bytes, files}
- DELETE /api/sites/:slug → {ok:true}
Serving: GET https://<slug>.noteblock.ai/<path> → R2 sites/<slug>/<current version>/<path>; "/" and directory paths → index.html; unknown → 404 page; correct Content-Type; Cache-Control short for html, long for hashed assets; headers X-Content-Type-Options nosniff, Referrer-Policy, and a small "Made with Noteblock · Report" footer is NOT injected (keep pages byte-identical; the desktop app adds its own badge before upload, see "What the desktop app uploads").

## As built (hosting/, deployed 2026-10-22)

Additions to the contract above. None change a request or response the desktop relies on.

- `GET /api/me` → `limits` also carries `uploadsPerHour: 60`.
- Tokens look like `qh_<43 base64url chars>`. A bad or revoked token → 401 `{error}`.
- `POST /api/desktop/token` → 401 for an unknown, used or expired code (codes are deleted as they're read).
- Slug from a title: lowercased, non-alphanumerics → `-`, cut to 34 chars (room for the `-xxxxx` tag), `-page`
  appended when it's under 3 chars or reserved. An explicit `slug` that's taken → 409, invalid → 400.
  11th site → 403.
- `PUT /api/sites/:slug`:
  - needs `index.html` at the top (400 otherwise); paths may not start with `/`, contain `\`,
    control characters, empty, `.` or `..` segments, or repeat (400).
  - over 27 MB body (25 MB + multipart overhead) → 413; over 25 MB of
    files or 1000 files → 413; not multipart → 415; 61st upload in an hour → 429.
  - Content-Type of each file is set from its extension at upload time.
  - Two uploads racing on one site: the second to finish gets 409 and its files are removed.
- `DELETE /api/sites/:slug` frees the slug immediately; someone else may claim it.
- Serving: `/folder` (no slash) with a `folder/index.html` → 301 to `/folder/`. Only GET/HEAD (405
  otherwise). ETag + If-None-Match → 304. Cache-Control: html `max-age=60`; names with an 8+ char
  hash containing a digit (`app-3f9a1c2b.js`) `max-age=31536000, immutable`; else `max-age=300`.
  Referrer-Policy is `strict-origin-when-cross-origin`.
- `/auth/desktop`: the buttons are forms that POST to `/auth/desktop/start` (begins the Better Auth
  social sign-in, callbackURL = this page with the same port/state), `/auth/desktop/continue` (mints
  the code) and `/auth/desktop/switch` ("Use another account": signs the browser out). Each POST checks
  `Origin` is `https://noteblock.ai`. `state` must match `^[A-Za-z0-9_-]{8,128}$`, port 1024–65535;
  anything else gets a "This link has expired" page. A failed IdP round trip comes back with `?error=`.

## What the desktop app uploads

The server still injects nothing. Both additions are made while the desktop app stages a site
(`app/main/publish.mjs`), so to the server they are ordinary files:

- Pages and folders published here carry a "Made with Noteblock" link at bottom right, in the
  uploaded HTML. Self-hosted Cloudflare publishes don't. A page gets it on its next publish.
- A plain folder publishes as one site: `index.html` (a generated list), one `_quire/`, each page
  at `/<slugified relative path>/`, plain files beside them. It counts as one site against the 10,
  and has to fit the same 25 MB and 1000 files, which the app checks before uploading.

## Noteblock AI (0.3.1)

The contract is docs/ai.md, "Hosting API". As built (`hosting/src/ai.ts`, `hosting/src/admin.ts`):

- `POST /api/ai/v1/messages` takes the desktop token as `Authorization: Bearer` or `x-api-key` (so
  the SDK's `authToken` or `apiKey` both work). Body up to 4 MB (413 `request_too_large`). Only
  `content-type`, `x-api-key` (the server's key), `anthropic-version` (default 2023-06-01) and the
  client's `anthropic-beta` go upstream. `model` is replaced (`x-noteblock-purpose: build` → the build
  model), `max_tokens` over 64000 becomes 64000. The response comes back with the upstream status,
  `content-type` and `request-id`; upstream errors pass through as they are. Usage is recorded after
  the response (a stream stopped part way records what was seen). `purpose` in `ai_usage` is `build`,
  or the header's value, or `page`.
- Errors are Anthropic's envelope: 401 `authentication_error`, 403 `noteblock_ai_off`, 429
  `noteblock_ai_limit` (today's UTC spend ≥ the daily limit), 400 `invalid_request_error` (body not
  a JSON object), 502 `api_error` (upstream unreachable).
- Access: `everyone`; `admins` (`ADMIN_EMAILS`, and the setting before anything is saved); `list`
  (exactly `allow_list`). Every check, admin page included, needs `user.email_verified`: an
  address the provider verified. GitHub can return unverified ones, so accounts only link on a
  verified email. Settings are
  cached per isolate for 60 s, so a change reaches every request within a minute.
- `GET /api/ai/status` (bearer, `{error}` 401 like /api/me): `enabled` = access, `buildModel` is the
  resolved one (never null), `spentTodayCents` has two decimals.
- `GET /admin`: signed out → sign-in buttons that POST `/admin/start` (Better Auth social sign-in,
  back to `/admin`); signed in but not in `ADMIN_EMAILS` → the 404 page. `GET/PUT /api/admin/ai`:
  non-admins 404 `{error}`. PUT takes `{settings: {...}}` or the fields alone: `model`,
  `buildModel` (null = same), `dailyLimitCents` (integer), `access`, `allowList` (any separators;
  stored lowercase, comma-separated) → the same shape as GET. A PUT with a foreign `Origin` → 403.
  `people[].inputTokens` includes cache reads and writes.

## Where things are

- Worker `quire-hosting` (`hosting/`, `pnpm deploy`), routes `noteblock.ai/api/*`, `noteblock.ai/auth/*`,
  `noteblock.ai/admin*`, `*.noteblock.ai/*`, plus the legacy `quire.harborapps.org/api/*`, `quire.harborapps.org/auth/*` and
  `*-quire.harborapps.org/*` (Cloudflare accepts the leading wildcard inside the label). The most
  specific route wins, so www.noteblock.ai (site) and play.noteblock.ai (Blastside) never reach it.
- Neon Postgres project `noteblock` (drizzle schema `hosting/src/db/schema.ts`, migrations in
  `hosting/drizzle/`: `pnpm db:generate`, then `DATABASE_URL=<neon url> pnpm db:migrate`), reached over
  Neon's HTTP driver. R2 `quire-sites`: files at `sites/<slug>/<version>/<path>`, the live version
  of each site at `pointers/<slug>`. Page views read only R2; the database only sees sign-in and
  the API, so the Neon compute can scale to zero.
- Local: `hosting/.dev.vars` (copy `.dev.vars.example`) points `DATABASE_URL` at local Postgres, and
  `pnpm db:local` runs the neon-http shim on port 4444. Never point local dev at Neon.
- DNS: proxied `AAAA quire 100::` and a proxied wildcard `AAAA * 100::` (explicit records still win, so
  no existing host changed). The wildcard means the Worker needs no Cloudflare API token and there's no
  per-site record to create, delete or run out of.
- Secrets: `DATABASE_URL` (Neon, pooled), `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `ADMIN_EMAILS` (`wrangler secret put`). A provider without
  both its secrets doesn't get a button. `ANTHROPIC_BASE_URL` is for local dev only (a fake upstream).
- OAuth: GitHub OAuth App "Noteblock" (basketbla, github.com/settings/applications/3954925); Google Cloud
  project `quire-auth` (console.cloud.google.com/auth/clients?project=quire-auth).

## Plans and billing (Pro)

Two plans. Prices and limits live in the hosting Worker (`hosting/src/plans.ts` in
noteblock-internal) and come back from the API, so the app never hard-codes them.

| | Free | Pro |
|---|---|---|
| Price | $0 | $7 a month, or $60 a year ($5 a month) |
| Published sites | 3 | 1,000 |
| Size per site | 25 MB | 50 MB |
| Total published | 75 MB | 5 GB |
| Files per site | 1,000 | 5,000 |
| Uploads per hour | 60 | 300 |
| Noteblock AI credits, each month | 25 | 250 |

- **Credits.** 1 credit is 1¢ of model cost at Anthropic's list price (`ai_usage.cost_micros /
  10,000`). Monthly credits refill on the 1st (UTC) and don't roll over. Bought credits never
  expire and are spent only after the month's credits run out.
- **Credit packs** (one-time, any plan): 350 credits for $5, 1,500 credits for $20.
- **Over a limit after downgrading:** nothing is deleted. Existing sites keep serving and can be
  updated; publishing a new site waits until the count is under the limit.
- **Coming soon** (shown on the pricing page, not built): sync across devices with page data,
  and multiplayer.

### Endpoints (desktop token, `Authorization: Bearer`)

- `GET /api/me` adds `plan` and returns the plan's `limits`:
  `{ user, plan, usage: {sites, bytes}, limits: {sites, bytesPerSite, bytesTotal, filesPerSite, uploadsPerHour} }`.
- `GET /api/billing` →
  ```json
  {
    "plan": { "id": "free" | "pro", "interval": "month" | "year" | null, "status": "active" | "trialing" | "past_due" | "canceled" | null,
              "renewsAt": 1767225600000 | null, "cancelAtPeriodEnd": false },
    "credits": { "monthly": 250, "usedThisMonth": 12.4, "monthlyLeft": 237.6, "purchased": 350, "left": 587.6, "resetsAt": 1767225600000 },
    "usage": { "sites": 2, "bytes": 1048576 },
    "limits": { "sites": 1000, "bytesPerSite": 52428800, "bytesTotal": 5368709120, "filesPerSite": 5000, "uploadsPerHour": 300 },
    "plans": { "free": { ...limits, "credits": 25 }, "pro": { ...limits, "credits": 250, "priceMonthCents": 700, "priceYearCents": 6000 } },
    "packs": [ { "id": "credits-350", "credits": 350, "priceCents": 500 }, { "id": "credits-1500", "credits": 1500, "priceCents": 2000 } ]
  }
  ```
  Credits are numbers with up to two decimals.
- `POST /api/billing/checkout {"item": "pro-month" | "pro-year" | "credits-350" | "credits-1500"}` →
  `{ "url": "https://checkout.stripe.com/..." }`. The app opens it in the browser. `409 {"error"}`
  when buying Pro while already on Pro (use the portal to switch monthly/yearly).
- `POST /api/billing/portal` → `{ "url": "https://billing.stripe.com/..." }` (Stripe's customer
  portal: cancel, switch interval, card, invoices). `409` when there's no Stripe customer yet.
- `GET /api/ai/status` adds `credits: {left, monthlyLeft, purchased, monthly}` and `plan`;
  `enabled` is false when `left <= 0`. `spentTodayCents`/`limitCents` stay for older apps.

### Errors the app shows an upgrade for

- Noteblock AI out of credits: `429 {"type":"error","error":{"type":"noteblock_ai_credits","message":"You're out of Noteblock AI credits."}}`.
- A plan limit on publish (`POST /api/sites`, `PUT /api/sites/:slug`):
  `403|413 {"error": "...", "code": "plan_limit", "limit": "sites" | "bytesPerSite" | "bytesTotal" | "filesPerSite"}`.

### Web pages (noteblock.ai, cookie sign-in)

- `/billing/upgrade?item=pro-year|pro-month|credits-350|credits-1500`: signs in if needed, then
  redirects to Stripe Checkout. The pricing page's buttons link here.
- `/billing/done` (Stripe success URL) and `/billing/canceled`: a short page that says what
  happened and to go back to the app.
- `POST /api/stripe/webhook`: Stripe events (signature checked with `STRIPE_WEBHOOK_SECRET`).
