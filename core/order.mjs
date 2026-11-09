import fs from "node:fs";
import path from "node:path";

/**
 * A folder's hand-made order (sidebar drag), as a JSON list of the names of its rows. Hidden
 * like every dotfile, synced and committed with the vault. Names it doesn't list (new pages,
 * rows moved in) follow the listed ones in the default order; names it lists that are gone
 * are ignored.
 */
export const ORDER_FILE = ".noteblock-order.json";

export function readOrder(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, ORDER_FILE), "utf8"));
    return Array.isArray(list) ? list.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

export function writeOrder(dir, names) {
  fs.writeFileSync(path.join(dir, ORDER_FILE), JSON.stringify(names, null, 1) + "\n");
}

const nameOf = (node) => node.path.split("/").pop();

/** `nodes` (already in the default order) with the names in `names` first, in that order. */
export function applyOrder(nodes, names) {
  if (!names.length) return nodes;
  const rank = new Map(names.map((n, i) => [n, i]));
  const listed = nodes.filter((n) => rank.has(nameOf(n))).sort((a, b) => rank.get(nameOf(a)) - rank.get(nameOf(b)));
  return [...listed, ...nodes.filter((n) => !rank.has(nameOf(n)))];
}

/** `names` with `name` taken out and put back before `anchor`, or after it when `after`. */
export function placeName(names, name, anchor, after) {
  const list = names.filter((n) => n !== name);
  let i = list.indexOf(anchor);
  if (i < 0) i = list.length;
  else if (after) i += 1;
  list.splice(i, 0, name);
  return list;
}

/** A renamed row keeps its place. True when the folder had an order to change. */
export function renameInOrder(dir, from, to) {
  const names = readOrder(dir);
  if (!names.includes(from)) return false;
  writeOrder(dir, names.map((n) => (n === from ? to : n)));
  return true;
}
