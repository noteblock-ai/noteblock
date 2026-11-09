package org.harborapps.quire.host

import android.os.Looper
import androidx.concurrent.futures.await
import androidx.javascriptengine.IsolateStartupParameters
import androidx.javascriptengine.IsolateTerminatedException
import androidx.javascriptengine.JavaScriptException
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import androidx.javascriptengine.SandboxDeadException
import java.io.FileNotFoundException
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.harborapps.quire.app.QuireApp

/** Anything that goes wrong in the host JS: unsupported device, host.js missing, a JS exception. */
class HostJsException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * The Mac's pure render/save JavaScript (core/html.mjs + app/main/transform.mjs, bundled from
 * mobile/host.mjs as assets/host.js) in one JavaScriptSandbox isolate. Port of
 * ios/Quire/Host/HostJS.swift.
 *
 * An isolate is single-threaded, so every call goes through one Mutex. Each wrapper is a
 * `suspend fun` plus a `...Blocking` twin for WebView's shouldInterceptRequest threads; the
 * blocking ones refuse the main thread (the sandbox connects through a main-thread service
 * callback, so blocking it would deadlock). A dead isolate or sandbox is rebuilt and the call
 * retried once.
 *
 * Arguments travel as JSON literals. A call whose arguments are large (a few MB of HTML) goes
 * through provideNamedData when the sandbox supports it, so it isn't capped by the binder
 * transaction limit.
 */
object HostJs {
    private const val ASSET = "host.js"
    private const val BLOCKING_TIMEOUT_MS = 30_000L
    /** Above this many chars of JS source, pass the arguments as named data instead. */
    private const val INLINE_LIMIT = 200_000
    private const val MAX_HEAP_BYTES = 256L * 1024 * 1024
    private const val MAX_RETURN_BYTES = 64 * 1024 * 1024

    private val mutex = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dataIds = AtomicLong(0)

    // Guarded by mutex.
    private var sandbox: JavaScriptSandbox? = null
    private var isolate: JavaScriptIsolate? = null
    @Volatile private var isolateDead = false

    /** Start connecting the sandbox and loading host.js in the background. Never blocks. */
    fun warmUp() {
        scope.launch {
            try {
                mutex.withLock { ensureIsolate() }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // The first real call reports it.
            }
        }
    }

    // MARK: - core/html.mjs

    /** Adds data-q-i="0..n-1" to every top-level element child of <body>. */
    suspend fun indexBody(html: String): String = string("indexBody", JsonPrimitive(html))
    fun indexBodyBlocking(html: String): String = blocking { indexBody(html) }

    /**
     * Apply the editor's WYSIWYG regions to the RAW file. [regionsJson] is a JSON array string:
     * `[{"replace":[Int], "before":Int|null, "html":String}]`. Throws on a bad index.
     */
    suspend fun applyRegions(html: String, regionsJson: String): String {
        val regions = try {
            Json.parseToJsonElement(regionsJson)
        } catch (e: Exception) {
            throw HostJsException("regions is not valid JSON: ${e.message}", e)
        }
        if (regions !is JsonArray) throw HostJsException("regions must be a JSON array")
        return string("applyRegions", JsonPrimitive(html), regions)
    }
    fun applyRegionsBlocking(html: String, regionsJson: String): String = blocking { applyRegions(html, regionsJson) }

    /** Markdown → full HTML document (body data-q-format="md"); frontmatter isn't shown. */
    suspend fun renderMarkdown(md: String, title: String? = null): String =
        string("renderMarkdown", JsonPrimitive(md), buildJsonObject { if (title != null) put("title", title) })
    fun renderMarkdownBlocking(md: String, title: String? = null): String = blocking { renderMarkdown(md, title) }

    /** Body innerHTML → markdown (what a markdown page's save writes, after the frontmatter). */
    suspend fun htmlToMarkdown(bodyHtml: String): String = string("htmlToMarkdown", JsonPrimitive(bodyHtml))
    fun htmlToMarkdownBlocking(bodyHtml: String): String = blocking { htmlToMarkdown(bodyHtml) }

    /** The leading YAML block ("" or the whole `---…---\n`) and the rest: (frontmatter, body). */
    suspend fun splitFrontmatter(md: String): Pair<String, String> {
        val out = string("splitFrontmatter", JsonPrimitive(md))
        return try {
            val o = Json.parseToJsonElement(out).jsonObject
            Pair(o.getValue("frontmatter").jsonPrimitive.content, o.getValue("body").jsonPrimitive.content)
        } catch (e: Exception) {
            throw HostJsException("QuireHost.splitFrontmatter returned an unexpected value", e)
        }
    }
    fun splitFrontmatterBlocking(md: String): Pair<String, String> = blocking { splitFrontmatter(md) }

    /** Remove data-q-* and contenteditable attributes from every start tag. */
    suspend fun stripEditorAttrs(fragment: String): String = string("stripEditorAttrs", JsonPrimitive(fragment))
    fun stripEditorAttrsBlocking(fragment: String): String = blocking { stripEditorAttrs(fragment) }

    // MARK: - app/main/transform.mjs

    /** MIME type by extension ("text/javascript; charset=utf-8" for .mjs, …). Never throws. */
    suspend fun contentType(file: String): String =
        try {
            string("contentType", JsonPrimitive(file))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            "application/octet-stream"
        }
    fun contentTypeBlocking(file: String): String =
        try {
            blocking { contentType(file) }
        } catch (_: Exception) {
            "application/octet-stream"
        }

    /**
     * The block injected after <head>: quire-page meta, import map, theme.css, editor prefs
     * (when [editorJson] is non-null; "{}" means the defaults), runtime.js.
     * [editorJson] is a JSON object string like `{"textSize":17}`, or null.
     */
    suspend fun headInjection(pagePath: String, editorJson: String? = "{}"): String =
        string("headInjection", JsonPrimitive(pagePath), editor(editorJson))
    fun headInjectionBlocking(pagePath: String, editorJson: String? = "{}"): String =
        blocking { headInjection(pagePath, editorJson) }

    suspend fun injectHead(html: String, pagePath: String, baseHref: String? = null, editorJson: String? = "{}"): String =
        string("injectHead", JsonPrimitive(html), JsonPrimitive(pagePath), JsonPrimitive(baseHref), editor(editorJson))
    fun injectHeadBlocking(html: String, pagePath: String, baseHref: String? = null, editorJson: String? = "{}"): String =
        blocking { injectHead(html, pagePath, baseHref, editorJson) }

    /** Entry source → the served document (markdown rendered first, then indexBody + head). format: "html" | "md". */
    suspend fun transformEntry(
        source: String,
        format: String,
        pagePath: String,
        title: String,
        baseHref: String? = null,
        editorJson: String? = "{}",
    ): String {
        val opts = buildJsonObject {
            put("pagePath", pagePath)
            put("title", title)
            put("baseHref", JsonPrimitive(baseHref))
            put("editor", editor(editorJson))
        }
        return string("transformEntry", JsonPrimitive(source), JsonPrimitive(format), opts)
    }
    fun transformEntryBlocking(
        source: String,
        format: String,
        pagePath: String,
        title: String,
        baseHref: String? = null,
        editorJson: String? = "{}",
    ): String = blocking { transformEntry(source, format, pagePath, title, baseHref, editorJson) }

    // MARK: - manifest (RpcBridge.swift ManifestJSON)

    /**
     * Set (h > 0) or delete `embed.height` in a page manifest (`.noteblock` / legacy `.quire`)'s text, written back the way
     * core's writeManifest writes it (`JSON.stringify(m, null, 2) + "\n"`, key order kept).
     */
    suspend fun setEmbedHeight(manifestText: String, h: Int): String =
        evaluateCall("__quireSetEmbedHeight", buildJsonArray { add(JsonPrimitive(manifestText)); add(JsonPrimitive(h)) })
    fun setEmbedHeightBlocking(manifestText: String, h: Int): String = blocking { setEmbedHeight(manifestText, h) }

    // MARK: - Plumbing

    private fun editor(json: String?): JsonElement {
        if (json == null) return JsonNull
        val e = try {
            Json.parseToJsonElement(json)
        } catch (ex: Exception) {
            throw HostJsException("editor is not valid JSON: ${ex.message}", ex)
        }
        if (e !is JsonObject && e !is JsonNull) throw HostJsException("editor must be a JSON object or null")
        return e
    }

    private suspend fun string(name: String, vararg args: JsonElement): String =
        evaluateCall("QuireHost.$name", JsonArray(args.toList()), name)

    private fun <T> blocking(block: suspend () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw IllegalStateException("HostJs blocking calls must not run on the main thread")
        }
        return try {
            runBlocking { withTimeout(BLOCKING_TIMEOUT_MS) { block() } }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            throw HostJsException("HostJs call timed out after ${BLOCKING_TIMEOUT_MS / 1000}s", e)
        }
    }

    /**
     * Call `fn(...args)` in the isolate; the result is the string, or JSON.stringify of a
     * non-string result. [label] names the function for "is not defined" errors.
     */
    private suspend fun evaluateCall(fn: String, args: JsonArray, label: String = fn): String = mutex.withLock {
        var retried = false
        while (true) {
            val iso = ensureIsolate()
            try {
                return@withLock run(iso, fn, args, label)
            } catch (e: IsolateTerminatedException) {
                // SandboxDeadException is a subclass: the whole service went away.
                discard(sandboxToo = e is SandboxDeadException)
                if (retried) throw HostJsException("The JavaScript sandbox stopped: ${e.message}", e)
                retried = true
            } catch (e: JavaScriptException) {
                throw HostJsException(e.message ?: "JavaScript error", e)
            }
        }
        @Suppress("UNREACHABLE_CODE")
        throw IllegalStateException()
    }

    private suspend fun run(iso: JavaScriptIsolate, fn: String, args: JsonArray, label: String): String {
        val sb = sandbox!!
        val argsJson = args.toString()
        val call = "var f = $fn; if (typeof f !== 'function') throw new Error(${JsonPrimitive("QuireHost.$label is not defined")});" +
            " var r = f.apply(null, a); return typeof r === 'string' ? r : JSON.stringify(r);"
        val useNamedData = argsJson.length > INLINE_LIMIT &&
            !sb.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_EVALUATE_WITHOUT_TRANSACTION_LIMIT) &&
            sb.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_PROVIDE_CONSUME_ARRAY_BUFFER) &&
            sb.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_PROMISE_RETURN)
        val source = if (useNamedData) {
            // UTF-16LE bytes decode exactly with a Uint16Array, no TextDecoder needed.
            val id = "quire-args-${dataIds.incrementAndGet()}"
            iso.provideNamedData(id, argsJson.toByteArray(Charsets.UTF_16LE))
            "android.consumeNamedDataAsArrayBuffer(${JsonPrimitive(id)}).then(function (buf) {" +
                " var a = JSON.parse(__quireUtf16(buf)); $call })"
        } else {
            "(function () { var a = $argsJson; $call })()"
        }
        return iso.evaluateJavaScriptAsync(source).await()
    }

    /** The live isolate, creating the sandbox / isolate and loading host.js as needed. Under mutex. */
    private suspend fun ensureIsolate(): JavaScriptIsolate {
        isolate?.let { if (!isolateDead) return it }
        if (isolate != null) discard(sandboxToo = false)

        if (!JavaScriptSandbox.isSupported()) {
            throw HostJsException("This device's WebView doesn't support JavaScriptSandbox; update Android System WebView")
        }
        val sb = sandbox ?: try {
            JavaScriptSandbox.createConnectedInstanceAsync(QuireApp.context).await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw HostJsException("Could not start the JavaScript sandbox: ${e.message}", e)
        }.also { sandbox = it }

        val params = IsolateStartupParameters()
        if (sb.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE)) {
            params.setMaxHeapSizeBytes(MAX_HEAP_BYTES)
        }
        params.setMaxEvaluationReturnSizeBytes(MAX_RETURN_BYTES)
        val iso = try {
            sb.createIsolate(params)
        } catch (e: Exception) {
            // createIsolate throws IllegalStateException on a dead/closed sandbox.
            discard(sandboxToo = true)
            throw HostJsException("Could not create a JavaScript isolate: ${e.message}", e)
        }
        isolateDead = false
        if (sb.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_TERMINATION)) {
            iso.addOnTerminatedCallback(Executor { it.run() }) { if (isolate === iso) isolateDead = true }
        }
        isolate = iso

        try {
            loadHost(sb, iso)
            iso.evaluateJavaScriptAsync(HELPERS).await()
            val ok = iso.evaluateJavaScriptAsync("typeof globalThis.QuireHost === 'object' ? 'ok' : 'missing'").await()
            if (ok != "ok") throw HostJsException("host.js loaded but QuireHost is not defined")
        } catch (e: HostJsException) {
            discard(sandboxToo = false)
            throw e
        } catch (e: CancellationException) {
            discard(sandboxToo = false)
            throw e
        } catch (e: SandboxDeadException) {
            discard(sandboxToo = true)
            throw HostJsException("host.js failed to load: ${e.message}", e)
        } catch (e: Exception) {
            discard(sandboxToo = false)
            throw HostJsException("host.js failed to load: ${e.message}", e)
        }
        return iso
    }

    private suspend fun loadHost(sb: JavaScriptSandbox, iso: JavaScriptIsolate) {
        val assets = QuireApp.context.assets
        // From the fd when we can (no binder size limit; js is noCompress so openFd works).
        if (sb.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_EVALUATE_FROM_FD)) {
            val afd = try {
                assets.openFd(ASSET)
            } catch (_: FileNotFoundException) {
                null // missing or compressed; fall through to the string path
            }
            if (afd != null) {
                afd.use { iso.evaluateJavaScriptAsync(it).await() }
                return
            }
        }
        val js = try {
            assets.open(ASSET).use { it.readBytes().toString(Charsets.UTF_8) }
        } catch (e: Exception) {
            throw HostJsException("host.js is missing from the app's assets", e)
        }
        iso.evaluateJavaScriptAsync(js).await()
    }

    /** Close the isolate (and the sandbox, if it's dead too). Under mutex. */
    private fun discard(sandboxToo: Boolean) {
        runCatching { isolate?.close() }
        isolate = null
        isolateDead = false
        if (sandboxToo) {
            runCatching { sandbox?.close() }
            sandbox = null
        }
    }

    /** Evaluated once per isolate after host.js. */
    private val HELPERS = """
        globalThis.__quireUtf16 = function (buf) {
          var u = new Uint16Array(buf), out = "", step = 8192;
          for (var i = 0; i < u.length; i += step) out += String.fromCharCode.apply(null, u.subarray(i, i + step));
          return out;
        };
        globalThis.__quireSetEmbedHeight = function (text, h) {
          var m = null;
          try { m = JSON.parse(text); } catch (e) {}
          if (!m || typeof m !== "object" || Array.isArray(m)) m = {};
          if (h > 0) m.embed = Object.assign({}, m.embed || {}, { height: h });
          else if (m.embed) {
            delete m.embed.height;
            if (!Object.keys(m.embed).length) delete m.embed;
          }
          return JSON.stringify(m, null, 2) + "\n";
        };
        "ok"
    """.trimIndent()
}
