# Full exec in Noteblock, and containers

Status: proposed, 2026-11-02. Nothing here is built. Needs Rhett's decision.

## The question

"Can we just do full exec in Noteblock? Like bash? If so, how do we keep it consistent across
machines? Containerization is probably the best way, maybe with a skill that defaults to
containers unless you really need raw. Understand the ramifications first; containers get bulky."

## Where it stands

A page can already run anything. A `backend` in `.noteblock` is `sh -c <command>` (`cmd.exe` on
Windows), run as the user with their full environment and the page's `.env`
(`app/main/backend.mjs:290`). A `build` is the same. So the feature exists. Three things are
missing:

- **Consent.** A backend starts when its page is served, or when its manifest changes, which
  includes a sync pull. Nothing asks first (`docs/decisions/sandboxing.md`). A shared vault or
  template can run code on your machine the moment you open it.
- **Consistency.** `requires` is informational. Dependencies are never installed, `node_modules`
  and `.venv` are gitignored, and `.env` never syncs. On a second machine a page's backend
  fails until someone installs by hand.
- **A way to run code from the page itself.** The page's script can't call bash. It has to go
  through a backend route. That's the right boundary, and it should stay.

## What containers would cost

| | Local containers by default | Bundled runtimes plus a sandbox profile |
|---|---|---|
| Install | Docker Desktop or similar, which most note-takers won't have. Shipping our own engine is a large, separate product | Already shipped: Node, pnpm, git |
| Disk | Base image plus layers, commonly hundreds of MB and more per language | Each page's `node_modules` |
| Start time | Seconds on a cold start, plus a VM on Mac and Windows | Under a second |
| Memory | A Linux VM running all day on Mac and Windows | Only the running backends |
| Windows | WSL2 or Hyper-V, with admin rights and support issues | Same code path as today |
| Phones | Impossible | Backends already don't run there |
| Local things | No keychain, GUI apps or host tools, and file access through a mount | Everything works |
| Isolation | Strong | Medium: deny-lists for secrets and network rules |
| Consistency | Strong | Good with lockfiles for Node and Python, weak for system tools |

These sizes are typical figures, not measurements. Measure on a real image before relying on them.
Docker is on this Mac, but it's not a fair sample of who downloads a notes app.

Local containers as the default would make the first run worse for everyone, to help the small
share of pages with a backend. It also undercuts the pitch that a page is just a folder of files.

## Recommendation

Don't make containers the default. In order:

1. **Ask before running.** First run of a backend or build on a machine shows the exact command,
   with Allow and Don't run. Remember the answer per machine, keyed on page id plus a hash of the
   command, so a changed command asks again. Small, and needed regardless of everything else: this
   is the gap that blocks shared vaults, templates and team use. (GitHub templates in this PR
   already strip `backend` and `build` unless allowed, but that only covers that one door.)
2. **Install from the lockfile.** Before starting a backend, if `pnpm-lock.yaml` exists and
   `node_modules` is missing or stale, run `pnpm install --frozen-lockfile` with the bundled pnpm,
   and show it as "Setting up". The same for Python with `uv` if it's bundled later. This answers
   most of "same vault on two machines".
3. **Say what's needed.** Make `requires` real: check for tools at start and name what's missing,
   which the app partly does already. `.env` stays per machine, but the page says which keys are
   missing, from a committed `.env.example`.
4. **Sandbox profile.** The plan in `sandboxing.md`: `sandbox-exec` on Mac, deny `~/.ssh`,
   cloud credentials and the like. Opt out per page.
5. **Containers only as a remote runner.** A team tier would need a hosted runner so
   teammates see live data. A container is the right shape there: it runs on our servers, the user
   installs nothing, and it also gives a real answer on phones. Build it when the first team pays.
6. **Skill wording.** The `noteblock` skill tells agents to use a Node backend with a lockfile, and
   to reach for raw system tools only when needed.

## What a "full bash" page API would be

If "like bash" meant a terminal block in a page, or a `quire.exec()` for page scripts: don't add
`quire.exec()`. Any page script, including ones pasted from elsewhere, would become a shell, and
page sandboxing is the one thing protecting people today. A terminal block is a safe add-on later,
since it's a backend route with the person typing.

## Open questions for Rhett

- Did "like bash" mean a terminal in a page, script-callable exec, or agents running commands from
  ⌘J? The last is a real gap: Noteblock AI has no shell tool today. It would need the same consent
  prompt, command by command.
- Okay to ship item 1 next? It adds one dialog the first time anyone opens a page with a backend,
  including your existing pages on each machine.
