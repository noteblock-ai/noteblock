---
name: noteblock
description: Change, create or inspect pages in a Noteblock vault (Noteblock was called Quire; the command is `noteblock`, and `quire` still works) — the local "Obsidian with HTML" app where every page is a folder with a `.noteblock` manifest holding index.html (or index.md), optional JS/CSS, and its own SQLite data. Use whenever the user says "noteblock" or "quire", names a Noteblock page ("change the Trip budget page to…", "add a chart to Habits", "make a new Noteblock page for…"), or asks to modify a file under ~/Quire. Always lock the page with `noteblock edit` first and finish with `noteblock done`, so the app shows the page as being edited and the change lands as one commit.
---

# Noteblock

The command is `noteblock`. Noteblock was called Quire, so `quire` still works as the same
command, and the default folder is still `~/Quire`. Files on disk are named `.noteblock` (a page's manifest, the vault's
`.noteblock/` folder, `~/.noteblock`); an older vault's `.quire` names are still read and are
renamed the next time the app or CLI opens it. A Noteblock vault is a folder (default `~/Quire/My First Vault`). A folder with a `.noteblock` file in it
is a **page**; any other folder is just a **folder** that groups pages. Pages don't hold pages.

```
Kyoto trip/              a folder (no .noteblock)
  Trip budget/           a page
    .noteblock           {"id": "...", "entry": "index.html", "title"?}
    index.html           the entry (or index.md for markdown pages)
    app.js, style.css    whatever the page needs, loaded relative to the entry (subfolders fine)
    data/<user>.sqlite   the page's data — never edit by hand
  Overview/              another page in the same folder
```

Pages are addressed by their **path** in the vault, e.g. `Kyoto trip/Trip budget`.

## The workflow, every time

```bash
noteblock ls                                      # find the page
noteblock edit "Kyoto trip/Trip budget" -m "Add a who-paid column"   # lock it; prints the folder
# …edit files in that folder with your normal tools…
noteblock done "Kyoto trip/Trip budget"           # unlock + commit to main
```

- `noteblock edit` locks the page. The Noteblock app shows a spinner on it, keeps showing the version
  from before your edit (read-only), and switches to your version the moment you run
  `noteblock done`. Write the `-m` message for the user: it's shown in the app while you work.
- **Always finish.** Run `noteblock done` (or `noteblock abort` to throw the edit away and restore the
  snapshot). A forgotten lock leaves the page read-only.
- Lock the page whose files you're changing. Each page locks separately.
- Need a new page? `noteblock new "Kyoto trip/Day plans"` (add `--md` for markdown), then
  `noteblock edit` it like any other page. The folder must exist: `noteblock mkdir "Kyoto trip"`.
- Starting from a template? `noteblock templates` lists them (they live in `~/.noteblock/templates`, outside the vault); `noteblock new "Journal/Oct 22" --template "Daily note"` copies one with a fresh id.
- See the data a page has stored: `noteblock data "Habits"` (JSON).
- History: `noteblock log`. Undo a finished edit: `git -C "$(noteblock vault)" revert <sha>`.

Every vault is one local git repo. Everything commits straight to `main`, and there are no
branches or remotes. The app also commits its own edits a few seconds after you type.

## Writing pages

**Plain notes:** keep top-level body children as plain text tags (`p h1–h4 ul ol blockquote
pre table hr img figure`). Those are editable in place in the app. Anything else (a `div`, a
custom element, anything with `data-app`) is an "app block": rendered, but not text-editable.
Text your scripts write into the page (a filled `<ul>`, a message set with `textContent`) is
not editable in the app either, and its edits are never saved; keep prose the user should edit
out of elements a script renders into.

**Apps:** in index.html, put `<div id="root" data-app></div>` and
`<script type="module" src="./app.js"></script>`. React and htm are available through the
import map, so there's no build step and no JSX:

```js
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import html from "htm/react";

await quire.ready;
const lines = quire.store.table("lines");

function App() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const load = () => lines.all().then(setRows);
    load();
    return lines.subscribe(load);           // live updates from other frames
  }, []);
  return html`<ul>${rows.map(r => html`<li key=${r.id}>${r.label}</li>`)}</ul>
    <button onClick=${() => lines.insert({ label: "New" })}>Add</button>`;
}
createRoot(document.getElementById("root")).render(html`<${App} />`);
```

**Apps with a build step** (Vite, webpack, TypeScript, Svelte…): the page's `.noteblock` gets
`"build": "<command>"` (run in the page folder), `"entry": "dist/index.html"` (the built file
Noteblock serves) and `"source": "index.html"` (the template prose edits go to). Use relative
asset URLs (Vite: `base: "./"`), keep the module `<script>` as the last child of `<body>`,
and keep `node_modules` out of git (the vault ignores it). `noteblock done` runs the build before
committing, so the built output lands with the change; `noteblock build <page>` runs it on its
own. Prose (`<p>`, `<h2>`…) around the app's `<div data-app>` stays editable in the app.
Copy `Apps/Reading list` (React, prose around an app) or `Apps/Focus timer` (Svelte, a
whole-page app) from the vault.

**Pages with a backend** (an API server, a database, anything that has to run, or needs a
secret): put the server code in the page's `backend/` folder and name the commands in
`.noteblock`: `"backend": {"run": {"api": "node server.js", "db": "redis-server --port $PORT"}}`
(a single string is fine too). The app runs each one in `backend/` the first time the page is
opened, restarts them when a file under `backend/` changes, and restarts a crashed one with
backoff. Each process gets its own fixed port in `$PORT` and its siblings' in `$PORT_<NAME>`
(`$PORT_API`, `$PORT_DB`); never hard-code a port. The page calls the `api` process (or the one
`"proxy"` names) at `fetch("api/…")` or `fetch("/api/…")`: the request path, `/api/…`
included, is forwarded as is, so the server routes `/api/…`. Secrets go in `backend/.env` (loaded
into the processes' environment, gitignored, never published); commit a `.env.example`. Keep
the server's own data in `backend/data/` (gitignored). `backend/` is never published or served
to the page. Read output with `noteblock logs <page> [name]`. Copy `Apps/Guestbook` from the vault.

**Renderer:** `"renderer"` in `.noteblock` is how the page opens: `"quire"` (default, the
in-place editor), `"view"` (rendered, no text editing; right for whole-page apps) or
`"source"` (source + preview).

**The backend, `window.quire`:** every call returns a Promise.
- `quire.store.table(name)`: `.all()`, `.get(id)`, `.insert(obj)`, `.update(id, patch)`,
  `.remove(id)`, `.subscribe(cb)`. Rows are schemaless JSON; each has `id`, `_created` and
  `_updated`. Tables appear on first insert, so there are no migrations.
- `quire.kv.get(key)`, `quire.kv.set(key, value)` for settings.
- `quire.query("Other/Page", table)` reads another page's table (read-only).
- `quire.pages()`, `quire.navigate("Other/Page")`, `quire.page` (`{path, title, id, readOnly}`).
- When `quire.page.readOnly` is true, or a write rejects, disable inputs.

**Embeds:** `<quire-embed src="Sibling page"></quire-embed>` in a page (or `![[Child page]]` on
its own line in markdown). `src` is relative to the folder holding the current page (so a page in the same folder is just its name); `/Habits` is from the vault
root.

**Style:** the default theme (Ledger) styles plain notes. Apps that want full control set
`<body data-q-theme="none">` and can still use the CSS variables `--q-ground`, `--q-raised`,
`--q-ink`, `--q-muted`, `--q-line`, `--q-accent`, `--q-accent-soft`, `--q-font`, `--q-mono`,
`--q-radius` (see `app/runtime/theme.css` in the Noteblock
repo). Look at the example apps in the vault (`Habits`, `Kyoto trip/Trip budget`) before
writing a new one, and copy their structure.

## Without the CLI

There's an MCP server with the same verbs (`quire_list`, `quire_read`, `quire_begin_edit`,
`quire_write_file`, `quire_end_edit`, `quire_abort_edit`, `quire_new_page`, `quire_data`):
`node --disable-warning=ExperimentalWarning ~/projects/quire/mcp/server.mjs`. Prefer the CLI.

## Rules

- Never hand-edit `data/*.sqlite`, `.noteblock/locks` or `.noteblock/snapshots`.
- Don't run `git commit` yourself inside a vault; `noteblock done` does it.
- Don't load anything from a CDN. Pages work offline; React and htm come from the import map.
- Contract with every detail: `~/projects/quire/docs/contract.md`.
- Building a page you'd otherwise publish as a claude.ai Artifact, or importing artifacts
  (`noteblock import-artifact <file> --url <url>`): see the `noteblock-artifact` skill.
