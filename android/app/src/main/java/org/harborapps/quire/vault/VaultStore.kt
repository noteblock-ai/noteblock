package org.harborapps.quire.vault

import android.content.res.AssetManager
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.text.Collator
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import org.harborapps.quire.app.QuireApp

/** Read errors (iOS VaultError). */
sealed class VaultError(message: String) : Exception(message) {
    class NoPage(val ref: String) : VaultError("No page: $ref")
    class BadPath(val path: String) : VaultError("Bad path: $path")
    class SeedMissing : VaultError("The starter vault is missing from the app")
}

/**
 * The vault on disk: a folder in [VaultPaths.vaultsDir]. Port of ios/Quire/Vault/VaultStore.swift,
 * which mirrors core/pages.mjs (listTree, findPage, entryFile, readManifest) and the lock/snapshot
 * reads of core/lock.mjs. Only reads and plain file I/O, no state beyond [root] (and the [onWrite]
 * hook), so it is safe to use from any thread (WebView request threads call it).
 */
class VaultStore(root: File) {
    val root: File = root.absoluteFile.normalize()

    /**
     * Called with each vault-relative file path written or removed by the edit operations
     * ([createPage], [trash]). Wired to the change journal by another layer.
     */
    @Volatile
    var onWrite: ((String) -> Unit)? = null

    /** vault.json "name", else the folder name. */
    val name: String
        get() {
            val obj = readJsonObject(VaultPaths.metaFile(root, "vault.json"))
            val n = obj?.str("name")
            return if (!n.isNullOrEmpty()) n else root.name
        }

    // MARK: - Paths

    /** Absolute folder of a vault path. Throws [VaultError.BadPath]. */
    fun pathDir(p: String): File {
        val norm = normPath(p)
        if (norm.isEmpty()) return root
        return norm.split('/').fold(root) { acc, seg -> File(acc, seg) }
    }

    /**
     * True when `dir` holds a `.noteblock` (or legacy `.quire`) FILE; the vault's own metadata
     * folder of the same name is a directory.
     */
    fun isPageDir(dir: File): Boolean = VaultPaths.manifestFile(dir) != null

    /** The page's manifest (`.noteblock`, else `.quire`) as a JSON object, or null when missing / not an object. */
    fun readManifest(dir: File): JsonObject? = VaultPaths.manifestFile(dir)?.let(::readJsonObject)

    /**
     * manifest.entry when that file exists, else index.html, else index.md, else the named
     * entry (or index.html).
     */
    fun entryFile(dir: File, manifest: JsonObject?): String {
        val named = manifest?.str("entry")?.takeIf { !it.contains("..") }
        if (named != null && File(dir, named).exists()) return named
        for (f in ENTRIES) if (File(dir, f).exists()) return f
        return named ?: "index.html"
    }

    // MARK: - Locks

    fun lock(id: String?): VaultNode.Lock? {
        if (id.isNullOrEmpty()) return null
        val obj = readJsonObject(VaultPaths.metaFile(root, "locks/$id.json")) ?: return null
        return VaultNode.Lock(
            id = obj.str("id") ?: id,
            path = obj.str("path"),
            by = obj.str("by"),
            message = obj.str("message"),
            startedAt = obj.str("startedAt"),
        )
    }

    fun snapshotDir(id: String): File = VaultPaths.metaFile(root, "snapshots/$id")

    // MARK: - Tree

    /** Folders first, then pages and plain files together, each by name (numeric-aware). */
    fun listTree(): List<VaultNode> = readChildren(root, "")

    /** Every page in tree order. */
    fun allPages(): List<VaultNode> = listTree().walked().filter { it.isPage }

    /** ref = page path or page id. Throws [VaultError.NoPage]. */
    fun findPage(ref: String): VaultNode {
        if (ref.isEmpty()) throw VaultError.NoPage(ref)
        val norm = runCatching { normPath(ref) }.getOrNull()
        if (!norm.isNullOrEmpty()) {
            val dir = runCatching { pathDir(norm) }.getOrNull()
            if (dir != null && isPageDir(dir)) return pageNode(dir, norm)
        }
        allPages().firstOrNull { it.pageId == ref }?.let { return it }
        throw VaultError.NoPage(ref)
    }

    fun pageNode(dir: File, path: String): VaultNode {
        val m = readManifest(dir) ?: JsonObject(emptyMap())
        val id = m.str("id")
        val entry = entryFile(dir, m)
        val name = path.substringAfterLast('/')
        val title = m.str("title")?.takeIf { it.isNotEmpty() } ?: name
        val source = m.str("source")?.takeIf { !it.contains("..") }
        val build = m.str("build")?.trim()?.takeIf { it.isNotEmpty() }
        val renderer = m.str("renderer")?.takeIf { it in RENDERERS } ?: "quire"
        val embedHeight = (m["embed"] as? JsonObject)?.num("height")?.takeIf { it > 0 }?.let { roundHalfAway(it) }
        val format = if (File(dir, entry).exists()) {
            if (entry.lowercase(Locale.ROOT).endsWith(".md")) VaultNode.Format.MD else VaultNode.Format.HTML
        } else VaultNode.Format.NONE
        return VaultNode(
            kind = VaultNode.Kind.PAGE, pageId = id, title = title, path = path, dir = dir, entry = entry,
            source = source, build = build, renderer = renderer, embedHeight = embedHeight,
            backend = parseBackend(m["backend"]), format = format, children = emptyList(), lock = lock(id),
        )
    }

    private fun readChildren(dir: File, parentPath: String): List<VaultNode> {
        val files = dir.listFiles() ?: return emptyList()
        val folders = mutableListOf<VaultNode>()
        val items = mutableListOf<VaultNode>()
        for (f in files) {
            val name = f.name
            if (name.startsWith(".") || name in SKIP_NAMES) continue
            val p = if (parentPath.isEmpty()) name else "$parentPath/$name"
            val path = f.toPath()
            // Like URL.resourceValues on iOS: a symlink is neither a regular file nor a directory.
            if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                items += VaultNode(kind = VaultNode.Kind.FILE, title = name, path = p, dir = dir)
                continue
            }
            if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) continue
            if (isPageDir(f)) {
                items += pageNode(f, p)
            } else {
                folders += VaultNode(
                    kind = VaultNode.Kind.FOLDER, title = name, path = p, dir = f,
                    children = readChildren(f, p),
                )
            }
        }
        val byName = Comparator<VaultNode> { a, b -> standardCompare(a.name, b.name) }
        return folders.sortedWith(byName) + items.sortedWith(byName)
    }

    companion object {
        const val MANIFEST = VaultPaths.MANIFEST
        private val ENTRIES = listOf("index.html", "index.md")
        private val RENDERERS = setOf("quire", "view", "source")
        private val SKIP_NAMES = setOf("node_modules", "data")
        private val PROC_NAME = Regex("^[a-z][a-z0-9_-]{0,31}$", RegexOption.IGNORE_CASE)
        private const val SEED_ASSET = "Seed/My First Vault"
        const val DEFAULT_VAULT_NAME = "My First Vault"

        private val json = Json { ignoreUnknownKeys = true }
        private val COLLATOR = ThreadLocal.withInitial { Collator.getInstance().apply { strength = Collator.SECONDARY } }

        // MARK: - Opening / seeding

        /**
         * The current vault: the folder named in prefs, else the first vault folder, else a new
         * "My First Vault" seeded from the APK's assets/Seed/My First Vault.
         */
        fun openDefault(): VaultStore {
            val parent = VaultPaths.vaultsDir
            val prefs = QuireApp.prefs
            fun isVault(f: File) = VaultPaths.isVault(f)
            prefs.getString(VaultPaths.CURRENT_KEY, null)?.let { name ->
                val f = File(parent, name)
                if (name.isNotEmpty() && isVault(f)) return VaultStore(f)
            }
            val first = (parent.listFiles() ?: emptyArray())
                .filter { !it.name.startsWith(".") && it.isDirectory && isVault(it) }
                .sortedWith { a, b -> standardCompare(a.name, b.name) }
                .firstOrNull()
            if (first != null) {
                prefs.edit().putString(VaultPaths.CURRENT_KEY, first.name).apply()
                return VaultStore(first)
            }
            val store = seed(DEFAULT_VAULT_NAME, parent)
            prefs.edit().putString(VaultPaths.CURRENT_KEY, store.root.name).apply()
            return store
        }

        /**
         * Copy the bundled starter vault into `parent/<name>` and add what core's createVault
         * writes (.noteblock/vault.json, .gitignore). No git here; sync owns that.
         */
        fun seed(name: String, parent: File, assets: AssetManager = QuireApp.context.assets): VaultStore {
            val dest = File(parent, name)
            if (!dest.exists()) {
                val top = try { assets.list(SEED_ASSET) } catch (_: IOException) { null }
                if (top.isNullOrEmpty()) throw VaultError.SeedMissing()
                copyAsset(assets, SEED_ASSET, dest)
            }
            // An older seed may still carry .quire/vault.json; only write when neither exists.
            val vaultJson = VaultPaths.metaFile(dest, "vault.json")
            if (!vaultJson.exists()) {
                vaultJson.parentFile?.mkdirs()
                // JSON.stringify({name, version: 2}, null, 2) + "\n" (core/vault.mjs).
                vaultJson.writeText("{\n  \"name\": ${jsonString(name)},\n  \"version\": 2\n}\n")
            }
            val gi = File(dest, ".gitignore")
            if (!gi.exists()) gi.writeText(VaultPaths.GITIGNORE)
            return VaultStore(dest)
        }

        /** Asset dirs list their children; files list nothing and open. */
        private fun copyAsset(assets: AssetManager, path: String, dest: File) {
            val children = assets.list(path)
            if (!children.isNullOrEmpty()) {
                dest.mkdirs()
                for (c in children) copyAsset(assets, "$path/$c", File(dest, c))
                return
            }
            try {
                assets.open(path).use { input ->
                    dest.parentFile?.mkdirs()
                    dest.outputStream().use { input.copyTo(it) }
                }
            } catch (_: FileNotFoundException) {
                dest.mkdirs() // an empty asset dir
            }
        }

        // MARK: - Paths

        /** Trim slashes; reject ".", ".." and hidden segments (core's normPath). */
        fun normPath(p: String): String {
            val segs = p.split('/').map { trimSpaces(it) }.filter { it.isNotEmpty() }
            for (s in segs) if (s == "." || s == ".." || s.startsWith(".")) throw VaultError.BadPath(p)
            return segs.joinToString("/")
        }

        /** core's parseBackend: {dir, run: string | {name: cmd}, proxy}. */
        fun parseBackend(raw: JsonElement?): VaultNode.Backend? {
            val b = raw as? JsonObject ?: return null
            var dir = "backend"
            val d = b.str("dir")?.let { trimSpaces(it) }
            if (!d.isNullOrEmpty() &&
                d.split('/').filter { it.isNotEmpty() }.none { it == ".." || it.startsWith(".") }
            ) {
                dir = d.trim('/')
            }
            val run = LinkedHashMap<String, String>()
            val runStr = b.str("run")?.trim()
            val runObj = b["run"] as? JsonObject
            if (!runStr.isNullOrEmpty()) {
                run["main"] = runStr
            } else if (runObj != null) {
                for ((name, cmd) in runObj) {
                    if (!PROC_NAME.matches(name)) continue
                    val c = (cmd as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()
                    if (c.isNullOrEmpty()) continue
                    run[name] = c
                }
            }
            val p = b.str("proxy")
            val proxy = when {
                p != null && run.containsKey(p) -> p
                run.containsKey("api") -> "api"
                else -> run.keys.sorted().firstOrNull()
            }
            return VaultNode.Backend(dir = dir, run = run, proxy = proxy)
        }

        // MARK: - Helpers

        /** Read a file as a JSON object, or null when missing / unparsable / not an object. */
        fun readJsonObject(file: File): JsonObject? = try {
            json.parseToJsonElement(file.readText()) as? JsonObject
        } catch (_: Exception) {
            null
        }

        /** A JSON string (escaped, quoted), as JSON.stringify writes it. */
        fun jsonString(s: String): String = JsonPrimitive(s).toString()

        /**
         * Approximation of Foundation's localizedStandardCompare (and core's
         * Intl.Collator numeric/base): case-insensitive natural order, digit runs by value.
         */
        fun standardCompare(a: String, b: String): Int {
            val collator = COLLATOR.get()!!
            var i = 0
            var j = 0
            while (i < a.length && j < b.length) {
                val aDigit = a[i].isDigit()
                val bDigit = b[j].isDigit()
                val ei = runEnd(a, i, aDigit)
                val ej = runEnd(b, j, bDigit)
                val ca = a.substring(i, ei)
                val cb = b.substring(j, ej)
                val c = if (aDigit && bDigit) {
                    val na = ca.trimStart('0')
                    val nb = cb.trimStart('0')
                    if (na.length != nb.length) na.length.compareTo(nb.length) else na.compareTo(nb)
                } else {
                    collator.compare(ca, cb)
                }
                if (c != 0) return c
                i = ei
                j = ej
            }
            val rest = (a.length - i).compareTo(b.length - j)
            if (rest != 0) return rest
            return collator.compare(a, b).takeIf { it != 0 } ?: a.compareTo(b)
        }

        private fun runEnd(s: String, start: Int, digits: Boolean): Int {
            var k = start
            while (k < s.length && s[k].isDigit() == digits) k++
            return k
        }

        /** Swift's CharacterSet.whitespaces: tab plus Unicode space separators (no newlines). */
        private fun trimSpaces(s: String): String =
            s.trim { it == '\t' || Character.getType(it) == Character.SPACE_SEPARATOR.toInt() }

        /** Swift's Double.rounded() (to nearest, ties away from zero). */
        private fun roundHalfAway(d: Double): Int =
            if (d >= 0) Math.floor(d + 0.5).toInt() else -Math.floor(-d + 0.5).toInt()
    }
}

// MARK: - Small JSON field helpers

/** A string field (only JSON strings, like Swift's `as? String`). */
fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A numeric field (only JSON numbers). */
fun JsonObject.num(key: String): Double? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

/** An integer field (a JSON number, rounded toward zero). */
fun JsonObject.int(key: String): Int? = num(key)?.toInt()
