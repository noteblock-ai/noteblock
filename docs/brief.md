# Quire — brief

Working name. A quire is a gathering of pages in bookbinding.

Obsidian with HTML instead of markdown. A vault is a file tree, every page is an app, and
each one starts as a blank HTML page. The runtime gives every page a small backend, so a
note can grow into a working tool without leaving the tree.

Status: design stage (2026-10-16). Design only, nothing built yet.

## Decisions so far

- **Everything is a `.app`.** There are no plain files: notes, journals and tools are all
  `Name.app/` folders. A new page is a `.app` holding one blank `index.html`. The tree draws
  each one as a single item, and a Source toggle opens the folder.
  - A `.app` is a plain directory with a manifest (`app.json`: title, icon, entry,
    capabilities), the same way macOS bundles work. Sync, git and backups see a normal folder.
  - Pages can nest (Kyoto trip › Trip budget), like Notion.
  - Open question: the suffix collides with macOS `.app` in Finder, which treats the folder as
    a broken application. Possible fixes: only show the suffix in-app, or use `.qapp` on disk.
- **Templates expand a page.** Starting from blank, "expand into…" applies a template
  (budget table, checklist, habit tracker, reading list, kanban…) that writes the HTML, the
  schema and any components into that `.app`.
- **Markdown still works.** An `index.md` inside a `.app` renders as a doc, and it can embed
  other apps (`![[Trip budget]]`).
- **Storage defaults to SQLite, one file per user.** A page's data lives in
  `Name.app/data/<user>.sqlite`, so each person who opens the vault gets their own copy.
  Code and data stay separate, and rewriting `index.html` never touches the data.
- **Visibility works like Notion's share switch.**
  - *Just you* (default): runs locally, and each viewer gets their own SQLite.
  - *Live on the web*: published at a URL. Data moves to a shared hosted store (synced),
    and everyone with the link sees the same rows.
  - The page uses the same runtime API in both modes. Only the storage backend changes.

## Runtime sketch (`window.quire`)

- `store`: tables/KV for this page, backed by SQLite (local) or the hosted store (live)
- `query()`: read other pages' data and properties (the Dataview equivalent)
- `files`: read/write other pages, gated by declared capabilities
- `ai()`, `fetch()` (proxied, keeps secrets out of the page), `schedule()`, webhooks
- Pages run in a sandboxed iframe. Capabilities are declared in `app.json` and approved on
  first run.

## Design

Canvas: https://claude.ai/artifact/KoXMtHxjaHGDUj8bPzBh7v. A snapshot lives in
`designs/canvas/project/`. Edit on the canvas, then re-pull it here.

- Three candidate systems: **Ledger** (crisp, cool, indigo), **Margin** (editorial serif,
  teal), **Graphite** (dark-first, lime).
- One sample page: sidebar plus a doc with two live apps embedded. Its `theme` tweak
  switches between the three systems.

## Decided 2026-10-16 (round 2)

- **Design system: Ledger.** The sample page is approved as drawn.
- **Editor model:** text is edited in place, apps are edited by asking. Prose (`p`, `h1–h3`,
  lists, tables, images) is contenteditable and saves back as plain tags. App blocks (any
  `<quire-*>` element or `data-app` region) are atomic: select, move, resize, set options in
  the inspector, ask AI, or open Source. The page shell (head, theme, scripts) is never shown
  or rewritten by the editor.
- **Slash menu** inserts text blocks, new inline apps, embeds of existing pages, or "build
  with AI". **Selecting text** offers "Make this an app".
- **Source view** is a mode of the page: the .app's files on the left, code in the middle,
  live preview on the right.
- **Sidebar ↔ disk:** one row is one `.app` folder; nesting on disk is nesting in the tree;
  `index.html`, `app.json`, `data/` and assets are hidden; links use the stable `id` in
  app.json; child order lives in the parent's app.json; the vault is watched, so outside edits
  appear. Vault settings live in `.quire/` (config.toml, templates/, components/).
- **A new page is only `index.html`.** app.json is written on the first rename/icon/access
  change, and `data/<user>.sqlite` on the first write.
- **Going live:** the owner's SQLite becomes the shared database. Other people's local copies
  are not merged. Embedded child pages go live with the parent. Switching back to Just you
  downloads the shared data into your copy.
- **Brand: Tiles** (three squares and a circle, one tile is a page) is the mark and app icon. Page Q, Gathering and Bracket were drawn and not picked.

## Open questions

- Who it's for: tinkerers/devs, or people who make apps with AI and never see code?
- Ship it as an Obsidian plugin first to validate, or as a standalone app (desktop + web)?
- Live page URL scheme (`<vault>.quire.site/<page>` is a placeholder)
- The `.app` suffix vs Finder (above)

## Round 3 decisions (2026-10-18)

- **No more `.app`.** Pages are plain directories. A directory with a `.quire` file in it is a
  page (`.quire` names the entry point, id and optional title); a directory without one is
  just a folder. This replaces "everything is a `.app`" above, along with `app.json`.
- **Folders are just folders, and pages don't nest.** The page-inside-page setup was dropped:
  folders group pages, and anything inside a page folder is that page's own files.
- **Sidebar creation:** right-click → New page / New folder; ⌘N = new page, ⌃⌘N = new folder.
- **Settings (⌘,)** starts with a Keyboard shortcuts screen where every shortcut can be
  rebound.
