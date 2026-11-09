package org.harborapps.quire.quicknote

import org.harborapps.quire.bridge.AtomicFile
import org.harborapps.quire.bridge.VaultChanges
import org.harborapps.quire.vault.VaultEditError
import org.harborapps.quire.vault.VaultModel
import org.harborapps.quire.vault.VaultNode
import org.harborapps.quire.vault.VaultStore
import org.harborapps.quire.vault.createPage
import java.io.File

/**
 * The page the quick note opens: `Floating note` in the vault root, created when missing
 * (port of app/main/floating-page.mjs resolveFloatingPage with no page picked), and the share
 * target's append. Blocking file IO: call off the main thread.
 */
object FloatingNote {
    const val DEFAULT = "Floating note"

    /** The `Floating note` page, created (blank HTML) the first time. */
    fun resolve(store: VaultStore): VaultNode {
        val found = runCatching { store.findPage(DEFAULT) }.getOrNull()
        if (found != null) return found
        val created = store.createPage(DEFAULT)
        VaultModel.refresh()
        return created
    }

    /**
     * Append [text] to the note: one `<p>` per non-blank line, right before `</body>` of the raw
     * entry file (at the end when there is none); a markdown page gets plain paragraphs.
     * Throws when the page is locked (an agent is editing it on the Mac).
     */
    fun append(store: VaultStore, text: String): VaultNode {
        val page = resolve(store)
        if (page.isLocked) throw VaultEditError.Locked()
        val lines = text.split(Regex("\r\n|\r|\n")).map { it.trim() }.filter { it.isNotEmpty() }
        if (lines.isEmpty()) return page
        val file = File(page.dir, page.entry)
        val raw = if (file.isFile) file.readText() else ""
        val out = if (page.isMarkdown || page.entry.lowercase().endsWith(".md")) {
            val body = lines.joinToString("\n\n")
            val base = raw.trimEnd()
            (if (base.isEmpty()) "" else "$base\n\n") + body + "\n"
        } else {
            val paras = lines.joinToString("") { "<p>${escape(it)}</p>\n" }
            val at = raw.lastIndexOf("</body>", ignoreCase = true)
            if (at >= 0) raw.substring(0, at) + paras + raw.substring(at)
            else (if (raw.isEmpty() || raw.endsWith("\n")) raw else "$raw\n") + paras
        }
        AtomicFile.write(out, file)
        VaultChanges.markChanged("${page.path}/${page.entry}")
        return store.findPage(page.path)
    }

    private fun escape(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\"", "&quot;").replace("'", "&#39;")
}
