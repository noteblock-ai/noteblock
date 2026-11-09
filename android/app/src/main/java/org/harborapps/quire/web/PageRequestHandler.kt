package org.harborapps.quire.web

import android.content.res.AssetManager
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.concurrent.ConcurrentHashMap
import org.harborapps.quire.app.QuireApp
import org.harborapps.quire.host.HostJs
import org.harborapps.quire.vault.EditorPrefs
import org.harborapps.quire.vault.VaultPaths
import org.harborapps.quire.vault.VaultStore
import org.harborapps.quire.vault.str

/**
 * Serves a vault's pages to the System WebView from `WebViewClient.shouldInterceptRequest`.
 * Port of ios/Quire/Web/QuireSchemeHandler.swift, on an https origin we answer ourselves
 * (Chromium won't load ES modules, fetch() or fonts from a custom scheme):
 * - `https://quire.local/runtime/<file>`: the bundled app/runtime, from the APK assets
 *   (`runtime/…`, built by scripts/build-mobile-host.mjs --platform=android).
 * - `https://quire.local/vault/<page path>/`: the page's entry through transformEntry (host.js),
 *   plus a viewport, with the runtime's `quire://` urls rewritten to this origin. Other files
 *   under the page are served raw.
 * - A locked page is served from its snapshot; `data/`, the `.noteblock` / `.quire` manifest and the backend folder are never
 *   served; `/api/…` answers 503 (backends run on the Mac only).
 * `quire://vault/…` and `quire://runtime/…` (old pages' non-module subresources) resolve the same.
 */
class PageRequestHandler(val vault: VaultStore, val assets: AssetManager, @Volatile var hooks: Hooks = Hooks()) {
    data class Hooks(
        /** A page's entry was served (opening it, or an embed of it). Called on a WebView IO thread. */
        val onEntry: ((String) -> Unit)? = null,
        /** The editor settings JSON passed to transformEntry (`{"textSize":17}`). */
        val editorPrefs: () -> String? = { EditorPrefs.json() },
    )

    sealed class Result {
        data class NotFound(val status: Int, val text: String) : Result()
        /** A file in the APK assets (path relative to the assets root). */
        data class Asset(val path: String, val type: String) : Result()
        data class File(val file: java.io.File, val type: String) : Result()
        class Body(val bytes: ByteArray, val type: String) : Result()
    }

    private val types = ConcurrentHashMap<String, String>()

    // MARK: - Resolving

    fun resolve(url: Uri): Result {
        val scheme = url.scheme?.lowercase()
        val host = url.host?.lowercase()
        val path = url.encodedPath ?: "/"
        return when {
            scheme == "https" && host == HOST -> when {
                path == "/runtime" || path.startsWith("/runtime/") -> resolveRuntime(path.removePrefix("/runtime"))
                path == "/vault" || path.startsWith("/vault/") -> resolveVault(path.removePrefix("/vault"))
                path == "/api" || path.startsWith("/api/") -> Result.NotFound(503, "Page backends run on your Mac")
                else -> Result.NotFound(404, "Not found")
            }
            scheme == "quire" && host == "runtime" -> resolveRuntime(path)
            scheme == "quire" && host == "vault" -> resolveVault(path)
            else -> Result.NotFound(404, "Not a quire URL")
        }
    }

    private fun badSeg(s: String) = s == ".." || s == "." || s.contains('\u0000') || s.contains('\\')

    fun resolveRuntime(pathname: String): Result {
        val segs = decodeSegments(pathname)
        if (segs.isNullOrEmpty() || segs.any(::badSeg)) return Result.NotFound(404, "Not found")
        val rel = segs.joinToString("/")
        val assetPath = "$RUNTIME_ASSETS/$rel"
        val exists = try {
            assets.open(assetPath).close()
            true
        } catch (_: IOException) {
            false
        }
        if (!exists) return Result.NotFound(404, "Not found: $rel")
        return Result.Asset(assetPath, contentType(segs.last()))
    }

    fun resolveVault(pathname: String): Result {
        val segs = decodeSegments(pathname) ?: return Result.NotFound(404, "Bad path")
        if (segs.any(::badSeg)) return Result.NotFound(404, "Bad path")
        val root = vault.root

        // The page part: leading folders up to the first one holding a .noteblock (or .quire) file.
        var pageSegs: List<String>? = null
        var fileSegs: List<String> = emptyList()
        var dir = root
        for ((i, s) in segs.withIndex()) {
            if (s.isEmpty() || s.startsWith(".")) break
            dir = File(dir, s)
            if (vault.isPageDir(dir)) {
                pageSegs = segs.subList(0, i + 1)
                fileSegs = segs.subList(i + 1, segs.size)
                break
            }
        }
        if (pageSegs == null) {
            if (segs.firstOrNull() == "api") return Result.NotFound(503, "Page backends run on your Mac")
            // A plain file in a folder (not inside any page) is served as itself.
            if (segs.isNotEmpty() && segs.none { it.startsWith(".") }) {
                val loose = segs.fold(root) { f, s -> File(f, s) }
                if (loose.isFile && within(loose, root)) return Result.File(loose, contentType(loose.name))
            }
            return Result.NotFound(404, "No page: ${segs.joinToString("/")}")
        }
        val pagePath = pageSegs.joinToString("/")

        // Personal data is never served.
        if (fileSegs.firstOrNull() == "data") return Result.NotFound(404, "Not found")

        val manifest = vault.readManifest(dir)
        VaultStore.parseBackend(manifest?.get("backend"))?.let { backend ->
            val rel = fileSegs.joinToString("/")
            if (rel == backend.dir || rel.startsWith(backend.dir + "/")) return Result.NotFound(404, "Not found")
            if (backend.proxy != null && fileSegs.firstOrNull() == "api") {
                return Result.NotFound(503, "$pagePath has a backend, which runs on your Mac")
            }
        }
        val id = manifest?.str("id")
        val base = if (id != null && vault.lock(id) != null) vault.snapshotDir(id) else dir

        if (fileSegs.firstOrNull()?.let(VaultPaths::isManifestName) == true) return Result.NotFound(404, "Not found")
        val title = manifest?.str("title")?.takeIf { it.isNotEmpty() } ?: pageSegs.last()
        val entry = vault.entryFile(base, manifest)
        if (fileSegs.isEmpty() || fileSegs.joinToString("/") == entry) {
            val file = File(base, entry)
            val format = if (entry.lowercase().endsWith(".md")) "md" else "html"
            val src: String? = when {
                file.isFile -> try { file.readText() } catch (_: IOException) { null }
                fileSegs.isEmpty() -> "<!doctype html><html><head><meta charset=\"utf-8\"><title>${escAttr(title)}</title></head><body></body></html>"
                else -> null
            }
            if (src != null) {
                var baseHref: String? = null
                val slash = entry.lastIndexOf('/')
                if (slash >= 0) {
                    val entryDir = entry.substring(0, slash).split('/').filter { it.isNotEmpty() }
                    baseHref = "$ORIGIN/vault/" + (pageSegs + entryDir).joinToString("/") { encodeURIComponent(it) } + "/"
                }
                return try {
                    val html = HostJs.transformEntryBlocking(src, format, pagePath, title, baseHref, hooks.editorPrefs())
                    hooks.onEntry?.invoke(pagePath)
                    Result.Body(rewriteQuireUrls(addViewport(html)).toByteArray(Charsets.UTF_8), "text/html; charset=utf-8")
                } catch (e: Exception) {
                    Result.NotFound(500, "Could not render $pagePath: ${e.message ?: e.javaClass.simpleName}")
                }
            }
        }

        val file = fileSegs.fold(base) { f, s -> File(f, s) }
        if (!within(file, base)) return Result.NotFound(404, "Not found")
        if (!file.isFile) return Result.NotFound(404, "Not found: ${fileSegs.joinToString("/")}")
        return Result.File(file, contentType(file.name))
    }

    // MARK: - Responding

    /** The response for a request on an origin this handler owns, else null (let the WebView load it). */
    fun respond(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url ?: return null
        if (!owns(url)) return null
        if (request.method.equals("OPTIONS", ignoreCase = true)) {
            return response(204, "text/plain; charset=utf-8", ByteArrayInputStream(ByteArray(0)), 0)
        }
        return when (val r = resolve(url)) {
            is Result.NotFound -> text(r.status, r.text)
            is Result.Body -> response(200, r.type, ByteArrayInputStream(r.bytes), r.bytes.size.toLong())
            is Result.File -> try {
                response(200, r.type, FileInputStream(r.file), r.file.length())
            } catch (_: FileNotFoundException) {
                text(404, "Not found")
            }
            is Result.Asset -> try {
                response(200, r.type, assets.open(r.path), null)
            } catch (_: IOException) {
                text(404, "Not found")
            }
        }
    }

    private fun text(status: Int, text: String): WebResourceResponse {
        val b = text.toByteArray(Charsets.UTF_8)
        return response(status, "text/plain; charset=utf-8", ByteArrayInputStream(b), b.size.toLong())
    }

    private fun response(status: Int, type: String, data: InputStream, length: Long?): WebResourceResponse {
        val mime = type.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
        val charset = type.substringAfter(';', "").split(';')
            .map { it.trim() }
            .firstOrNull { it.startsWith("charset=", ignoreCase = true) }
            ?.substringAfter('=')?.trim()?.trim('"')
        val headers = LinkedHashMap(NO_CACHE)
        if (length != null) headers["Content-Length"] = length.toString()
        return WebResourceResponse(mime, charset, status, reason(status), headers, data)
    }

    private fun contentType(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        types[ext]?.let { return it }
        val t = HostJs.contentTypeBlocking(if (ext.isEmpty()) name else "x.$ext")
        types[ext] = t
        return t
    }

    companion object {
        const val HOST = "quire.local"
        const val ORIGIN = "https://$HOST"
        private const val RUNTIME_ASSETS = "runtime"

        /** `https://quire.local/vault/<encoded segments>/` for a page path. */
        fun pageUrl(path: String): String =
            "$ORIGIN/vault/" + path.split('/').filter { it.isNotEmpty() }.joinToString("/") { encodeURIComponent(it) } + "/"

        /** Whether a url is served by this handler (the https origin or the quire:// hosts). */
        fun owns(url: Uri): Boolean {
            val scheme = url.scheme?.lowercase()
            val host = url.host?.lowercase()
            return (scheme == "https" && host == HOST) || (scheme == "quire" && (host == "vault" || host == "runtime"))
        }

        /**
         * The vault path segments of a page url (`https://quire.local/vault/…` or
         * `quire://vault/…`), decoded; null for any other url or a bad encoding.
         */
        fun vaultSegments(url: Uri): List<String>? {
            val scheme = url.scheme?.lowercase()
            val host = url.host?.lowercase()
            val path = url.encodedPath ?: "/"
            return when {
                scheme == "https" && host == HOST && (path == "/vault" || path.startsWith("/vault/")) ->
                    decodeSegments(path.removePrefix("/vault"))
                scheme == "quire" && host == "vault" -> decodeSegments(path)
                else -> null
            }
        }

        /** Split an encoded path on "/" (empty segments dropped) and percent-decode each; null on bad UTF-8. */
        fun decodeSegments(pathname: String): List<String>? {
            val out = ArrayList<String>()
            for (raw in pathname.split('/')) {
                if (raw.isEmpty()) continue
                out.add(percentDecode(raw) ?: return null)
            }
            return out
        }

        /** Strict percent-decoding (Swift's removingPercentEncoding): null on a bad escape or bad UTF-8. */
        fun percentDecode(s: String): String? {
            if ('%' !in s) return s
            val bytes = java.io.ByteArrayOutputStream(s.length)
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '%') {
                    if (i + 2 >= s.length) return null
                    val h = Character.digit(s[i + 1], 16)
                    val l = Character.digit(s[i + 2], 16)
                    if (h < 0 || l < 0) return null
                    bytes.write(h * 16 + l)
                    i += 3
                } else {
                    val b = c.toString().toByteArray(Charsets.UTF_8)
                    bytes.write(b, 0, b.size)
                    i++
                }
            }
            return try {
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes.toByteArray()))
                    .toString()
            } catch (_: CharacterCodingException) {
                null
            }
        }

        private const val URI_COMPONENT_ALLOWED = "-_.!~*'()"

        /** JavaScript's encodeURIComponent. */
        fun encodeURIComponent(s: String): String {
            val sb = StringBuilder(s.length)
            for (b in s.toByteArray(Charsets.UTF_8)) {
                val c = (b.toInt() and 0xFF)
                val ch = c.toChar()
                if ((ch in 'a'..'z') || (ch in 'A'..'Z') || (ch in '0'..'9') || (c < 0x80 && ch in URI_COMPONENT_ALLOWED)) {
                    sb.append(ch)
                } else {
                    sb.append('%').append(HEX[c shr 4]).append(HEX[c and 0xF])
                }
            }
            return sb.toString()
        }

        private val HEX = "0123456789ABCDEF".toCharArray()

        /**
         * A phone needs a viewport, which desktop entries don't carry. It goes first in the
         * injected head block (right before the quire-page meta transformEntry adds).
         */
        fun addViewport(html: String): String {
            val meta = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
            val i = html.indexOf("<meta name=\"quire-page\"")
            if (i < 0) return html
            return html.substring(0, i) + meta + html.substring(i)
        }

        /** The injected head points at quire://runtime (and runtime urls at quire://vault): serve them on [ORIGIN]. */
        fun rewriteQuireUrls(html: String): String =
            html.replace("quire://runtime/", "$ORIGIN/runtime/").replace("quire://vault/", "$ORIGIN/vault/")

        fun escAttr(s: String): String =
            s.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;")

        private fun within(file: File, base: File): Boolean {
            val f = file.absoluteFile.normalize().path
            val b = base.absoluteFile.normalize().path
            return f.startsWith("$b/")
        }

        private fun reason(status: Int): String = when (status) {
            200 -> "OK"
            204 -> "No Content"
            400 -> "Bad Request"
            403 -> "Forbidden"
            404 -> "Not Found"
            500 -> "Internal Server Error"
            503 -> "Service Unavailable"
            else -> if (status in 200..299) "OK" else "Error"
        }

        private val NO_CACHE = mapOf(
            "Cache-Control" to "no-store, no-cache, must-revalidate",
            "Pragma" to "no-cache",
            "Expires" to "0",
            "Access-Control-Allow-Origin" to "*",
        )
    }
}

/** One [PageRequestHandler] per vault root, shared by every page of that vault. */
object PageServer {
    private val handlers = ConcurrentHashMap<String, PageRequestHandler>()

    /** The handler for [store]'s root (VaultStore holds no state beyond its root, so any instance serves). */
    fun handlerFor(store: VaultStore): PageRequestHandler =
        handlers.getOrPut(store.root.path) { PageRequestHandler(store, QuireApp.context.assets) }
}
