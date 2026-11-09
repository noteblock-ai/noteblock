# Bad stuff — misbehaving test pages

`scripts/make-bad-stuff.mjs` generates a folder of Quire pages that misbehave on purpose, so you
can watch how Quire copes: page freezes/crashes/loops and error badge on the frontend; process,
memory and CPU caps plus crash-loop give-up on the backend (limit names and defaults live in
`app/main/limits.mjs`).

```sh
node scripts/make-bad-stuff.mjs "$HOME/Quire/Dev Vault/Bad stuff"
```

Idempotent: it rewrites the folder from scratch every run, and page ids are derived from the page
name (sha1), so they stay stable across reruns.

## Hard safety rule

Every page is harmless to the Mac **even if all of Quire's protections fail**. Everything is
bounded and ends by itself: no network beyond the page's own backend, no file writes outside the
page's own folder, no deletes, no `setsid` escape that outlives 60s, nothing needing sudo. Each
page states its own bound. The notable caps:

- Fork bomb: at most 255 processes total; every process exits after 60s.
- Memory hogs: cap near 3 GB, then hold 30s, then stop.
- CPU spinners: stop after 90s.
- Log floods: stop at 50 MB.
- Freezes: 10s (self-recovering) or a 90s hard cap on the "infinite" loop.

## Pages

Open the generated **Bad stuff index** page for the live list with links. A few pages misbehave
the instant they open (marked on the page); the rest wait for a Start button. Opening a backend
page starts its Node backend (Quire runs it when the page is served).

### Frontend

| Page | What Quire should do | Bound |
| --- | --- | --- |
| Infinite loop (on click) | Detect unresponsive page, offer reload, show error badge | 90s hard cap, then recovers |
| Freezes for 10 seconds | Brief "not responding", clears without reload | 10s |
| Freezes on open | Unresponsive detection on load | 10s |
| Memory bomb | Page crash recovery / error badge | ~3 GB, hold 30s, release |
| DOM bomb | Keep app responsive; page reloadable | 300k nodes |
| Throws on load | Error badge | once on load |
| Unhandled promise rejection | Error badge | once on load |
| Error every second | Error-badge rate limiting | stops after 2 min |
| Huge console spam | Keep devtools/UI usable | 100k lines |
| Infinite embed recursion | See where the runtime caps embed nesting | self-limit 5 levels |
| Infinite reload loop | Stop babysitting a tight reload loop | 30 reloads (sessionStorage) |
| Never-ending fetch to its own backend | `/api` proxy must not hang UI; idle backend reaped | frontend 90s; backend closes each request at 60s, exits at 180s |

### Backend

| Page | What Quire should do | Bound |
| --- | --- | --- |
| Backend crashes on start | Retry with backoff, then crash-loop give-up | exits instantly |
| Backend crashes after 5 seconds | Restart with backoff; give up if it keeps dying | 5s per life |
| Backend crash loop | Crash-loop give-up (`crashLimit`/`crashWindowMinutes`) | 300ms per life |
| Backend fork bomb | Cap processes (`maxProcesses`); kill whole tree on stop | 255 procs; each exits at 60s |
| Backend memory hog | Stop at per-backend memory cap (`maxMemoryMB`) | ~3 GB, hold 30s, exit |
| Backend CPU spinner | Stop over `cpuPercent` for `cpuSeconds` | 90s |
| Backend ignores SIGTERM | Force-kill (SIGKILL) after `stopGraceSeconds` | exits itself at 60s |
| Backend escapes its process group | Shows the limit of process-group tracking | escaped child exits at 60s |
| Backend floods its log | Keep only last 256 KB per process | 50 MB, exit at 120s |
| Backend never listens | `/api` proxy waits 15s then 503s, no hang | exits at 90s |
| Backend holds a port someone else uses | Shows a port fight (EADDRINUSE) | exits at 60s, frees port |
| Backend slow to start | First `/api` 503s, later requests work | listens at 20s, exits at 120s |

## Why there is no `alert()` loop

The brief asked whether to include an `alert()` / modal-dialog loop. It is deliberately **not**
generated. A native modal from a page (`alert`, `confirm`, `prompt`) blocks the Quire renderer
process until dismissed, and a page cannot dismiss its own modal programmatically. A loop of them
would wedge the whole app rather than give a clean, bounded, self-ending test like the others — it
fails the hard safety rule, so it is skipped on purpose.
