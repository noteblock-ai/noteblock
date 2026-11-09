package org.harborapps.quire.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * One rpc from a page's runtime (app/runtime/runtime.js, the `nativeHost` transport):
 * `window.webkit.messageHandlers.quire.postMessage({id, method, params, page})`, which the
 * Android shim forwards as JSON. `params` always carries `from` (the calling page's own path)
 * and `page` (the target page for query/navigate, else the caller). See docs/contract.md,
 * "Messages: page ⇄ renderer". Port of RpcRequest in ios/Quire/Bridge/RpcBridge.swift.
 */
data class RpcRequest(
    val id: String,
    val method: String,
    val params: JsonObject,
    /** The calling page's path (the frame's `<meta name="quire-page">`). */
    val page: String,
) {
    /** The page store/kv/save calls act on: `params.from` unless empty, else the frame's page. */
    val from: String
        get() = params["from"]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
            ?.takeIf { it.isNotEmpty() } ?: page

    companion object {
        val json = Json { ignoreUnknownKeys = true; explicitNulls = true }

        fun parse(text: String): RpcRequest? = runCatching {
            val o = json.parseToJsonElement(text).jsonObject
            val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return null
            val method = o["method"]?.jsonPrimitive?.contentOrNull ?: return null
            val params = (o["params"] as? JsonObject) ?: JsonObject(emptyMap())
            val page = o["page"]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() } ?: ""
            RpcRequest(id, method, params, page)
        }.getOrNull()
    }
}

/** An rpc failure; its message goes back to the page as the rejection. */
class RpcException(message: String) : Exception(message)

/**
 * Answers a page's rpcs (RpcBridge). The return value is sent to the page as the rpc result.
 */
interface RpcHandling {
    suspend fun handle(request: RpcRequest): JsonElement

    /** Called after a store/kv write with (page path, table or null for kv). The page
     *  controller forwards it to the page as `store-changed`, like the desktop renderer. */
    var onStoreChanged: ((page: String, table: String?) -> Unit)?

    /** Open another page (the `navigate` rpc), with a page path. Set by the page screen. */
    var onNavigate: ((String) -> Unit)?
}
