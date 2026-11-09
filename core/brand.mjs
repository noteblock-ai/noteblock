// The product's public name and domains, in one place. Everything a person sees (window titles,
// menus, dialogs, the website, published-page URLs, the update feed) reads from here, so a rename
// is an edit to this file. Internal identifiers stay "quire" on purpose and are not listed here:
// quire:// URLs, window.quire, the `quire` CLI, the app id org.harborapps.quire (keeping it is
// what lets 0.2.x auto-update into this build). On-disk names did change: the manifest is
// .noteblock, the vault's metadata .noteblock/, the config ~/.noteblock (core/names.mjs).
// Pure (no Electron, no DOM): main, renderer, CLI, workers and scripts can all import it.

export const BRAND = {
  /** In prose, menus and window titles. */
  name: "Noteblock",
  /** The wordmark: `word` in ink, `tld` in grey (Geist 600, letter-spacing -0.04em). */
  word: "noteblock",
  tld: ".ai",
  /** Website, sign-in and upload API, downloads and the update feed. */
  domain: "noteblock.ai",
  /** Where the site, API and feed used to live; it keeps answering so older apps and links work. */
  legacyDomain: "quire.harborapps.org",
  /** Published pages used to be <slug>-quire.harborapps.org; those redirect to pageHost(slug). */
  legacyPageSuffix: "-quire.harborapps.org",
  /** Subdomains of `domain` that are not published pages. */
  reservedSlugs: ["www", "api", "app", "auth", "play", "docs", "download", "downloads", "updates", "mail", "status", "blog", "help"],
};

/** Host of a published page. */
export const pageHost = (slug) => `${slug}.${BRAND.domain}`;
/** https://noteblock.ai, or a path on it. */
export const siteUrl = (p = "") => `https://${BRAND.domain}${p}`;
