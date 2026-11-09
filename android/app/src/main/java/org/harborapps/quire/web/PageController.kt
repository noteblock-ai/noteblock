package org.harborapps.quire.web

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.ui.graphics.toArgb
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import org.harborapps.quire.BuildConfig
import org.harborapps.quire.app.LaunchOptions
import org.harborapps.quire.bridge.RpcHandling
import org.harborapps.quire.bridge.RpcRequest
import org.harborapps.quire.design.QuireColors
import org.harborapps.quire.vault.VaultNode
import org.harborapps.quire.vault.VaultStore

/**
 * Owns one page's WebView: loads `https://quire.local/vault/<page>/` (served by
 * [PageRequestHandler]), answers its rpcs through the `quire` bridge ([SHIM] over a
 * WebMessageListener) and sends it the same `{quire: 1, type: "mode" | "store-changed" | "save"}`
 * messages the desktop renderer posts. Port of PageController in ios/Quire/Web/PageWebView.swift.
 *
 * The page is the TOP frame (no iframe around it). runtime.js sees
 * `window.webkit.messageHandlers.quire` and switches to the native transport: rpcs arrive as
 * `{id, method, params, page}` and are answered with `window.__quireRpcReply(id, ok, value)` in
 * the frame that asked (embeds are iframes and ask for themselves). Main thread only.
 */
class PageController(
    private val context: Context,
    val page: VaultNode,
    val store: VaultStore,
    val bridge: RpcHandling,
    val handler: PageRequestHandler,
) {
    data class Mode(
        val edit: Boolean = false,
        val readOnly: Boolean = false,
        /** Built pages save on demand (⌘S on the Mac) instead of autosaving. */
        val manualSave: Boolean = false,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mainHandler = Handler(Looper.getMainLooper())

    private val _isLoading = MutableStateFlow(true)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()
    private val _loadError = MutableStateFlow<String?>(null)
    val loadError: StateFlow<String?> = _loadError.asStateFlow()
    // Reading mode by default (the Mobile design: Edit turns the editor on). A page an agent is
    // editing on the Mac is read-only; store writes are refused then.
    private val _mode = MutableStateFlow(Mode(edit = false, readOnly = page.isLocked, manualSave = page.isBuilt))
    /** The mode last sent (or to be sent once the page loads). */
    val mode: StateFlow<Mode> = _mode.asStateFlow()
    private val _webViewGeneration = MutableStateFlow(0)
    /** Bumped when the WebView is replaced (its renderer died); [PageWebView] re-hosts it. */
    val webViewGeneration: StateFlow<Int> = _webViewGeneration.asStateFlow()

    /** Editor state from the page (`quireEditor` messages, main frame only). */
    var onEditorMessage: ((JsonObject) -> Unit)? = null
    /** A link to another vault path (the page screen resolves it to its page). */
    var onOpenPage: ((String) -> Unit)? = null

    var webView: WebView? = null
        private set

    private var destroyed = false
    private var debugEvalDone = false
    private val storeChangedHook: (String, String?) -> Unit = { changed, table -> notifyStoreChanged(changed, table) }

    init {
        // A store/kv write → `store-changed` to the page and its embeds (desktop App.jsx).
        bridge.onStoreChanged = storeChangedHook
    }

    val url: String get() = PageRequestHandler.pageUrl(page.path)

    /** Whether this page may enter edit mode on the phone: Quire's editor, not locked, no backend (Mac only). */
    val canEdit: Boolean get() = page.renderer == "quire" && !page.isLocked && !page.hasBackend

    // MARK: - Web view

    /** The controller's WebView, created and loaded on first call, then reused while the controller lives. */
    @SuppressLint("SetJavaScriptEnabled")
    fun makeWebView(): WebView {
        webView?.let { return it }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val web = WebView(context)
        webView = web
        web.setBackgroundColor(QuireColors.background.toArgb())
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        web.webViewClient = Client()
        web.webChromeClient = Chrome()

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) {
            _isLoading.value = false
            _loadError.value = "This page needs a newer Android System WebView. Update it from Google Play and try again."
            return web
        }
        val origins = setOf(PageRequestHandler.ORIGIN)
        WebViewCompat.addDocumentStartJavaScript(web, SHIM, origins)
        WebViewCompat.addWebMessageListener(web, "quireAndroid", origins, Listener())
        _isLoading.value = true
        web.loadUrl(url)
        return web
    }

    fun reload() {
        _loadError.value = null
        val web = webView ?: return
        _isLoading.value = true
        web.loadUrl(url)
    }

    /** Release the WebView (the owner calls this when the screen leaves). */
    fun destroy() {
        if (destroyed) return
        destroyed = true
        scope.cancel()
        mainHandler.removeCallbacksAndMessages(null)
        if (bridge.onStoreChanged === storeChangedHook) bridge.onStoreChanged = null
        onEditorMessage = null
        onOpenPage = null
        webView?.let { dispose(it) }
        webView = null
    }

    private fun dispose(web: WebView) {
        (web.parent as? ViewGroup)?.removeView(web)
        web.stopLoading()
        web.webChromeClient = null
        web.destroy()
    }

    // MARK: - Messages to the page

    /**
     * Turn edit mode on or off, the way the desktop renderer does: a `mode` message the runtime
     * applies to the top page and relays to its embeds. Off keeps store writes working (apps stay
     * live in reading mode) unless the page is locked.
     */
    fun setEditing(edit: Boolean) {
        setMode(Mode(edit = edit && canEdit, readOnly = page.isLocked, manualSave = page.isBuilt))
    }

    fun setMode(newMode: Mode) {
        _mode.value = newMode
        if (!_isLoading.value) sendMode()
    }

    private fun sendMode() {
        val m = _mode.value
        post(buildJsonObject {
            put("quire", 1)
            put("type", "mode")
            put("edit", m.edit)
            put("readOnly", m.readOnly)
            put("manualSave", m.manualSave)
        })
    }

    /** Tell the page (and its embeds) a table changed, so `subscribe` callbacks fire. table null = kv. */
    fun notifyStoreChanged(page: String, table: String?) {
        post(buildJsonObject {
            put("quire", 1)
            put("type", "store-changed")
            put("page", page)
            put("table", table?.let { JsonPrimitive(it) } ?: JsonNull)
        })
    }

    /** Ask the runtime to save pending edits now (the desktop's "save" message). */
    fun flushSave() {
        post(buildJsonObject {
            put("quire", 1)
            put("type", "save")
        })
    }

    /** `window.postMessage(message, "*")` in the top frame; the runtime treats it as coming from its host. */
    fun post(message: JsonObject) {
        evaluate("window.postMessage($message, \"*\")")
    }

    /** Evaluate JavaScript in the top frame; [callback] gets the JSON result (null when there is no WebView). */
    fun evaluate(js: String, callback: ((String?) -> Unit)? = null) {
        val web = webView
        if (web == null || destroyed) {
            callback?.invoke(null)
            return
        }
        web.evaluateJavascript(js, callback?.let { cb -> { v: String? -> cb(v) } })
    }

    // MARK: - Rpc

    private inner class Listener : WebViewCompat.WebMessageListener {
        override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat,
            sourceOrigin: Uri,
            isMainFrame: Boolean,
            replyProxy: JavaScriptReplyProxy,
        ) {
            if (destroyed || view !== webView) return
            val envelope = try {
                RpcRequest.json.parseToJsonElement(message.data ?: return) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return
            val ch = (envelope["ch"] as? JsonPrimitive)?.contentOrNull
            val body = envelope["body"]
            when (ch) {
                "quire" -> {
                    val request = body?.let { RpcRequest.parse(it.toString()) } ?: return
                    receive(request, replyProxy)
                }
                "quireEditor" -> {
                    if (!isMainFrame) return
                    (body as? JsonObject)?.let { onEditorMessage?.invoke(it) }
                }
            }
        }
    }

    private fun receive(request: RpcRequest, replyProxy: JavaScriptReplyProxy) {
        scope.launch {
            val (ok, value) = try {
                true to bridge.handle(request)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false to JsonPrimitive(e.message ?: e.javaClass.simpleName)
            }
            reply(request, replyProxy, ok, value)
        }
    }

    private fun reply(request: RpcRequest, replyProxy: JavaScriptReplyProxy, ok: Boolean, value: JsonElement) {
        if (destroyed) return
        val msg = buildJsonObject {
            put("type", "rpc-reply")
            put("id", request.id)
            put("ok", ok)
            put("value", value)
        }
        try {
            replyProxy.postMessage(msg.toString())
        } catch (e: Exception) {
            // The frame is gone (navigated away or removed).
            if (BuildConfig.DEBUG) Log.w(TAG, "rpc reply failed (${request.method}): ${e.message}")
        }
    }

    // MARK: - Navigation

    private fun openExternally(uri: Uri) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).apply {
                if (context !is android.app.Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        } catch (_: ActivityNotFoundException) {
        } catch (_: SecurityException) {
        }
    }

    private fun sameDocument(target: Uri, current: String?): Boolean {
        if (current == null) return false
        val a = target.buildUpon().fragment(null).build().toString()
        val b = Uri.parse(current).buildUpon().fragment(null).build().toString()
        return a == b
    }

    private fun shouldOverride(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url ?: return true
        when (uri.scheme?.lowercase()) {
            "about", "blob", "data" -> return false
        }
        if (PageRequestHandler.owns(uri)) {
            // Embeds load their pages in subframes.
            if (!request.isForMainFrame) return false
            // A fragment link (or a reload) of this page stays here.
            if (sameDocument(uri, view.url) || sameDocument(uri, url)) return false
            val segs = PageRequestHandler.vaultSegments(uri) ?: return true
            if (segs.isEmpty()) return true
            onOpenPage?.invoke(segs.joinToString("/"))
            return true
        }
        return when (uri.scheme?.lowercase()) {
            // Links out of the vault open outside the app (contract: "Links").
            "http", "https", "mailto", "tel" -> {
                // A page's own iframe (a map, a video) loads in place; only a tap leaves the app.
                if (!request.isForMainFrame && !request.hasGesture()) return false
                openExternally(uri)
                true
            }
            else -> true
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            handler.respond(request)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            shouldOverride(view, request)

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (view !== webView) return
            _isLoading.value = true
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (view !== webView || destroyed) return
            _isLoading.value = false
            sendMode()
            if (BuildConfig.DEBUG && !debugEvalDone) {
                debugEvalDone = true
                // debugEval "<js expression>": evaluated 1.5 s after the page loads, the result
                // logged as `[debugEval] …` (Logcat tag QuirePage). A promise is awaited.
                LaunchOptions.current.debugEval?.let { expr ->
                    val js = "(async()=>{try{return String(await ($expr))}catch(e){return 'threw: '+e}})()" +
                        ".then(v=>console.log('[debugEval] '+v))"
                    mainHandler.postDelayed({ evaluate(js) }, 1500)
                }
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (view !== webView || !request.isForMainFrame) return
            _isLoading.value = false
            _loadError.value = error.description?.toString()?.takeIf { it.isNotEmpty() } ?: "The page could not be loaded"
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The iOS equivalent reloads (webViewWebContentProcessDidTerminate). A WebView whose
            // renderer died can't be used again: drop it and host a fresh one in the same place.
            val parent = view.parent as? ViewGroup
            val index = parent?.indexOfChild(view) ?: -1
            if (view === webView) webView = null
            dispose(view)
            if (destroyed) return true
            debugEvalDone = true
            _loadError.value = null
            val fresh = makeWebView()
            if (parent != null && fresh.parent == null) {
                parent.addView(fresh, if (index >= 0) index else parent.childCount,
                    ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
            _webViewGeneration.value += 1
            return true
        }
    }

    private class Chrome : WebChromeClient() {
        override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
            if (!BuildConfig.DEBUG) return false
            val text = "${consoleMessage.message()} @ ${consoleMessage.sourceId()}:${consoleMessage.lineNumber()}"
            when (consoleMessage.messageLevel()) {
                ConsoleMessage.MessageLevel.ERROR -> Log.e(TAG, text)
                ConsoleMessage.MessageLevel.WARNING -> Log.w(TAG, text)
                else -> Log.i(TAG, text)
            }
            return true
        }
    }

    companion object {
        const val TAG = "QuirePage"
    }
}
