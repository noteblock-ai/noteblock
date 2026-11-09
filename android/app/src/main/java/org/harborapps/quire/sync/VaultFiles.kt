package org.harborapps.quire.sync

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFileAttributes
import java.nio.file.attribute.PosixFilePermission
import java.security.MessageDigest
import java.time.LocalDateTime
import java.util.concurrent.TimeUnit
import org.harborapps.quire.vault.VaultPaths

object GitBlob {
    private fun hex(d: ByteArray): String {
        val sb = StringBuilder(d.size * 2)
        for (b in d) sb.append("%02x".format(b.toInt() and 0xff))
        return sb.toString()
    }

    /** git's blob id: sha1("blob <len>\0" + content), lowercase hex. */
    fun sha(data: ByteArray): String {
        val h = MessageDigest.getInstance("SHA-1")
        h.update("blob ${data.size}\u0000".toByteArray(Charsets.UTF_8))
        h.update(data)
        return hex(h.digest())
    }

    /** Same as sha(bytes) but streams the file. Swift: `sha(fileAt:)`. */
    fun sha(file: File): String {
        val h = MessageDigest.getInstance("SHA-1")
        file.inputStream().use { input ->
            val len = file.length()
            h.update("blob $len\u0000".toByteArray(Charsets.UTF_8))
            val buf = ByteArray(1 shl 16)
            var total = 0L
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                h.update(buf, 0, n)
                total += n
            }
            // The file changed size while reading: hash what was actually read.
            if (total != len) return sha(file.readBytes())
        }
        return hex(h.digest())
    }
}

/**
 * Darwin fnmatch(3) for the patterns .gitignore uses: `*`, `?`, `[...]` (with `!`/`^` and
 * ranges) and backslash escapes. With `pathname` (FNM_PATHNAME) wildcards never match "/".
 */
internal object FnMatch {
    fun matches(pattern: String, s: String, pathname: Boolean): Boolean = match(pattern, 0, s, 0, pathname)

    private fun match(p: String, pi0: Int, s: String, si0: Int, pathname: Boolean): Boolean {
        var pi = pi0
        var si = si0
        while (pi < p.length) {
            when (val c = p[pi]) {
                '?' -> {
                    if (si >= s.length || (pathname && s[si] == '/')) return false
                    pi++; si++
                }
                '*' -> {
                    while (pi < p.length && p[pi] == '*') pi++
                    if (pi == p.length) return !pathname || s.indexOf('/', si) < 0
                    var k = si
                    while (true) {
                        if (match(p, pi, s, k, pathname)) return true
                        if (k >= s.length) return false
                        if (pathname && s[k] == '/') return false
                        k++
                    }
                }
                '[' -> {
                    if (si >= s.length) return false
                    val ch = s[si]
                    val r = bracket(p, pi + 1, ch)
                    if (r == null) {
                        // Unterminated: "[" is literal.
                        if (ch != '[') return false
                        pi++; si++
                    } else {
                        if (pathname && ch == '/') return false
                        if (!r.first) return false
                        pi = r.second; si++
                    }
                }
                '\\' -> {
                    val lit = if (pi + 1 < p.length) p[++pi] else '\\'
                    if (si >= s.length || s[si] != lit) return false
                    pi++; si++
                }
                else -> {
                    if (si >= s.length || s[si] != c) return false
                    pi++; si++
                }
            }
        }
        return si == s.length
    }

    /** (matched, index after "]"), or null when the bracket never closes. */
    private fun bracket(p: String, start: Int, ch: Char): Pair<Boolean, Int>? {
        var i = start
        var negate = false
        if (i < p.length && (p[i] == '!' || p[i] == '^')) { negate = true; i++ }
        var ok = false
        var first = true
        while (true) {
            if (i >= p.length) return null
            var c = p[i]
            if (c == ']' && !first) { i++; break }
            first = false
            if (c == '\\' && i + 1 < p.length) c = p[++i]
            i++
            if (i + 1 < p.length && p[i] == '-' && p[i + 1] != ']') {
                var hi = p[i + 1]
                i += 2
                if (hi == '\\' && i < p.length) hi = p[i++]
                if (ch in c..hi) ok = true
            } else if (ch == c) {
                ok = true
            }
        }
        return (ok != negate) to i
    }
}

/** The vault's .gitignore, plus what sync never carries no matter what it says. */
class IgnoreRules(text: String) {
    private data class Rule(
        val pattern: String,
        val negate: Boolean,
        val dirOnly: Boolean,
        val anchored: Boolean,
    )

    private val rules: List<Rule> = parse(text)

    /** Reads `<root>/.gitignore`, or the default vault .gitignore when there is none. */
    constructor(root: File) : this(
        try {
            File(root, ".gitignore").readText(Charsets.UTF_8)
        } catch (_: Exception) {
            VaultPaths.GITIGNORE
        },
    )

    companion object {
        /** Always skipped: git's own folder, page data, locks/snapshots, Finder and trash litter. */
        private val builtin: List<Rule> by lazy {
            parse(
                ".git/\ndata/\nnode_modules/\n" +
                    VaultPaths.META_DIRS.joinToString("") { "$it/snapshots/\n$it/locks/\n" } +
                    ".DS_Store\n.trash/\n.Trash/\n",
            )
        }

        private fun parse(text: String): List<Rule> =
            text.split(Regex("\r\n|\r|\n| | |\u0085|\u000B|\u000C")).filter { it.isNotEmpty() }.mapNotNull { raw ->
                var line = raw
                while (line.endsWith(" ") && !line.endsWith("\\ ")) line = line.dropLast(1)
                if (line.isEmpty() || line.startsWith("#")) return@mapNotNull null
                var negate = false
                if (line.startsWith("!")) { negate = true; line = line.drop(1) }
                if (line.startsWith("\\")) line = line.drop(1)
                var dirOnly = false
                if (line.endsWith("/")) { dirOnly = true; line = line.dropLast(1) }
                var anchored = line.contains("/")
                if (line.startsWith("/")) { line = line.drop(1); anchored = true }
                if (line.startsWith("**/")) { line = line.drop(3); anchored = line.contains("/") }
                if (line.isEmpty()) return@mapNotNull null
                Rule(line, negate, dirOnly, anchored)
            }

        private fun matches(rule: Rule, path: String, isDir: Boolean): Boolean {
            if (rule.dirOnly && !isDir) return false
            if (rule.anchored) {
                return FnMatch.matches(rule.pattern, path, pathname = !rule.pattern.contains("**"))
            }
            val base = path.split("/").lastOrNull { it.isNotEmpty() } ?: path
            return FnMatch.matches(rule.pattern, base, pathname = false)
        }
    }

    private fun matchOne(path: String, isDir: Boolean): Boolean {
        if (builtin.any { matches(it, path, isDir) }) return true
        var ignored = false
        for (r in rules) if (matches(r, path, isDir)) ignored = !r.negate
        return ignored
    }

    /** True when `path` (vault-relative) or any folder above it is ignored. */
    fun isIgnored(path: String, isDir: Boolean = false): Boolean {
        val comps = path.split("/").filter { it.isNotEmpty() }
        for (i in comps.indices) {
            val sub = comps.subList(0, i + 1).joinToString("/")
            val last = i == comps.size - 1
            if (matchOne(sub, if (last) isDir else true)) return true
        }
        return false
    }
}

/** Size, mtime (seconds since 1970, fractional) and owner-exec bit of a regular file. */
data class FileStat(
    val size: Long,
    val mtime: Double,
    val exec: Boolean,
)

object VaultFiles {
    /** A remote path we're willing to write: no "..", no ".git", nothing absolute. */
    fun safeRelative(p: String): String? {
        val comps = p.split("/")
        if (comps.isEmpty() || p.startsWith("/")) return null
        for (c in comps) if (c.isEmpty() || c == "." || c == "..") return null
        if (comps[0] == ".git") return null
        return comps.joinToString("/")
    }

    fun url(root: File, rel: String): File =
        rel.split("/").filter { it.isNotEmpty() }.fold(root) { acc, part -> File(acc, part) }

    /** Null unless `file` is a regular file (symlinks are not followed). */
    fun stat(file: File): FileStat? {
        val path = file.toPath()
        return try {
            val a = Files.readAttributes(path, PosixFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            if (!a.isRegularFile) return null
            FileStat(a.size(), a.lastModifiedTime().to(TimeUnit.NANOSECONDS) / 1e9, PosixFilePermission.OWNER_EXECUTE in a.permissions())
        } catch (_: UnsupportedOperationException) {
            try {
                val a = Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
                if (!a.isRegularFile) return null
                FileStat(a.size(), a.lastModifiedTime().to(TimeUnit.NANOSECONDS) / 1e9, file.canExecute())
            } catch (_: Exception) {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    /** Every regular, non-ignored file under `root`, vault-relative. */
    fun scan(root: File, rules: IgnoreRules): Map<String, FileStat> {
        val out = mutableMapOf<String, FileStat>()
        fun walk(dir: File, rel: String) {
            val names = dir.list() ?: return
            for (name in names) {
                val p = if (rel.isEmpty()) name else "$rel/$name"
                val u = File(dir, name)
                if (!u.exists()) continue
                val isDir = u.isDirectory
                if (rules.isIgnored(p, isDir)) continue
                if (isDir) {
                    // Don't follow symlinked folders.
                    if (Files.isSymbolicLink(u.toPath())) continue
                    walk(u, p)
                } else {
                    stat(u)?.let { out[p] = it }
                }
            }
        }
        walk(root, "")
        return out
    }

    /**
     * "a/index.html" → "a/index (conflict 2026-10-21 1403).html", never an existing file.
     * Same naming as app/main/sync.mjs conflictName.
     */
    fun conflictName(root: File, rel: String, `when`: LocalDateTime = LocalDateTime.now()): String {
        val comps = rel.split("/").filter { it.isNotEmpty() }
        val dir = comps.dropLast(1).joinToString("/")
        val base = comps.lastOrNull() ?: rel
        val dot = base.lastIndexOf('.')
        val (name, ext) = if (dot > 0) base.substring(0, dot) to base.substring(dot) else base to ""
        val stamp = "%04d-%02d-%02d %02d%02d".format(`when`.year, `when`.monthValue, `when`.dayOfMonth, `when`.hour, `when`.minute)
        var i = 1
        while (true) {
            val tag = "conflict $stamp${if (i > 1) " $i" else ""}"
            val out = (if (dir.isEmpty()) "" else "$dir/") + "$name ($tag)$ext"
            if (!url(root, out).exists()) return out
            i++
        }
    }

    /** Remove empty folders from `rel`'s parent up to (not including) the root. */
    fun pruneEmptyParents(root: File, rel: String) {
        val comps = rel.split("/").filter { it.isNotEmpty() }.toMutableList()
        if (comps.isEmpty()) return
        comps.removeAt(comps.size - 1)
        while (comps.isNotEmpty()) {
            val u = url(root, comps.joinToString("/"))
            val items = u.list() ?: return
            if (!items.all { it == ".DS_Store" }) return
            u.deleteRecursively()
            comps.removeAt(comps.size - 1)
        }
    }
}
