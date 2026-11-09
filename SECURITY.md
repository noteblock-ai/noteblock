# Security

## Reporting a vulnerability

Email security@noteblock.ai. Please don't open a public issue for it.

Say what you found, how to reproduce it, and which version of Noteblock you were running (About Noteblock shows it). A proof of concept helps but isn't required. You'll get a reply within a few days, and we'll tell you when a fix ships.

## Trust model

A Noteblock page is a folder of files: HTML or Markdown, scripts, and optionally a build command and backend commands named in its `.noteblock` file. Opening a page can run that code. This section says what that code can and can't do.

### Trusted vaults

A vault you make on this computer is trusted, and so is the example vault a new install starts with. A page in a trusted vault has the same power as an app you install:

- Its `build` and `backend` commands run on your computer as you, with your files and your network. Noteblock limits a backend's memory, CPU and process count, but doesn't sandbox it.
- Its scripts can use the network.
- It can read the rest of the vault. Pages can't fetch each other's files directly, but the page API (`quire.files.read`, `quire.query`) reads any page's files and saved data, and a backend or build can read anything you can.

Only keep pages in a trusted vault that you would be willing to run as a program.

The example vault's pages that run commands or use the network are listed at the end of its Welcome page. `scripts/verify-seed.mjs` checks before each release that the example vault and the bundled templates run only those commands and name only the expected hosts.

### Vaults from elsewhere

When you open a vault that wasn't made on this computer, such as one you cloned or downloaded, Noteblock asks "Do you trust the author of this vault?" If you say no, the vault opens in restricted mode:

- No build or backend commands run.
- Pages can't use the network.
- A page sees only its own files and data, not the rest of the vault.

You can read and edit the pages. Trust the vault later if you decide to run them.

### Page isolation

Each page's HTML runs in a sandboxed iframe on its own origin (`quire://p-<page id>`), in its own renderer process. A page can't reach Noteblock's window, the Electron or Node APIs, or another page's DOM, localStorage or IndexedDB. Requests from one page to another page's files or backend are refused. Everything a page asks Noteblock to do goes through a message API that identifies the page by its origin, which a page can't forge.

### What isn't protected

- A page in a trusted vault can read the whole vault through the page API, and its commands can read anything on your computer that you can.
- A page in a trusted vault can send what it reads anywhere on the network.
- Templates added from a repo or URL drop their `build` and `backend` commands unless you approve them, but their page scripts still run when you use the template.
- Restricted mode depends on you answering the trust question carefully. If you trust a vault, its pages get everything above.

### What Noteblock itself sends

The app has no analytics. It checks noteblock.ai for updates, and talks to noteblock.ai when you sign in or publish a page. Sync pushes to the git remote you set up. Nothing else leaves your computer unless a page or its commands send it.
