package org.harborapps.quire.bridge

import org.harborapps.quire.app.QuireApp
import java.io.File
import java.io.IOException

/**
 * The local-change journal: which vault files the phone has written since the last push.
 * Port of ios/Quire/Bridge/VaultChanges.swift.
 *
 * - [markChanged] — call after writing a file. `path` is vault-relative with "/" separators,
 *   the file itself: "Welcome/index.html", "Habits/.noteblock", "Habits/data/pixel-8.sqlite".
 * - [changedPaths] — a sorted snapshot of everything marked since the last [clear].
 * - [clear] — forget it all (sync calls this after a successful push).
 *
 * Persists in [QuireApp.prefs] under "quire.vaultChanges" (a string set), so a change made just
 * before the app was killed is still pushed on the next launch. Thread-safe.
 */
object VaultChanges {
    private const val KEY = "quire.vaultChanges"
    private val lock = Any()
    private var loaded: MutableSet<String>? = null

    private fun paths(): MutableSet<String> =
        loaded ?: (QuireApp.prefs.getStringSet(KEY, null)?.toMutableSet() ?: mutableSetOf()).also { loaded = it }

    fun markChanged(path: String) {
        val p = path.split("/").filter { it.isNotEmpty() }.joinToString("/")
        if (p.isEmpty()) return
        synchronized(lock) {
            val set = paths()
            if (set.add(p)) QuireApp.prefs.edit().putStringSet(KEY, HashSet(set)).apply()
        }
    }

    val changedPaths: List<String>
        get() = synchronized(lock) { paths().sorted() }

    fun clear() {
        synchronized(lock) {
            loaded = mutableSetOf()
            QuireApp.prefs.edit().remove(KEY).apply()
        }
    }
}

/**
 * Atomic file writes for the bridge: write a temp file next to the target, then rename, so a
 * crash mid-save never leaves half a page.
 */
object AtomicFile {
    @Throws(IOException::class)
    fun write(text: String, file: File) {
        val dir = file.absoluteFile.parentFile ?: throw IOException("No parent for ${file.path}")
        val tmp = File(dir, ".${file.name}.${System.nanoTime()}.tmp")
        try {
            tmp.outputStream().use { out ->
                out.write(text.toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            if (!tmp.renameTo(file)) throw IOException("Could not replace ${file.path}")
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }
}
