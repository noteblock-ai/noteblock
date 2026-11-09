package org.harborapps.quire.vault

import java.io.File
import java.nio.file.Files
import java.security.SecureRandom

/** Write errors (iOS VaultEditError). */
sealed class VaultEditError(message: String) : Exception(message) {
    class EmptyName : VaultEditError("Give the page a name")
    class Exists(val path: String) : VaultEditError("Already exists: $path")
    class NoFolder(val path: String) : VaultEditError("No folder: $path")
    class ParentIsPage(val path: String) : VaultEditError("$path is a page; pages can't hold other pages or folders")
    class Locked : VaultEditError("Claude is editing this page on your Mac")
    class NotFound(val path: String) : VaultEditError("Not found: $path")
}

/**
 * Writes to the vault tree (port of ios/Quire/Vault/VaultStore+Edit.swift): core/pages.mjs
 * createPage, and delete (the phone moves to a vault-local `.trash/`, which listTree skips).
 * Every file written or removed is reported through [VaultStore.onWrite].
 */
object VaultEdit {
    private const val ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
    private val random = SecureRandom()

    /** A fresh page id (10 chars, [a-z0-9]), as core's newPageId. */
    fun newPageId(): String = buildString { repeat(10) { append(ID_CHARS[random.nextInt(ID_CHARS.length)]) } }

    /** core's blankHtml. */
    fun blankHtml(title: String): String {
        val t = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>$t</title></head><body>\n<h1>$t</h1>\n<p><br></p>\n</body></html>\n"
    }
}

/** Create an HTML page at `path`; its parent folder must exist and not be a page. */
fun VaultStore.createPage(path: String): VaultNode {
    val norm = VaultStore.normPath(path)
    if (norm.isEmpty()) throw VaultEditError.EmptyName()
    val dir = pathDir(norm)
    if (dir.exists()) throw VaultEditError.Exists(norm)
    val parent = norm.split('/').dropLast(1).joinToString("/")
    if (parent.isNotEmpty()) {
        val pdir = pathDir(parent)
        if (!pdir.exists()) throw VaultEditError.NoFolder(parent)
        if (isPageDir(pdir)) throw VaultEditError.ParentIsPage(parent)
    }
    val title = norm.substringAfterLast('/')
    if (!dir.mkdir()) throw java.io.IOException("Could not create $norm")
    // JSON.stringify({id, entry}, null, 2) + "\n", byte for byte.
    val manifest = "{\n  \"id\": \"${VaultEdit.newPageId()}\",\n  \"entry\": \"index.html\"\n}\n"
    File(dir, VaultStore.MANIFEST).writeText(manifest)
    onWrite?.invoke("$norm/${VaultStore.MANIFEST}")
    File(dir, "index.html").writeText(VaultEdit.blankHtml(title))
    onWrite?.invoke("$norm/index.html")
    return findPage(norm)
}

/**
 * Move a page or folder to `<vault>/.trash/<name>` (numbered when the name is taken).
 * Refused while an agent holds a lock on the page or on any page under the folder.
 * Returns the vault paths of the files that went (each also reported to [VaultStore.onWrite]).
 */
fun VaultStore.trash(path: String): List<String> {
    val norm = VaultStore.normPath(path)
    if (norm.isEmpty()) throw VaultEditError.NotFound(path)
    val src = pathDir(norm)
    if (!src.exists()) throw VaultEditError.NotFound(norm)
    if (isPageDir(src) && lock(readManifest(src)?.str("id")) != null) throw VaultEditError.Locked()
    val under = listTree().walked().firstOrNull { it.path == norm && it.kind == VaultNode.Kind.FOLDER }?.children
    if (under != null && under.walked().any { it.isLocked }) throw VaultEditError.Locked()
    val trash = File(root, ".trash")
    trash.mkdirs()
    val name = src.name
    var dest = File(trash, name)
    var n = 2
    while (dest.exists()) {
        dest = File(trash, "$name $n")
        n += 1
    }
    val files = src.walkTopDown()
        .filter { it.isFile }
        .map { "$norm/${it.relativeTo(src).invariantSeparatorsPath}" }
        .toList()
    Files.move(src.toPath(), dest.toPath())
    val hook = onWrite
    if (hook != null) files.forEach(hook)
    return files
}
