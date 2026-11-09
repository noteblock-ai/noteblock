# Agents and Noteblock

The intended use: "hey Claude, change this Noteblock page to do X." This page explains how that
works and why it's built this way.

## Version control: one git repo per vault, straight to main

- Each vault is a local git repo. There are no remotes and no branches; every change lands on
  `main`.
- The app commits your own typing 5 seconds after you stop (`Edit <page>`).
- An agent makes one commit per task, at `noteblock done`, using the message it gave
  `noteblock edit -m`. The author is `Claude <claude@quire.local>`.
- `data/` is not in git. Page data belongs to each person, and code history shouldn't churn
  on it. Agents change code, not your rows.
- Undo is git: `noteblock log`, then `git -C "$(noteblock vault)" revert <sha>`.

## Editing a page: lock → edit → done

```
noteblock edit <page> -m "<what>"   →  .noteblock/locks/<id>.json + .noteblock/snapshots/<id>/
   (agent edits the page's files)
noteblock done <page>               →  lock + snapshot removed, git commit
noteblock abort <page>              →  snapshot copied back, lock removed, no commit
```

While the lock exists, the app:

- shows a spinner on the page in the sidebar,
- serves the page from the snapshot, so you keep seeing the working version from before the
  edit while the agent's half-written files sit on disk,
- makes the page read-only (no typing; data writes are refused),
- shows a banner with the agent's message.

When the lock goes away, the page reloads with the new files. The app holds off its own
autosave commits while any lock exists, so an agent's in-progress files never get committed
under an "Edit …" message.

Locks are per page. Editing `Kyoto trip/Trip budget` doesn't lock `Kyoto trip`.

## Three ways in, same verbs

| | CLI | MCP | Skill |
|---|---|---|---|
| find | `noteblock ls` | `quire_list` | uses the CLI |
| read | `noteblock cat`, `noteblock path` | `quire_read` | |
| lock | `noteblock edit -m` | `quire_begin_edit` | |
| write | any file tool | `quire_write_file` | |
| finish | `noteblock done` / `noteblock abort` | `quire_end_edit` / `quire_abort_edit` | |
| new | `noteblock new [--md]` | `quire_new_page` | |
| data | `noteblock data` | `quire_data` | |

The skill (`skills/noteblock/SKILL.md`) is what Claude Code reads. It teaches the workflow and the
page runtime API in one page.

## Stale locks

If an agent dies mid-edit, the page stays read-only. `noteblock status` lists locks, and
`noteblock abort <page>` (put the old files back) or `noteblock done <page>` (keep what's there)
clears one.
