# Many backends

Status: idle stop and cap shipped (US-007); a watchdog for process count, memory and CPU, and
a crash-loop limit shipped 2026-10-22. Every limit is set in Settings → Activity & limits, which
also shows memory, CPU and process count per backend.

## The question

If a vault has 100 pages with backends, what does that cost, and what stops it getting out of
hand?

## How it works today

A backend starts the first time its page or an embed of it is served and runs until Quire
quits or switches vault (`app/main/backend.mjs:1-5`, `app/main/main.mjs:340-343`,
`main.mjs:93`). Nothing stops an idle one. Each named process is a separate `/bin/sh -c`
child with its own port from 47000-48999 (`backend.mjs:13-14`, `:146`). A crashed process is
restarted with backoff up to 30 seconds, forever (`backend.mjs:182-188`). Opening a page
that embeds others starts all their backends too.

## What 100 cost

An idle Node HTTP server measured here sits at about 40 MB resident (Node 22, one
`http.createServer`, `ps -o rss`). With a shell wrapper per process and some pages running
two processes, 100 pages is roughly 4 to 6 GB of RAM held for nothing, plus a few hundred file
descriptors and 100+ ports out of the 2,000 available. CPU is near zero while idle, but a page
that crashes on start costs a restart every 30 seconds indefinitely, and a page with a file
watcher or a timer costs CPU all day. Battery and fan noise are what a person would notice
first.

## Mitigation being built now

US-007 adds an idle stop and a cap to `backend.mjs`. A backend that has had no page load and
no `/api` request for 15 minutes is stopped. At most 12 backends run at once; starting a 13th
stops the least recently used. A stopped backend starts again on the next page load or API
call, using the same port, since ports are kept per page in `ports.json`
(`backend.mjs:48-58`). The proxy already waits up to 10 seconds for a backend that was just
started (`app/main/protocol.mjs:254-265`), so a cold start shows as a slow first request, not
an error.

With that in place, 100 backends cost the same as 12, about 0.5 to 0.7 GB at worst.

Both limits are now set in Settings → Activity ("Stop idle backends after", "Max running
backends"), which writes `backends` in `~/.quire/config.json` and applies the change at once.
The same tab shows each backend's memory (its whole process tree) and CPU next to Quire's own.

## Safety limits (shipped)

The idle stop and cap bound how many backends run; they don't bound what one backend does. A
page's backend is any shell command, so one bad page (a fork loop, a leak, a spin) could take
the machine down. `backend.mjs` now runs a watchdog while any backend runs: one
`ps -A -o pid=,ppid=,pgid=,rss=,pcpu=` every `checkSeconds` (default 2). Each backend process
is spawned detached, so its `/bin/sh` leads a process group of its own; the watchdog counts
everything in that group plus every descendant of it by parent pid, so a child that calls
`setsid` but stays a descendant is still counted (`activity.mjs` `backendUsage`). A process
that fully escapes (its parent exits, it is reparented to launchd in a new session) can't be
told apart from anything else on the machine and isn't tracked; that needs the sandbox
(`sandboxing.md`).

| Limit | Default | What happens |
| --- | --- | --- |
| `maxProcesses` | 64 | Over it: the group and every tracked descendant are frozen (SIGSTOP), looked at again until nothing new appears, then SIGKILLed. No grace period, since a fork bomb outruns one. |
| `maxMemoryMB` | 1024 | Total RSS over it: SIGTERM, SIGKILL after `stopGraceSeconds`. |
| `cpuPercent` / `cpuSeconds` | 90% / 60 s | At or over the percentage at every check for that long: the same graceful stop. |
| `crashLimit` / `crashWindowMinutes` | 5 / 2 min | That many crashes within the window: no more restarts, state `crashed`. |
| `stopGraceSeconds` | 5 | Replaces the old hard-coded 5 s for every stop. |

0 turns off each of the first four. A stopped or given-up process keeps that state with a
`reason` ("too many processes (130)", "used too much memory (1210 MB)", "used 98% CPU for 61s",
"kept crashing (5 times in 2 min) — restart to try again") and a `limitHit` code, the line
`[quire] stopped: … (130 > 64)` goes into its own log, and it stays down until a manual Restart
(or a change to its files), which also clears the crash count. All limits live in
`app/main/limits.mjs` and are read on every check.

Fork bombs grow exponentially, so the first check runs 250 ms after a process starts and
checks stay at most 500 ms apart for its first 10 s. A macOS detail matters here: `ps` lists
processes with `sysctl(KERN_PROC_ALL)`, which retries while the process table keeps growing,
so during a fork storm `ps` doesn't answer until the storm ends, which for a real bomb is never.
When `ps` hasn't answered in 250 ms, the watchdog freezes every backend's group (SIGSTOP, again
every few ms for a moment to catch children mid-fork; Node's spawn of `ps` blocks the main
thread, so this has to happen before it), lists again, kills what's over its limit and
SIGCONTs the rest. In `scripts/smoke-backend.mjs` a tree growing to 200 shells (one perl
`setsid`s out of the group) with `maxProcesses` 20 is gone in 0.4 to 1.8 s, and a well-behaved
backend running beside it is left running.

## Further options

- Socket activation. Quire listens on each backend's port itself and only spawns the process
  on the first connection, handing over the socket (or replaying the first request). The proxy
  already sits in front of `/api` (`protocol.mjs:244-273`), so most of this exists: starting on
  first request rather than on page load would mean a page that never calls its API never
  starts a process. Cheap next step.
- One shared runtime. Run JS backends as modules inside one Node process (or Electron's own
  utility process), each with its own router and port. Memory drops to a few MB per backend.
  It breaks isolation between backends, which matters for the sandboxing plan
  (`docs/decisions/sandboxing.md`), and only works for JS.
- Workers instead of processes. Write backends against the Workers API and run them locally
  with workerd (one process, many isolates) and on Cloudflare unchanged. This is also the
  shape live pages need when hosted (`docs/decisions/hosting.md`). It costs the freedom to run
  any command, so it fits as a second, preferred backend kind, not a replacement.

## Recommendation

Ship US-007 as designed (done), plus the safety limits (done). Then start backends on first
`/api` request instead of page load. Consider a Workers-style backend kind when live hosting is built, since
that is where the two plans meet.

## What to build

- [x] US-007: 15-minute idle stop, cap of 12, LRU eviction, restart on demand.
- [ ] Start on first `/api` request rather than on entry served (`main.mjs:342`).
- [x] Give up after repeated crashes (`crashLimit` in `crashWindowMinutes`); state `crashed`
      with a reason until Restart.
- [x] Watchdog: max processes, memory and CPU per backend, all configurable.
- [x] Show running count and memory per backend: Settings → Activity, with the limits editable.
- [ ] Later: a `"backend": {"worker": "src/index.js"}` kind run by workerd locally.
