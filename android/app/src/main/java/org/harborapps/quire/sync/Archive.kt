package org.harborapps.quire.sync

import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.util.zip.GZIPInputStream
import java.util.zip.ZipException

/**
 * gunzip for GitHub's tarball. The Swift parses the gzip header by hand; here GZIPInputStream
 * does it, after the same magic/method check (so a non-gzip download gets the same message).
 */
object Gzip {
    /** Throws the Swift's "isn't a gzip file" error unless `head` starts 1f 8b 08. */
    fun checkHeader(head: ByteArray, count: Int = head.size) {
        if (count < 10 || head[0] != 0x1f.toByte() || head[1] != 0x8b.toByte() || head[2] != 8.toByte()) {
            throw SyncException.Message("The download from GitHub isn't a gzip file.")
        }
    }

    /** A decompressing stream over `src`, after the header check. The caller closes it. */
    fun open(src: File): InputStream {
        val input = BufferedInputStream(FileInputStream(src), 1 shl 16)
        try {
            input.mark(16)
            val head = ByteArray(10)
            var n = 0
            while (n < 10) {
                val r = input.read(head, n, 10 - n)
                if (r < 0) break
                n += r
            }
            checkHeader(head, n)
            input.reset()
            return GZIPInputStream(input, 1 shl 16)
        } catch (e: ZipException) {
            input.close()
            throw SyncException.Message("Bad gzip header.")
        } catch (e: Throwable) {
            input.close()
            throw e
        }
    }

    fun decompress(src: File, dest: File) {
        open(src).use { input -> dest.outputStream().use { input.copyTo(it, 1 shl 20) } }
    }

    fun decompress(data: ByteArray): ByteArray {
        checkHeader(data)
        return try {
            GZIPInputStream(ByteArrayInputStream(data)).use { it.readBytes() }
        } catch (e: ZipException) {
            throw SyncException.Message("Bad gzip header.")
        }
    }
}

/** A minimal ustar reader with pax (`x`, `g`) and GNU long-name (`L`) headers. */
class TarReader(private val readBytes: (Int) -> ByteArray) {
    data class Entry(
        val path: String,
        /** '0' file, '5' dir, '2' symlink, … (the raw typeflag byte, 0..255) */
        val type: Int,
        val size: Long,
        val mode: Int,
    ) {
        val isFile: Boolean get() = type == '0'.code || type == 0 || type == '7'.code
        val isDir: Boolean get() = type == '5'.code
    }

    private var pending = 0L
    private var current: Entry? = null

    /** The global pax `comment`; `git archive` puts the commit sha there. */
    var globalComment: String? = null
        private set

    constructor(input: InputStream) : this({ n ->
        val buf = ByteArray(n)
        val r = input.read(buf, 0, n)
        when {
            r <= 0 -> ByteArray(0)
            r == n -> buf
            else -> buf.copyOf(r)
        }
    })

    constructor(data: ByteArray) : this(ByteArrayInputStream(data))

    private fun readExact(n: Int): ByteArray {
        val out = ByteArrayOutputStream(n)
        while (out.size() < n) {
            val chunk = readBytes(n - out.size())
            if (chunk.isEmpty()) break
            out.write(chunk)
        }
        return out.toByteArray()
    }

    private fun skip(n: Long) {
        var left = n
        while (left > 0) {
            val chunk = readExact(minOf(left, 1L shl 20).toInt())
            if (chunk.isEmpty()) return
            left -= chunk.size
        }
    }

    companion object {
        private fun padded(n: Long): Long = (n + 511) / 512 * 512

        private fun string(b: ByteArray, from: Int, len: Int): String {
            var end = from
            while (end < from + len && b[end] != 0.toByte()) end++
            return String(b, from, end - from, Charsets.UTF_8)
        }

        private fun number(b: ByteArray, from: Int, len: Int): Long {
            if (b[from].toInt() and 0x80 != 0) { // base-256
                var n = (b[from].toInt() and 0x7f).toLong()
                for (i in from + 1 until from + len) n = (n shl 8) or (b[i].toLong() and 0xff)
                return n
            }
            val s = string(b, from, len).trim(' ')
            return s.toLongOrNull(8) ?: 0
        }

        /** "len key=value\n" records. */
        fun parsePax(d: ByteArray): Map<String, String> {
            val out = mutableMapOf<String, String>()
            var i = 0
            while (i < d.size) {
                var sp = i
                while (sp < d.size && d[sp] != 0x20.toByte()) sp++
                if (sp >= d.size) break
                val len = String(d, i, sp - i, Charsets.UTF_8).toIntOrNull() ?: break
                if (len <= 0 || i + len > d.size) break
                val recStart = sp + 1
                val recEnd = i + len - 1 // drop the trailing \n
                if (recEnd > recStart) {
                    var eq = recStart
                    while (eq < recEnd && d[eq] != '='.code.toByte()) eq++
                    if (eq < recEnd) {
                        out[String(d, recStart, eq - recStart, Charsets.UTF_8)] =
                            String(d, eq + 1, recEnd - eq - 1, Charsets.UTF_8)
                    }
                }
                i += len
            }
            return out
        }
    }

    /** The next file, folder or link; null at the end of the archive. */
    fun next(): Entry? {
        if (pending > 0) { skip(pending); pending = 0 }
        current = null
        val pax = mutableMapOf<String, String>()
        var longName: String? = null
        while (true) {
            val block = readExact(512)
            if (block.size < 512 || block.all { it == 0.toByte() }) return null
            val type = block[156].toInt() and 0xff
            var size = number(block, 124, 12)
            if (type == 'x'.code || type == 'g'.code || type == 'L'.code) {
                val body = readExact(size.toInt())
                skip(padded(size) - size)
                when (type) {
                    'x'.code -> pax.putAll(parsePax(body))
                    'g'.code -> globalComment = parsePax(body)["comment"] ?: globalComment
                    else -> {
                        val end = body.indexOfFirst { it == 0.toByte() }.let { if (it < 0) body.size else it }
                        longName = String(body, 0, end, Charsets.UTF_8)
                    }
                }
                continue
            }
            var path = string(block, 0, 100)
            if (string(block, 257, 5) == "ustar") {
                val prefix = string(block, 345, 155)
                if (prefix.isNotEmpty()) path = "$prefix/$path"
            }
            longName?.let { path = it }
            pax["path"]?.let { path = it }
            pax["size"]?.toLongOrNull()?.let { size = it }
            val entry = Entry(path, type, size, number(block, 100, 8).toInt())
            current = entry
            pending = padded(size)
            return entry
        }
    }

    /** Stream the current entry's content. */
    fun readBody(chunk: (ByteArray) -> Unit) {
        val e = current ?: return
        var left = e.size
        while (left > 0) {
            val d = readExact(minOf(left, 1L shl 20).toInt())
            if (d.isEmpty()) break
            chunk(d)
            left -= d.size
        }
        skip(padded(e.size) - e.size)
        pending = 0
    }

    fun readBody(): ByteArray {
        val out = ByteArrayOutputStream()
        readBody { out.write(it) }
        return out.toByteArray()
    }
}

object Archive {
    data class Extracted(
        /** vault-relative path → executable bit */
        val files: Map<String, Boolean>,
        /** The commit sha from the tarball's pax header, when present. */
        val commit: String?,
    )

    private val PERM_EXEC = PosixFilePermissions.fromString("rwxr-xr-x")
    private val PERM_FILE = PosixFilePermissions.fromString("rw-r--r--")

    /** Unpack GitHub's `<owner>-<repo>-<sha>/…` tarball into `dest`, dropping that top folder. */
    fun extractTarball(tgz: File, into: File, progress: (Int) -> Unit = {}): Extracted {
        val dest = into
        val files = mutableMapOf<String, Boolean>()
        var globalComment: String?
        try {
            Gzip.open(tgz).use { gz ->
                val reader = TarReader(gz)
                dest.mkdirs()
                while (true) {
                    val e = reader.next() ?: break
                    val comps = e.path.split("/").filter { it.isNotEmpty() }.drop(1)
                    if (comps.isEmpty()) continue
                    val rel = VaultFiles.safeRelative(comps.joinToString("/")) ?: continue
                    val file = VaultFiles.url(dest, rel)
                    if (e.isDir) {
                        file.mkdirs()
                        continue
                    }
                    if (!e.isFile) continue
                    file.parentFile?.mkdirs()
                    file.outputStream().use { out -> reader.readBody { out.write(it) } }
                    val exec = e.mode and 0b001_000_000 != 0 // 0o100
                    try {
                        Files.setPosixFilePermissions(file.toPath(), if (exec) PERM_EXEC else PERM_FILE)
                    } catch (_: Exception) {
                        file.setExecutable(exec, true)
                    }
                    files[rel] = exec
                    if (files.size % 250 == 0) progress(files.size)
                }
                globalComment = reader.globalComment
            }
        } catch (e: ZipException) {
            throw SyncException.Message("The download from GitHub is damaged. Try again.")
        } catch (e: EOFException) {
            throw SyncException.Message("The download from GitHub is damaged. Try again.")
        }
        val c = globalComment?.trim()
        val commit = c?.takeIf { Regex("^[0-9a-f]{40}$").matches(it) }
        return Extracted(files, commit)
    }
}
