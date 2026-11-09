# Noteblock AI

In-app AI, in 0.3.1. Two ways in: **⌘J** opens a prompt bar that changes the page you're on,
and **`/ai <request>`** in the slash menu builds something in place. The designs are the "In-app
AI" page of the design canvas (designs/canvas/build-ai.mjs). The name in the UI is always
"Noteblock AI", never Claude.

## The pieces

```
page frame (runtime.js)  ──rpc ai.*──▶  window (renderer)  ──IPC quire:ai*──▶  main (ai.mjs)
     ▲  {type:"ai", …} messages            ▲  "ai-event"                          │ Anthropic SDK
     └─────────────────────────────────────┘◀─────────────────────────────────────┤ baseURL = hosting
                                                                                   ▼
                                                        noteblock.ai/api/ai/v1/messages (quire-hosting)
                                                        key + model + limits ─▶ api.anthropic.com
```

- **main** runs the agent loop and owns every file change. Nothing reaches disk until apply.
- **hosting** holds the Anthropic key, picks the model, enforces limits, records usage. The app
  never sees the key and never chooses the model.
- **renderer** draws the ⌘J bar, the Settings pane and the sidebar spinner, and sequences
  flush → apply → reload.
- **runtime** draws the `/ai` placeholder block inside the page.

## The rules (board 11)

- The page never locks for AI. Main works from a snapshot of the page's files and records
  edits as ops (`edit` old_str→new_str, `write` whole file, `delete`).
- **Apply** replays the ops on the files as they are *now*: an `edit` whose `old_str` no longer
  occurs exactly once is skipped; a `write`/`delete` of a file that changed since the snapshot is
  skipped. Skipped ops are reported, never forced. Retry = a new job with the same prompt.
- Before apply, the renderer flushes the page's pending save (posts `{type:"save"}` to the frame
  and waits for the save RPC to finish), so the user's last keystrokes are on disk first.
- All of one job's applied changes are one git commit, `Noteblock AI: <prompt>`. Undo restores
  the pre-apply contents of each file still equal to what apply wrote, and commits
  `Undo Noteblock AI: <prompt>`.
- One page-wide (⌘J) job per page at a time. Block jobs: any number, each owns its marker.
- A page locked by `quire edit` refuses new jobs ("<agent> is editing this page").
- Pages created by a job (target `newpage`, or the `create_page` tool) are written directly:
  nobody else is editing them.

## Inline blocks (`/ai`)

The runtime inserts a marker into the page and saves it like any other block:

```html
<div data-q-ai="ai_k3j9x2" data-q-ai-target="block">a yen to dollar converter that uses today's rate</div>
```

`data-q-ai-target` is `block` (build here) or `newpage` (make a sibling page and embed it). The
text is the prompt. The runtime decorates it as the placeholder card (all decoration is
`data-q-ui`, so it is never saved). On apply, main replaces the whole marker element in the file
with the result: for `block` the generated HTML (an app block: `<div data-app …>` plus an inline
`<script type="module">`, and any extra files written beside the entry), for `newpage` a
`<quire-embed src="…">`. A marker missing from the file at apply time means the user deleted
it: the job ends as `stopped`. A marker left in a file with no running job (the app quit) shows
"Interrupted" with Retry and Remove.

## Hosting API (quire-hosting)

All `/api/ai/*` calls take the desktop bearer token (`Authorization: Bearer <token>`), like
`/api/me`.

- `POST /api/ai/v1/messages`: the Anthropic Messages API, passed through. The worker
  **replaces `model`** with the configured one (`x-noteblock-purpose: build` picks the build
  model, anything else the main model), caps `max_tokens` at 64000, and streams the upstream
  response back verbatim (SSE when `stream: true`). It records usage from the response
  (`message_start.usage` + `message_delta.usage`, or the JSON `usage`) into `ai_usage`.
  Refusals use Anthropic's error envelope `{"type":"error","error":{"type","message"}}` so the
  SDK raises them as API errors:
  - 401 `authentication_error`: no or bad token.
  - 403 `noteblock_ai_off`: "Noteblock AI isn't on for this account."
  - 429 `noteblock_ai_limit`: "Noteblock AI is paused until tomorrow."
- `GET /api/ai/status` → `{ enabled, model, buildModel, spentTodayCents, limitCents }`. Called
  when the bar opens and when Settings opens. Never polled (Neon: see the never-poll rule).
- `GET /admin`: the admin page (board 12), behind a Better Auth browser session whose email is
  in the `ADMIN_EMAILS` secret (comma separated). Others get 404.
- `GET /api/admin/ai` → `{ settings, today: {requests, spendCents}, month: {spendCents},
  people: [{email, requests, inputTokens, outputTokens, spendCents}] }` (today, by spend);
  `PUT /api/admin/ai` with a partial `settings`. Same session check.

`ai_settings` (one row, id 1): `model` (default `claude-haiku-5-5`), `build_model` (null = same),
`daily_limit_cents` (default 100), `access` (`everyone` | `admins` | `list`, default `list`),
`allow_list` (comma-separated emails, default empty), `updated`. No row = `admins` access, so only
`ADMIN_EMAILS` until the first save at /admin. Access checks only trust a provider-verified email (`user.email_verified`). Add people
at noteblock.ai/admin.

`ai_usage`: `id`, `user_id`, `at` (ms), `model`, `purpose`, `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_tokens`, `cost_micros` (USD × 10⁶). Prices per million tokens:
Haiku 5.5 $0.10 in / $0.50 out, Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20; cache reads 0.1× and
cache writes 1.25× the input price. The model picker offers exactly those three.

## Main process (app/main/ai.mjs)

Preload exposes `quireApp.ai` and `quireApp.onAiEvent(cb)`:

| call | returns |
|---|---|
| `ai.status()` | `{ signedIn, enabled, limitReached, model }` (`signedIn:false` without a token; no network then) |
| `ai.start({ page, prompt, target, blockId? })` | `{ jobId }`. `target`: `page` (⌘J, this page), `newpage` (⌘J "New page", or a `newpage` marker), `block` (a `block` marker; `blockId` = its `data-q-ai`) |
| `ai.stop(jobId)` | null |
| `ai.answer(jobId, askId, allow, always?)` | null. `always` sets that permission to Allow |
| `ai.apply(jobId)` | `{ applied, skipped: [{ file, reason }], summary, changed: [<data-q-i index>…], commit }` |
| `ai.undo(jobId)` | `{ restored, skipped }` |
| `ai.jobs()` | `[{ jobId, page, target, blockId, prompt, state }]` |
| `ai.permissions()` / `ai.setPermissions(patch)` | the permission map |

`ai-event` messages (main → every window): `{ jobId, page, target, blockId, prompt, type, … }`

- `progress` `{ text }` a short status line ("Reading Trip budget", "Writing app.js"), and for
  block/newpage jobs `preview`: the tail (≤ 800 chars) of the code being written.
- `ask` `{ askId, title, detail, permission }`: a step set to Ask (board 14).
- `ready` `{ summary }`: edits are computed; the renderer flushes the page and calls `apply`.
- `done` `{ summary, applied, skipped, changed }`: after apply.
- `error` `{ message, code }`, code one of `signed-out`, `off`, `limit`, `locked`, `network`, `failed`.
- `stopped`.
- `open` `{ page, newTab }`: the AI opened a page; the renderer shows it.

`changed` lists the `data-q-i` indexes (core/html.mjs `indexBody` numbering of the new entry) of
the top-level blocks that differ from before; the renderer passes them to the frame after the
reload so the runtime can mark them.

### Tools the model gets

Paths are vault page paths; `page` defaults to the page the request came from.

| tool | permission | |
|---|---|---|
| `read_file(page?, path)` | `readPages` (own page: always) | text files only, 200 KB cap |
| `list_files(page?)` | `readPages` (own page: always) | |
| `list_pages()` | always | the vault tree |
| `edit_file(page?, path, old_str, new_str)` | `editPage` / `editOtherPages` | staged |
| `write_file(page?, path, content)` | `editPage` / `editOtherPages` | staged |
| `delete_file(page?, path)` | `deleteFiles` | staged |
| `create_page(path, format?)`, `create_folder(path)` | `createPages` | immediate |
| `open_page(page, new_tab?)` | `openPages` | immediate, emits `open` |
| `trash_page(page)` | `trashPages` | immediate, the app's Move to Trash |
| `fetch_url(url)` | `fetchWeb` | GET, text, 100 KB cap |
| `insert_block(html, files?)` | (block jobs only) `editPage` | the block's HTML; `files` = `{path: content}` beside the entry |

Permissions live in `~/.noteblock/config.json` under `ai.permissions`, each `allow` | `ask` | `off`.
Defaults: `editPage` allow, `readPages` allow, `editOtherPages` ask, `createPages` allow,
`openPages` allow, `trashPages` ask, `deleteFiles` ask, `fetchWeb` allow. A tool set to `off`
gets a tool error ("Turned off in Settings") and the model carries on.

## Page frame ↔ window

Runtime → renderer RPCs, answered by the renderer (like `navigate`), not by main's `runRpc`:
`ai.start { prompt, target, blockId }` → `{ jobId }`, `ai.stop { blockId }`,
`ai.status { blockId }` → `{ running }`.

Renderer → frame: `{ quire: 1, type: "ai", event }` with the `ai-event` for that page's markers
(`progress`, `error`, `done`, `stopped`), and `{ quire: 1, type: "ai-changed", indexes }` after
a reload, so the runtime marks those blocks for a few seconds.

The shortcut is `ai-bar`, default `CmdOrCtrl+J`, menu Edit › Noteblock AI…, sent to the
renderer as the menu action `ai-bar`.

## 0.3.3: the ⌘J assistant (design: canvas page "Noteblock AI v2", designs/canvas/build-ai2.mjs)

⌘J is no longer "change this page". It is one assistant for the whole app with saved,
multi-turn conversations. Inline `/ai` keeps block jobs, loses the new-page option, and is drawn
as a pill. The `page` and `newpage` targets are gone; `start` takes `chat` or `block`.

### Conversations (main, app/main/ai-chats.mjs)

Saved per vault in `configDir()/ai/<vault key>/<conversationId>.json` (vault key: vault.json `id`
if it has one, else the first 16 hex of sha256(vault path)). Never in the vault. One file:

```json
{ "id": "aic_…", "title": "Kyoto notes into a Travel folder", "created": 0, "updated": 0,
  "turns": [Turn], "messages": [Anthropic MessageParam…] }
```

`title` = the first prompt via shortPrompt (60 chars). `messages` is the full API history; each
request sends the last 20 turns' worth, with tool_result contents older than the last 2 turns
replaced by "(old output omitted)".

`Turn`:
```js
{ id: "ait_…", jobId, prompt, page /* context page or null */, at /* ms */, endedAt,
  state: "working" | "ask" | "done" | "error" | "stopped" | "undone",
  steps: ["Read Trip budget", "Moved Kyoto trip into Travel"],   // progress lines, in order; the last is current while working
  reply: "",                                                     // the model's text (markdown-lite: **bold**, `code`, - lists, line breaks)
  changes: [{ kind, text, page? }],  // kind: edit|write|delete|create|folder|move|trash|setting|open; page = an Open link target
  skipped: [{ file, reason }],
  ask: null | { askId, title, detail, permission },
  error: null | { code, message },
  undoable: false }                  // true once done with something to undo, while this app run still holds the undo data
```

### Preload / IPC

| call | returns |
|---|---|
| `ai.chats()` | `[{ id, title, updated, turnCount, last /* last change text or reply, one line */ }]` newest first |
| `ai.chat(id)` | the conversation without `messages`, or null |
| `ai.deleteChat(id)` | null |
| `ai.start({ target: "chat", conversationId?, prompt, page? })` | `{ jobId, conversationId }`; no conversationId = a new conversation. One working turn per conversation: a second start while one works throws "Noteblock AI is still working on the last one." |
| `ai.start({ target: "block", page, prompt, blockId })` | `{ jobId }` (unchanged) |
| `ai.stop / answer / apply / undo / jobs / status / permissions / setPermissions` | unchanged. `undo(jobId)` on a chat turn undoes that whole turn (below). |

Events: everything from 0.3.1, and every event of a chat job also carries `conversationId` and
`turnId`. New types:
- `chat` `{ conversationId, conversation }`: the conversation (no `messages`) after any change to
  it: a turn added, a step, the reply, ask, done, error, undo. The renderer draws from this.
- `moved` `{ from, to }`: a page or folder moved; the renderer remaps the selected page and tabs.
- `settings` `{ keys }`: settings changed; the renderer re-reads prefs and shortcuts.

A chat job still goes `ready` → the renderer flushes the selected page's save (always, for chat
jobs, if a page is on screen) → `apply(jobId)` → `done`, exactly like 0.3.1.

### What a chat turn can do

Each page a chat turn is about to change is locked first, exactly like `quire edit` (core/lock.mjs
`beginEdit`, `by: "Noteblock AI"`, the prompt as the message, `aiJob: <jobId>` in the lock): the
app shows it read-only with the "Noteblock AI is editing this page" banner and the version from
before, and switches when the lock goes. The lock is released (`releaseEdit`, no commit, no
restore) after apply's commit, or when the turn errors or is stopped; locks with an `aiJob` left
from a run that quit are released on startup. Block (`/ai`) jobs don't lock: they only replace
their own marker. (Asked for 2026-10-26.)

Staged until apply, with the 0.3.1 skip rules: `edit_file`, `write_file`, `delete_file` on any page
(own-page = the context page uses `editPage`, other pages `editOtherPages`).
Immediate (and recorded for undo): `create_page`, `create_folder`, `move_page`, `trash_page`,
`change_setting`, `open_page`. Read-only: `read_file`, `list_files`, `list_pages`, `vault_stats`,
`get_settings`, `fetch_url`.

- `vault_stats()`: page/folder counts, total bytes, per top-level folder bytes and page counts,
  the 10 biggest pages, the 10 pages with the most data rows (store tables), last edited pages.
- `move_page(from, to)`: move or rename a page or folder (`to` is the full new path). Refuses a
  locked page, an existing target, the vault root, moving a folder into itself. Flushes
  autosaves, closes the moved pages' stores and stops their backends first (deps from ipc.mjs),
  `fs.renameSync`. Staged ops whose page is under `from` are rewritten to the new path. Emits
  `moved`. Permission `movePages` (default allow).
- `get_settings()` / `change_setting(key, value)`: keys `editor.textSize` (13–22),
  `editor.readableWidth`, `editor.font`, `editor.spellcheck`, `editor.defaultRenderer`,
  `confirmDelete`, `shortcut.<id>` (an Electron accelerator, "" clears). Never sign-in, sync
  remotes, API keys or `ai.permissions`. Goes through the same code as Settings (deps from
  ipc.mjs: `setPref`, `setShortcut`), emits `settings`. Permission `changeSettings` (default ask).
- The turn's commit (`Noteblock AI: <prompt>`) includes moved, created and trashed paths too.
- Undo of a turn: restores staged file edits (0.3.1 rules), moves back each move (newest first),
  moves created pages and folders to the Trash, restores each changed setting's old value. A
  trashed page can't be brought back from here: listed as skipped ("Put it back from the Trash").
  Then `state: "undone"`, a commit `Undo Noteblock AI: <prompt>`.

Permissions add `movePages` ("Move and rename pages", allow) and `changeSettings` ("Change
settings", ask).

### Renderer (app/renderer/src/AiChat.jsx, replaces AiBar.jsx)

Boards 1–10. A floating card over the main column, bottom centre, growing upward to about 60% of
the window, or docked to the right (400 px, the page reflows; remembered in localStorage). The
open conversation id is remembered in localStorage too.
- Closed → ⌘J opens it on the last conversation, in full, scrolled to the newest turn. No
  collapsed "Last: …" resume state (declined 2026-10-26: it popped to full as soon as you typed;
  "just resume the last conversation by default").
- Header (when there's a conversation): AI mark, title, clock (history), + (new), dock, ×.
- Empty bar footer: the clock and Send only (the "Continue <last title>" link was dropped
  2026-10-26: "clock icon alone is enough"). No context chip (declined 2026-10-26: "we should be good enough at navigating vault /
  adding to context when needed, shouldn't be on the user"). The selected page is still sent as
  the request's context page, invisibly.
- Turn: your prompt in a grey block; steps as one grey line ("Read 3 pages · 2.1 s"), expandable;
  the reply; changes as a bordered list of rows (icon, text, Open link) with one Undo.
- Working: the current turn shows the steps so far (ticks) and a spinner line with the current
  step, "esc stop". The card never collapses into a status bar.
- Ask: an inline row with "Don't esc" and "Allow ↵". ↵ allows and Esc declines while the input
  is empty and focused (or focus is in the card).
- History: the clock swaps the body for a searchable list grouped Today / Yesterday / Earlier,
  title + last line + time. Picking one opens it.
- Sending while a turn works is disabled. Esc with nothing to stop closes the card.

### Runtime (runtime.js): the /ai pill (boards 11–14)

- The slash menu shows one AI item, "Ask AI". Picking it, or typing `/ai` then a space, turns the
  line into a field: the block gets `data-q-ai-line` and is drawn as a bordered input, the
  "Ask AI" label in its left padding and the placeholder / ↵ as pseudo-elements (CSS only), the
  rest of the line is the prompt. No non-editable pill inside the text: it put the caret on top
  of the pill and the placeholder (changed 2026-10-26). Empty: placeholder "Describe what to build". ↵ sends (a block job);
  Esc, or Backspace at the very start, turns it back into plain text "/ai …".
- Sending writes the marker `<div data-q-ai="ai_…" data-q-ai-target="block">prompt</div>` as in
  0.3.1. Working: the marker is drawn as one line: pill with a spinner "Building", the prompt in
  muted text, a "Stop" link; a two-line code peek streams under it.
- Error: pill "Couldn't build" (warn colours), prompt, Retry and "Back to text", reason below.
- An old marker with `data-q-ai-target="newpage"` is treated as `block`.
