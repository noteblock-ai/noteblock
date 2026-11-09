package org.harborapps.quire.vault

import java.io.File
import org.harborapps.quire.app.QuireApp

/**
 * Where vaults live on the phone, and the on-disk names core/vault.mjs writes.
 *
 * Noteblock (formerly Quire) renamed its on-disk names: the vault metadata dir `<vault>/.quire/`
 * is now `<vault>/.noteblock/` and each page's manifest `<page>/.quire` is now `<page>/.noteblock`.
 * The desktop migrates vaults in place, but a synced vault can hold either name or a mix (an
 * older device pushes a page with `.quire`). So: every read accepts both (the new name wins
 * when both exist), every write uses the new name. This object is the one place those names live.
 */
object VaultPaths {
    /** A page's manifest file name (written by this app). */
    const val MANIFEST = ".noteblock"
    /** The manifest name older vaults and devices still use (read only). */
    const val LEGACY_MANIFEST = ".quire"
    /** Manifest names in preference order. */
    val MANIFEST_NAMES: List<String> = listOf(MANIFEST, LEGACY_MANIFEST)

    /** The vault metadata folder (vault.json, locks/, snapshots/) this app writes. */
    const val META_DIR = ".noteblock"
    /** The metadata folder name older vaults still use (read only). */
    const val LEGACY_META_DIR = ".quire"
    /** Metadata folder names in preference order. */
    val META_DIRS: List<String> = listOf(META_DIR, LEGACY_META_DIR)

    /**
     * core/vault.mjs GITIGNORE (and VaultStore.gitignore on iOS), with the locks/snapshots
     * lines for both metadata folder names so a half-migrated vault never commits them.
     */
    const val GITIGNORE = "data/\n.noteblock/snapshots/\n.noteblock/locks/\n.quire/snapshots/\n.quire/locks/\n" +
        ".DS_Store\nnode_modules/\n.env\n.env.*\n!.env.example\n"
    /** The prefs key holding the current vault's folder name (iOS: UserDefaults "quire.vault"). */
    const val CURRENT_KEY = "quire.vault"

    /** True for a page manifest's file name, new or legacy. */
    fun isManifestName(name: String): Boolean = name in MANIFEST_NAMES

    /** True for a vault metadata folder's name, new or legacy. */
    fun isMetaDirName(name: String): Boolean = name in META_DIRS

    /** The page manifest in `dir` (`.noteblock`, else `.quire`), or null when it has none. */
    fun manifestFile(dir: File): File? =
        MANIFEST_NAMES.asSequence().map { File(dir, it) }.firstOrNull { it.isFile }

    /**
     * `<root>/<meta dir>/<rel>`: the `.noteblock/` copy when it exists, else the `.quire/` one
     * when that exists, else the `.noteblock/` path (where a write should go).
     */
    fun metaFile(root: File, rel: String): File {
        val primary = File(File(root, META_DIR), rel)
        if (primary.exists()) return primary
        val legacy = File(File(root, LEGACY_META_DIR), rel)
        return if (legacy.exists()) legacy else primary
    }

    /** True when `dir` is a vault: it has `.noteblock/vault.json` or `.quire/vault.json`. */
    fun isVault(dir: File): Boolean = META_DIRS.any { File(File(dir, it), "vault.json").exists() }

    /**
     * The folder holding every vault: app-specific internal storage (the iOS app's Documents).
     * Each vault is a direct child folder with `.noteblock/vault.json` (or legacy `.quire/`).
     */
    val vaultsDir: File get() = File(QuireApp.context.filesDir, "vaults").also { it.mkdirs() }
}
