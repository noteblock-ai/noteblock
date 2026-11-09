package org.harborapps.quire.bridge

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import org.harborapps.quire.host.HostJs
import org.harborapps.quire.web.PageRequestHandler
import org.harborapps.quire.vault.VaultNode
import org.harborapps.quire.vault.VaultPaths
import org.harborapps.quire.vault.VaultStore
import org.harborapps.quire.vault.walked
import java.io.File
import java.io.IOException
import kotlin.math.floor

/**
 * Answers page rpcs exactly like runRpc in app/main/ipc.mjs: store.* / kv.* on the page's
 * SQLite ([PageStore]), query, pages, navigate, save and embed.setHeight. Writes are refused
 * on a page an agent has locked, and every file written is put in [VaultChanges] for sync.
 * Port of RpcBridge in ios/Quire/Bridge/RpcBridge.swift. Differences from the Mac, by design:
 * no autosave commit (sync commits what VaultChanges lists) and no rebuild after saving a
 * built page (builds are Mac only; the built entry is patched in place).
 */
class RpcBridge(val vault: VaultStore, val user: String = PageStore.currentUser) : RpcHandling {
    override var onStoreChanged: ((page: String, table: String?) -> Unit)? = null
    override var onNavigate: ((String) -> Unit)? = null

    companion object {
        /** app/main/ipc.mjs READ_ONLY_MSG, word for word. */
        const val READ_ONLY_MESSAGE = "Page is read-only while it is being edited"

        /** The methods after which the desktop renderer posts `store-changed` (App.jsx WRITE_METHODS). */
        val STORE_WRITES: Set<String> = setOf("store.insert", "store.update", "store.remove", "kv.set")

        private val lenient = Json { ignoreUnknownKeys = true }
    }

    override suspend fun handle(request: RpcRequest): JsonElement = try {
        dispatch(request)
    } catch (e: CancellationException) {
        throw e
    } catch (e: RpcException) {
        throw e
    } catch (e: Exception) {
        throw RpcException(e.message ?: e.javaClass.simpleName)
    }

    private suspend fun dispatch(request: RpcRequest): JsonElement {
        val p = request.params
        val from = request.from
        return when (val method = request.method) {
            "store.all" -> io { JsonArray(store(findPage(from)).all(table(p))) }
            "store.get" -> io { store(findPage(from)).get(table(p), id(p)) ?: JsonNull }
            "store.insert", "store.update", "store.remove" -> {
                val (node, t, result) = io {
                    val node = findPage(from)
                    assertWritable(node)
                    val s = store(node)
                    val t = table(p)
                    val result: JsonElement = when (method) {
                        "store.insert" -> s.insert(t, p["obj"] as? JsonObject ?: JsonObject(emptyMap()))
                        "store.update" -> s.update(t, id(p), p["patch"] as? JsonObject ?: JsonObject(emptyMap()))
                        else -> JsonPrimitive(s.remove(t, id(p)))
                    }
                    Triple(node, t, result)
                }
                dataChanged(node, t)
                result
            }
            "kv.get" -> io { store(findPage(from)).kvGet(key(p)) }
            "kv.set" -> {
                val (node, result) = io {
                    val node = findPage(from)
                    assertWritable(node)
                    val value = p["value"]?.takeUnless { it is JsonNull }
                    node to JsonPrimitive(store(node).kvSet(key(p), value))
                }
                dataChanged(node, null)
                result
            }
            "query" -> io { JsonArray(store(findPage(str(p["page"]))).all(table(p))) }
            "pages" -> io { publicTree(vault.listTree()) }
            "navigate" -> {
                val target = io { resolveNavigation(str(p["page"])) }
                if (target != null) onNavigate?.invoke(target)
                JsonNull
            }
            "save" -> save(io { findPage(from) }, p)
            "embed.setHeight" -> setEmbedHeight(io { findPage(str(p["page"])) }, p["height"])
            else -> throw RpcException("Unknown method: $method")
        }
    }

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    // ---- Params

    /** A string param (`as? String`): anything else is "". */
    private fun str(v: JsonElement?): String =
        (v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""

    private fun table(p: JsonObject): String {
        val t = (p["table"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (t.isNullOrEmpty()) throw RpcException("table must be a non-empty string")
        return t
    }

    private fun id(p: JsonObject): String {
        val raw = p["id"]
        if (raw == null || raw is JsonNull) throw RpcException("id is required")
        val s = JsonValue.jsString(raw)
        if (s.isEmpty()) throw RpcException("id is required")
        return s
    }

    private fun key(p: JsonObject): String {
        val raw = p["key"]
        if (raw == null || raw is JsonNull) throw RpcException("key is required")
        return JsonValue.jsString(raw)
    }

    // ---- Pages

    private fun findPage(ref: String): VaultNode =
        try { vault.findPage(ref) } catch (e: Exception) { throw RpcException("No page: $ref") }

    private fun store(node: VaultNode): PageStore = PageStore.open(node.dir, user)

    /** core's lockOf: the node's lock, else the lock file for its id (read fresh). */
    private fun assertWritable(node: VaultNode) {
        if (node.lock != null || vault.lock(node.pageId) != null) throw RpcException(READ_ONLY_MESSAGE)
    }

    private fun dataChanged(node: VaultNode, table: String?) {
        VaultChanges.markChanged("${node.path}/data/$user.sqlite")
        onStoreChanged?.invoke(node.path, table)
    }

    private fun written(node: VaultNode, file: String) {
        VaultChanges.markChanged("${node.path}/$file")
    }

    /**
     * The desktop renderer's navigate: a page (or plain file) path opens as itself, a path
     * inside a page opens that page (the phone has no file view), a page id opens its page.
     */
    fun resolveNavigation(target: String): String? {
        val p = runCatching { VaultStore.normPath(target) }.getOrNull() ?: target
        if (p.isEmpty()) return null
        val nodes = vault.listTree().walked()
        if (nodes.any { it.path == p }) return p
        nodes.filter { it.isPage && p.startsWith(it.path + "/") }.maxByOrNull { it.path.length }?.let { return it.path }
        runCatching { vault.findPage(target) }.getOrNull()?.let { return it.path }
        return p
    }

    /** ipc.mjs publicTree(listTree(vault)): every node without `dir`, in core's field set. */
    fun publicTree(nodes: List<VaultNode>): JsonArray = JsonArray(nodes.map { n ->
        buildJsonObject {
            put("kind", n.kind.raw)
            put("id", n.pageId?.let { JsonPrimitive(it) } ?: JsonNull)
            put("title", n.title)
            put("path", n.path)
            put("children", publicTree(n.children))
            if (!n.isPage) {
                put("lock", JsonNull)
                return@buildJsonObject
            }
            put("entry", n.entry)
            put("source", n.source?.let { JsonPrimitive(it) } ?: JsonNull)
            put("build", n.build?.let { JsonPrimitive(it) } ?: JsonNull)
            put("renderer", n.renderer)
            put("embedHeight", n.embedHeight?.let { JsonPrimitive(it) } ?: JsonNull)
            val b = n.backend
            put("backend", if (b == null) JsonNull else buildJsonObject {
                put("dir", b.dir)
                put("run", JsonObject(b.run.mapValues { JsonPrimitive(it.value) }))
                put("proxy", b.proxy?.let { JsonPrimitive(it) } ?: JsonNull)
            })
            put("format", n.format.raw)
            put("lock", rawLock(n.pageId) ?: JsonNull)
        }
    })

    /** The lock file as JSON (core returns it as is), or null. */
    private fun rawLock(id: String?): JsonObject? {
        if (id.isNullOrEmpty()) return null
        val file = VaultPaths.metaFile(vault.root, "locks/$id.json")
        return runCatching { lenient.parseToJsonElement(file.readText()) as? JsonObject }.getOrNull()
    }

    // ---- save (ipc.mjs save)

    private suspend fun save(node: VaultNode, p: JsonObject): JsonElement {
        assertWritable(node)
        val ok = buildJsonObject { put("ok", true) }
        val markdownBody = p["markdownBody"]?.takeUnless { it is JsonNull }
        if (node.format == VaultNode.Format.MD || markdownBody != null) {
            val body = (markdownBody as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?.let(::unrewrite)
                ?: throw RpcException("save: markdownBody is required for a markdown page")
            val file = File(node.dir, node.entry)
            // The editor never sees frontmatter (it isn't rendered), so carry it over.
            val current = io { runCatching { file.readText() }.getOrNull() }
            var front = ""
            if (current != null) {
                front = try { HostJs.splitFrontmatter(current).first } catch (e: CancellationException) { throw e } catch (e: Exception) { "" }
            }
            val md = front + HostJs.htmlToMarkdown(body)
            io { AtomicFile.write(md, file) }
            written(node, node.entry)
            return ok
        }

        val regions = JsonArray((p["regions"] as? JsonArray ?: JsonArray(emptyList())).filterIsInstance<JsonObject>().map { r ->
            val html = (r["html"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (html == null) r else JsonObject(r + ("html" to JsonPrimitive(unrewrite(html))))
        })
        val regionsJson = regions.toString()
        // A built page's prose lives in its source template; its entry is build output.
        val target = editFile(node)
        val file = File(node.dir, target)
        // Always the RAW live file, never the snapshot and never the served (indexed) copy.
        val raw = io { runCatching { file.readText() }.getOrNull() ?: "" }
        val next = HostJs.applyRegions(raw, regionsJson)
        if (next != raw) {
            io { AtomicFile.write(next, file) }
            written(node, target)
            if (target != node.entry) {
                // Patch the built copy too: the build keeps body markup in place, so the same
                // element numbers line up. (The rebuild itself happens on the Mac.)
                val out = File(node.dir, node.entry)
                val built = io { runCatching { out.readText() }.getOrNull() }
                if (built != null) {
                    val patched = try { HostJs.applyRegions(built, regionsJson) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
                    if (patched != null && io { runCatching { AtomicFile.write(patched, out) }.isSuccess }) {
                        written(node, node.entry)
                    }
                }
            }
        }
        return ok
    }

    /**
     * The page was served with its `quire://` urls on the app's https origin
     * (PageRequestHandler.rewriteQuireUrls); the file keeps `quire://`, which the Mac reads.
     */
    private fun unrewrite(html: String): String =
        html.replace("${PageRequestHandler.ORIGIN}/vault/", "quire://vault/")
            .replace("${PageRequestHandler.ORIGIN}/runtime/", "quire://runtime/")

    /** core's editFile: the `source` template for a built page when it exists, else the entry. */
    private fun editFile(node: VaultNode): String {
        val source = node.source
        if (source != null && File(node.dir, source).exists()) return source
        return node.entry
    }

    // ---- embed.setHeight (ipc.mjs setEmbedHeight)

    private suspend fun setEmbedHeight(node: VaultNode, height: JsonElement?): JsonElement {
        assertWritable(node)
        val h = roundHeight(height)
        // Read whichever manifest the page has; always write the new name, and a page still on
        // the legacy `.quire` moves to `.noteblock` (the old file is removed).
        val existing = io { VaultPaths.manifestFile(node.dir) }
        val file = File(node.dir, VaultPaths.MANIFEST)
        val legacy = existing?.takeIf { it.name != VaultPaths.MANIFEST }
        val current = io { existing?.let { runCatching { it.readText() }.getOrNull() } ?: "" }
        val next = try {
            HostJs.setEmbedHeight(current, h)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw RpcException("Could not update the page's manifest")
        }
        if (next != current || legacy != null) {
            io { AtomicFile.write(next, file) }
            written(node, VaultPaths.MANIFEST)
            if (legacy != null) {
                io { if (!legacy.delete() && legacy.exists()) throw IOException("Could not remove ${legacy.path}") }
                written(node, legacy.name)
            }
        }
        return buildJsonObject { put("height", if (h > 0) JsonPrimitive(h) else JsonNull) }
    }

    /** Math.round(Number(height) || 0), clamped to Int. */
    private fun roundHeight(height: JsonElement?): Int {
        val prim = height as? JsonPrimitive ?: return 0
        if (prim is JsonNull) return 0
        val n: Double = when {
            prim.isString -> prim.content.trim().let { if (it.isEmpty()) 0.0 else it.toDoubleOrNull() ?: 0.0 }
            prim.booleanOrNull != null -> if (prim.booleanOrNull == true) 1.0 else 0.0
            else -> prim.doubleOrNull ?: prim.contentOrNull?.toDoubleOrNull() ?: 0.0
        }
        if (!n.isFinite()) return 0
        val r = floor(n + 0.5)
        return r.coerceIn(Int.MIN_VALUE.toDouble(), Int.MAX_VALUE.toDouble()).toInt()
    }
}
