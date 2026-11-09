package org.harborapps.quire.vault

import java.io.File

/**
 * One row of the vault tree, as core/pages.mjs `listTree` returns it (docs/contract.md,
 * "Vault format"): a folder, a page (a folder holding a `.noteblock`, or legacy `.quire`, file) or a plain file.
 * Port of ios/Quire/Vault/VaultNode.swift.
 */
data class VaultNode(
    val kind: Kind,
    /** The page's manifest id (pages only). */
    val pageId: String? = null,
    /** Manifest title, else the folder (or file) name. */
    val title: String,
    /** Vault-relative path, "Kyoto trip/Trip budget". */
    val path: String,
    /** Absolute folder of a page or folder; the containing folder for a plain file. */
    val dir: File,
    val entry: String = "index.html",
    val source: String? = null,
    val build: String? = null,
    /** "quire" (editor), "view" (rendered, no text editing) or "source". */
    val renderer: String = "quire",
    val embedHeight: Int? = null,
    val backend: Backend? = null,
    val format: Format = Format.NONE,
    val children: List<VaultNode> = emptyList(),
    val lock: Lock? = null,
) {
    enum class Kind(val raw: String) { FOLDER("folder"), PAGE("page"), FILE("file") }
    enum class Format(val raw: String) { HTML("html"), MD("md"), NONE("none") }

    data class Backend(
        /** The backend folder (default "backend"); never served to the page. */
        val dir: String,
        /** Process name → command. */
        val run: Map<String, String>,
        /** The process /api/ * goes to. */
        val proxy: String?,
    )

    data class Lock(
        val id: String,
        val path: String? = null,
        val by: String? = null,
        val message: String? = null,
        val startedAt: String? = null,
    )

    val name: String get() = path.substringAfterLast('/')
    /** The folder holding this node ("" at the vault root). */
    val parentPath: String get() = if ('/' in path) path.substringBeforeLast('/') else ""

    val isPage: Boolean get() = kind == Kind.PAGE
    val isMarkdown: Boolean get() = format == Format.MD
    /** The page runs a backend (node processes): Mac only, read-only on the phone. */
    val hasBackend: Boolean get() = backend != null
    /** The page is built (manifest "build"): its committed output is shown, never rebuilt here. */
    val isBuilt: Boolean get() = build != null
    val isLocked: Boolean get() = lock != null
}

/** Every node, depth first, in tree order (core's walkTree). */
fun List<VaultNode>.walked(): List<VaultNode> = flatMap { listOf(it) + it.children.walked() }
