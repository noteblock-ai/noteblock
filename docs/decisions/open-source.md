# Open source

Status: decided 2026-10-21, built 2026-11-08 (PR #102). Going public is one `gh repo edit` away.

## The question

Should Quire be open source, under which license, and which parts? The plan has a possible
paid hosting and sync tier, and the bet is that templates and components people share become
the moat, the way plugins are for Obsidian.

## Where things stand

The repo `basketbla/noteblock` is private and `package.json` says `"private": true` with no
`license` field, so today it is all rights reserved. It holds the app (`app/`), the vault and
page format plus core library (`core/`), the CLI (`cli/`), an MCP server (`mcp/`), the page
runtime (`app/runtime/`), skills (`skills/`) and example pages (`examples/`). Hosting does not
exist yet; publish deploys to the user's own Cloudflare (`app/main/publish.mjs:163`).

## What the comparable products did

Obsidian is closed source and free, and charges for Sync ($4 to $5 a month) and Publish ($8 to
$10 a site) ([pricing](https://obsidian.md/pricing)). Its moat is the community plugin and
theme catalog built on a public API, not the source. Logseq went the other way with AGPL. Sentry
moved its server to the Functional Source License: source available, no competing commercial
use, and each release turns into plain Apache-2.0 after two years
([Sentry licensing](https://open.sentry.io/licensing)).

## License options

MIT or Apache-2.0. The most contributors and the least friction; anyone, including a funded
competitor, can ship a hosted Quire. Apache-2.0 adds a patent grant and is the better of the
two for a company.

AGPL-3.0. Open source by the OSI definition. Anyone running a modified Quire as a network
service must publish their changes, which scares off most commercial copycats. It also scares
off some companies from using it at all, and it only protects code that is served over a
network; a desktop app gets little from it beyond GPL.

FSL-1.1-Apache-2.0 (or BUSL). Source available, free for any use except a competing commercial
product, converting to Apache-2.0 after two years. Not OSI open source, and some people will say
so loudly. It keeps the option of a paid hosted tier without someone else selling it first.

## What to open

The moat is the format and the ecosystem, so the parts others build on should be the most open.
The page format (`.quire`, the folder layout, `docs/contract.md`), the page runtime
(`window.quire`), the CLI and the MCP server should be under a permissive license: authors of
templates and tools need to know their work does not depend on our goodwill, and a permissive
runtime lets pages run in other hosts too. Templates and components in a public gallery should
carry their author's license, defaulting to MIT.

The desktop app is the judgement call. Opening it earns trust, which matters for an app that
runs other people's code on your Mac (`docs/decisions/sandboxing.md`), and lets people audit
what it does. Keeping it closed changes little: the value a competitor would take is the
format and runtime, which are open anyway.

The hosting service (upload API, serving Worker, live data, billing, abuse tooling) stays closed.
It is where the paid tier lives and it changes too fast to keep a public contract on.

## Recommendation

Apache-2.0 for the format spec, runtime, CLI, MCP server, examples and skills. FSL-1.1-Apache-2.0
for the desktop app, which gives source access and trust now and turns into Apache-2.0 two
years later, while nobody can sell a hosted Quire off our code in the meantime. Hosting stays
private. Revisit making the app Apache-2.0 too once the hosted tier has paying users; going more
open later is easy, going less open is not.

Open it once the release pipeline exists (`docs/decisions/release.md`), the sandboxing basics
have landed, and a secrets sweep of the history is done. A public repo with "backends run with
your full privileges" is an invitation to write the exploit.

## Update, 2026-11-09: private for now, all FSL

The mirror went public on 2026-11-09 and was taken private the same day, before any launch post.
Noteblock is a paid product first; the source is not published for now. The groundwork stays so
opening it later is one command:

- The whole repo is FSL-1.1-ALv2 (`LICENSE.md`). The separate Apache-2.0 licenses on `core/`,
  `app/runtime/`, `cli/`, `mcp/`, `examples/` and `skills/` were dropped; FSL turns each release
  into Apache-2.0 after two years anyway.
- `noteblock-ai/noteblock` stays as a private mirror. `pnpm publish:oss` keeps it current
  (squashed snapshot, `.oss-exclude`, gitleaks, the release/CI leak guard).
- To open it: `gh repo edit noteblock-ai/noteblock --visibility public --accept-visibility-change-consequences`,
  keep Actions off on it, and put the GitHub icon back in the landing page header.

## Update, 2026-11-10: public, source available

The mirror is public again as source available under FSL-1.1-ALv2, never described as "open
source" (FSL is not OSI-approved). Actions stay off on it; the landing page header has the GitHub
icon again and the pricing page links the source.

## What to build

- [x] Sweep the git history for secrets and personal data (vault contents in examples,
      process-feedback notes with session links); start the public repo from a clean squash if
      the history is not clean. Done as a mirror: `pnpm publish:oss` pushes squashed snapshots,
      minus `.oss-exclude`, to `noteblock-ai/noteblock` after a gitleaks scan.
- [x] License: `LICENSE.md` (FSL-1.1-ALv2) for the whole repo (the Apache-2.0 split was dropped
      on 2026-11-09).
- [ ] Publish the format as its own doc (a cleaned `docs/contract.md`) with a version number.
- [x] `CONTRIBUTING.md` with a short CLA (a DCO sign-off alone does not let us relicense
      contributions later).
- [ ] A template gallery: a public repo of templates, each a page folder with a license field
      in `.quire`, installed through "expand into" and marked untrusted until approved.
