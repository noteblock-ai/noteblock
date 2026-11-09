// On-disk names. Noteblock was called Quire, and its files were named after it: the page
// manifest <page>/.quire, the vault's metadata <vault>/.quire/, the config dir ~/.quire.
// Writers use the new names (.noteblock); readers accept both and prefer the new one, so a
// vault synced from an older install, or a page copied in by hand, still opens.
import fs from "node:fs";
import path from "node:path";

/** A page's manifest file. */
export const MANIFEST = ".noteblock";
/** What the manifest was called through 0.3.2. */
export const OLD_MANIFEST = ".quire";
/** Every manifest name, preferred first. */
export const MANIFESTS = [MANIFEST, OLD_MANIFEST];
/** The vault's own metadata dir (vault.json, locks/, snapshots/). */
export const META_DIR = ".noteblock";
export const OLD_META_DIR = ".quire";
export const META_DIRS = [META_DIR, OLD_META_DIR];

/** True for a file or dir name that is a manifest / the vault's metadata dir, under either name. */
export function isManifestName(name) {
  return name === MANIFEST || name === OLD_MANIFEST;
}
export const isMetaDirName = isManifestName;

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The manifest a reader should use: <dir>/.noteblock, else <dir>/.quire, else the new name. */
export function manifestFile(dir) {
  for (const n of MANIFESTS) {
    const f = path.join(dir, n);
    if (isFile(f)) return f;
  }
  return path.join(dir, MANIFEST);
}

/**
 * A path inside the vault's metadata dir for reading: the new one when it exists there, else
 * the old one when that exists, else the new one. Writers use `newMetaPath`.
 */
export function metaPath(vault, ...segs) {
  for (const d of META_DIRS) {
    const p = path.join(vault, d, ...segs);
    if (fs.existsSync(p)) return p;
  }
  return path.join(vault, META_DIR, ...segs);
}

/** A path inside the vault's (new) metadata dir, for writing. */
export function newMetaPath(vault, ...segs) {
  return path.join(vault, META_DIR, ...segs);
}

/** The same path under every metadata dir name (for reads that merge, and for removal). */
export function allMetaPaths(vault, ...segs) {
  return META_DIRS.map((d) => path.join(vault, d, ...segs));
}

/** True when dir holds .noteblock/vault.json or .quire/vault.json. */
export function isVaultDir(dir) {
  if (!dir) return false;
  return META_DIRS.some((d) => isFile(path.join(dir, d, "vault.json")));
}
