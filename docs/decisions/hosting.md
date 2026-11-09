# Hosting published pages

Status: proposed, 2026-10-21.

## The question

Publish deploys a page to Cloudflare. Whose Cloudflare account does it land in, what happens
when the person has never logged in to wrangler, and can a published page run up a bill? And
if Quire offers hosting of its own, how does that sit next to "use your own Cloudflare"?

## How it works today

Publish stages the page as a static site and runs `pnpm dlx wrangler@4 deploy` against a
generated `wrangler.json` (`app/main/publish.mjs:147-163`). The config has a name, a
compatibility date, `workers_dev: true` and an `assets` block with
`not_found_handling: "single-page-application"`, and no `main` script
(`publish.mjs:150-162`). The staged site holds the transformed entry, the page's own files and
Quire's runtime under `/_quire/`. `data/`, dotfiles, `node_modules` and the backend folder are
left out (`publish.mjs:22-44`, `publish.mjs:85-115`).

The account is whatever wrangler on that Mac is signed in to. Quire passes no account id or
token of its own; it runs wrangler with `buildEnv()` (`app/main/ipc.mjs:411`), which is the
app's own environment with only `PATH` taken from the login shell
(`app/main/builds.mjs:54-64`). So a `CLOUDFLARE_API_TOKEN` exported in `.zshrc` does not reach
a Finder-launched Quire, and in practice the deploy uses the OAuth login wrangler keeps in
`~/.config/.wrangler/config/default.toml` ([wrangler general commands](https://developers.cloudflare.com/workers/wrangler/commands/general/)).
For Rhett that is his account. For anyone else it is their account, or nothing.

With no login, nothing prompts. `run()` sets `CI=1` on the child (`publish.mjs:120`), so
wrangler treats the run as non-interactive and fails instead of opening the OAuth flow. The
person sees "Deploying to Cloudflare failed." with wrangler's output
(`publish.mjs:164`). A person with several Cloudflare accounts hits the same wall, because
wrangler wants to ask which account to use. Publish also needs `pnpm` on the PATH.

Two smaller faults matter once other people publish. The Worker name is `quire-` plus the
page's folder name (`publish.mjs:62-71`), so two pages called "Notes" in different folders or
vaults overwrite each other's Worker in the same account. And the `public` record is written
into the page's `.quire` (`publish.mjs:168-170`), which syncs, so a second Mac signed in to a
different account would try to redeploy a Worker name it does not own.

## Can a published page cost money?

Not as published today. Requests to static assets are free and unlimited, and a Worker only
counts as invoked when a request does not match an asset
([static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)).
Quire's Workers have no script, and the SPA fallback is served by the asset layer, so every
request is an asset request. Traffic cannot push them past the free tier.

That changes as soon as a page has server code on Cloudflare, which "live" pages need
(`docs/brief.md:29-33`, `docs/brief.md:72-74`). On the Free plan a Worker gets 100,000
requests a day and 10 ms of CPU per request. Past the daily limit Cloudflare returns error
1027 (or 429 for `run_worker_first` routes) until midnight UTC. Free accounts are not billed,
they stop serving ([limits](https://developers.cloudflare.com/workers/platform/limits/)). On
the Paid plan it is $5 a month with 10 million requests and 30 million CPU ms included, then
$0.30 per million requests and $0.02 per million CPU ms
([pricing](https://developers.cloudflare.com/workers/platform/pricing/)). There is no ceiling,
so a scraped or abused page on a paid account bills its owner. The CPU limit per request can
be lowered with `limits.cpu_ms`. Durable Objects on the Free plan have their own daily
allowance (100,000 requests, 13,000 GB-s) and SQLite storage is billed only on paid accounts
([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).

## Options

Host on your own Cloudflare (BYO). Free for the person, nothing for us to run. It needs a
Cloudflare account and a wrangler login, which is fine for developers and a real barrier for
a friend. Abuse and bills are the account owner's problem. Live data would mean
deploying a Worker and a Durable Object into their account and managing migrations there, which
is a lot of surface to support across accounts we cannot see.

Quire hosting. Pages live in our account at a Quire URL, the person signs in to Quire, and we
charge for the parts that cost us. This is the only path that works for non-developers and the
only one that can be a paid tier. It needs:

- A Quire account with a sign-in handed off from the app to the browser (loopback or
  custom scheme, never an IdP inside a BrowserWindow), and a per-device token the app uses to
  upload.
- An upload API in place of wrangler: one Worker in our account with an upload endpoint that
  takes the staged site as a tarball or a file manifest, stores files in R2 keyed by
  `<vault>/<page>/`, and serves them by hostname. This costs a Worker invocation per request
  ($0.30 per million past the included 10 million), which is cheap and lets us meter. A Worker
  per page does not scale: an account holds 500 Workers on Paid, and beyond that it is Workers
  for Platforms at $25 a month ([limits](https://developers.cloudflare.com/workers/platform/limits/),
  [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/)).
- For live data, one SQLite Durable Object per live page fits the brief's model, where the owner's
  SQLite becomes the shared database (`docs/brief.md:72-74`). The runtime's standalone mode
  already swaps storage for localStorage on the web (`app/runtime/runtime.js:25`,
  `runtime.js:93-94`, `docs/contract.md:95-97`); live mode would swap it for calls to the
  page's Durable Object instead.
- Quotas per account on page count, total bytes, file size, requests per day per page, and
  Durable Object rows. Free tier with static pages and a small quota, paid tier for live pages,
  custom domains and higher limits.
- Abuse handling, since free static hosting attracts phishing kits. Require a signed-in account to
  publish, put a report link in a small footer, keep a kill switch per page and per account,
  and scan uploads for credential forms on known brands before they go live.
- A domain of its own. The ask was `<page>.<vault>.<appDomain>`, today `<page>.<vault>.harborapps.org`.
  Two problems. Universal SSL covers only first-level subdomains, so two labels need Advanced
  Certificate Manager or a single-label scheme
  ([Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations)).
  And user content on the same registrable domain as billable, Playtest and the rest shares
  cookie scope and reputation with them: one phishing page can get harborapps.org flagged. Put
  user pages on a separate apex used only for them (the way GitHub uses github.io), with
  `<page>--<vault>.<apex>` so one wildcard certificate covers it, and add that apex to the
  Public Suffix List. Read the apex from config like `appDomain`, never hard-code it.

## Recommendation

Keep BYO as the free, developer path and fix its rough edges now, since that is days of work.
Build Quire hosting next, static pages first, because it is what lets a non-developer publish
at all and it is the base the paid tier sits on. Add live data on Quire hosting after that, as
the paid feature. Do not build live data for BYO accounts unless developers ask for it.

## What to build

BYO, now:
- [ ] Before deploying, run `wrangler whoami --json`; when it exits non-zero, show "Connect
      Cloudflare", which runs `wrangler login` without `CI=1` (browser opens, callback on
      `localhost:8976`), then retries.
- [ ] When the login has several accounts, ask once and store `CLOUDFLARE_ACCOUNT_ID` per vault
      in local config (not in the synced `.quire`), and pass it to every wrangler run.
- [ ] Make Worker names unique per page: `quire-<slug>-<first 6 of page id>`.
- [ ] Store the account id in `public` and refuse to redeploy from a Mac signed in elsewhere,
      with a message saying which account owns it.
- [ ] Ship wrangler with the app or run it through Electron's Node, so publish works without pnpm.

Quire hosting, next:
- [ ] Separate user-content apex, wildcard DNS and certificate, Public Suffix List request.
- [ ] Quire accounts plus app sign-in handoff and device tokens.
- [ ] Serving Worker plus R2 bucket, upload endpoint, per-account quotas, report link and kill
      switch.
- [ ] A Publish target picker in the app: "Quire" (default once signed in) or "My Cloudflare".

Live pages, after:
- [ ] One SQLite Durable Object per live page, a runtime storage driver that talks to it, and
      the "go live" and "back to just you" data copies from `docs/brief.md:72-74`.
- [ ] Billing (Stripe) on the paid tier, with request and row quotas enforced in the Worker.
