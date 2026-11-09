// Which page the floating note shows (no Electron here, so scripts/smoke-floating.mjs can test it).
import { findPage, createPage } from "../../core/index.mjs";

export const DEFAULT_FLOATING_PAGE = "Floating note";

/**
 * page: the configured page, or null when none was ever picked. Null resolves to "Floating note"
 * in the vault root, created when it isn't there. A configured page that's gone (deleted,
 * renamed, moved, another vault) is reported as missing, never swapped for another page.
 * @returns {{node: object, created?: boolean} | {missing: string}}
 */
export function resolveFloatingPage(vault, page) {
  if (!page) {
    try {
      return { node: findPage(vault, DEFAULT_FLOATING_PAGE) };
    } catch {
      return { node: createPage(vault, DEFAULT_FLOATING_PAGE, { format: "html" }), created: true };
    }
  }
  try {
    return { node: findPage(vault, page) };
  } catch {
    return { missing: page };
  }
}

/** A new blank note in the vault root: "Floating note", or "Floating note 2", 3, … when taken. */
export function createFloatingNote(vault) {
  for (let i = 1; ; i++) {
    const name = i === 1 ? DEFAULT_FLOATING_PAGE : `${DEFAULT_FLOATING_PAGE} ${i}`;
    try {
      return createPage(vault, name, { format: "html" });
    } catch (err) {
      if (!/^Already exists/.test(String(err?.message)) || i > 999) throw err;
    }
  }
}
