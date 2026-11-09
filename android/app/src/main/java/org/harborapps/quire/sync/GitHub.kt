package org.harborapps.quire.sync

import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.UnknownHostException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** Port of SyncError (ios/Quire/Sync/GitHub.swift). `message` is the user-facing text. */
sealed class SyncException(text: String) : Exception(text) {
    override val message: String get() = super.message ?: ""

    data object Offline : SyncException("You're offline.")

    data object BadToken : SyncException("GitHub didn't accept the token. Make a new one with the repo scope.")

    data object NotFound : SyncException("GitHub can't find that repo or branch. Check the name, and that the token has the repo scope.")

    class RateLimited(val remaining: String, val reset: Instant?) : SyncException(rateText(remaining, reset))

    data object RefMoved : SyncException("The repo changed while pushing.")

    /** `msg` is GitHub's `message` field (Swift: `.http(code, msg)`). */
    class Http(val code: Int, val msg: String) :
        SyncException(if (msg.isEmpty()) "GitHub answered $code." else "GitHub answered $code: $msg")

    /** Swift: `.message(text)`. */
    class Message(val text: String) : SyncException(text)

    companion object {
        private fun rateText(left: String, reset: Instant?): String {
            val `when` = reset?.let {
                val t = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(it)
                " It resets at $t."
            } ?: ""
            return "GitHub's rate limit is used up ($left requests left).$`when`"
        }
    }
}

/** owner/repo from "owner/repo", "github.com/owner/repo", an https or ssh URL, with or without .git. */
fun parseRepoInput(raw: String): Pair<String, String>? {
    var s = raw.trim()
    for (prefix in listOf("https://", "http://", "git@", "ssh://git@")) {
        if (s.lowercase().startsWith(prefix)) s = s.drop(prefix.length)
    }
    if (s.lowercase().startsWith("www.")) s = s.drop(4)
    if (s.lowercase().startsWith("github.com")) s = s.drop("github.com".length)
    s = s.trim(':', '/')
    if (s.endsWith(".git")) s = s.dropLast(4)
    val parts = s.split("/").filter { it.isNotEmpty() }
    if (parts.size < 2) return null
    val re = Regex("^[A-Za-z0-9._-]+$")
    if (!re.matches(parts[0]) || !re.matches(parts[1])) return null
    return parts[0] to parts[1]
}

data class CompareFile(
    val filename: String,
    val status: String,
    val sha: String?,
    val previous: String?,
)

data class RepoInfo(val defaultBranch: String, val canPush: Boolean)

data class GitHubUser(val login: String, val id: Int)

/** Any Kotlin value (Map, List, String, Number, Boolean, null, JsonElement) as a JsonElement. */
fun jsonOf(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k.toString() to jsonOf(v) })
    is Iterable<*> -> JsonArray(value.map { jsonOf(it) })
    is Array<*> -> JsonArray(value.map { jsonOf(it) })
    else -> JsonPrimitive(value.toString())
}

private fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** The GitHub REST calls sync needs. Paths are relative to api.github.com. */
class GitHubClient(val token: String, val owner: String, val repo: String) {

    private val base: String get() = "/repos/$owner/$repo"

    companion object {
        /** URLSession ephemeral: 60 s per request (idle), 600 s per resource. No cache, no cookies. */
        internal val http: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(60, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .callTimeout(600, TimeUnit.SECONDS)
            .build()

        private val json = Json { ignoreUnknownKeys = true }
        private val JSON_TYPE = "application/json".toMediaType()

        /** urlPathAllowed minus ?#%; — unreserved plus !$&'()*+,=:@ (and "/" between segments). */
        private const val PATH_EXTRA = "-._~!$&'()*+,=:@"

        private fun encodeSegment(seg: String): String {
            val sb = StringBuilder()
            for (b in seg.toByteArray(Charsets.UTF_8)) {
                val c = b.toInt() and 0xff
                val ch = c.toChar()
                if (c < 0x80 && (ch.isLetterOrDigit() || PATH_EXTRA.indexOf(ch) >= 0)) sb.append(ch)
                else sb.append('%').append("%02X".format(c))
            }
            return sb.toString()
        }

        /** Percent-encode a vault path segment by segment. */
        fun encodePath(p: String): String = p.split("/").joinToString("/") { encodeSegment(it) }

        /** Network failures that mean "no connection" (URLError's offline codes). */
        internal fun mapTransport(e: Throwable): Throwable = when (e) {
            is SyncException -> e
            is SSLException -> e
            is UnknownHostException, is ConnectException, is NoRouteToHostException,
            is InterruptedIOException, is SocketException -> SyncException.Offline
            else -> e
        }

        internal fun check(code: Int, headers: Headers, body: ByteArray) {
            if (code in 200..299) return
            val msg = try {
                (json.parseToJsonElement(body.toString(Charsets.UTF_8)) as? JsonObject)?.str("message") ?: ""
            } catch (_: Exception) {
                ""
            }
            val remaining = headers["X-RateLimit-Remaining"]
            when (code) {
                401 -> throw SyncException.BadToken
                403, 429 -> {
                    if (remaining == "0" || code == 429 || msg.lowercase().contains("rate limit")) {
                        val reset = headers["X-RateLimit-Reset"]?.toDoubleOrNull()?.let {
                            Instant.ofEpochMilli((it * 1000).toLong())
                        }
                        throw SyncException.RateLimited(remaining ?: "0", reset)
                    }
                    throw SyncException.Http(code, msg)
                }
                404 -> throw SyncException.NotFound
                else -> throw SyncException.Http(code, msg)
            }
        }
    }

    private fun request(
        method: String,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        accept: String = "application/vnd.github+json",
        json: Any? = null,
    ): Request {
        val url = ("https://api.github.com$path").toHttpUrlOrNull()?.newBuilder()?.apply {
            for ((k, v) in query) addQueryParameter(k, v)
        }?.build() ?: throw SyncException.Message("Bad request path $path")
        val body = json?.let { jsonOf(it).toString().toRequestBody(JSON_TYPE) }
            ?: if (method == "POST" || method == "PATCH" || method == "PUT") ByteArray(0).toRequestBody(null) else null
        return Request.Builder()
            .url(url)
            .method(method, body)
            .header("Authorization", "Bearer $token")
            .header("Accept", accept)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "Quire-Android")
            .build()
    }

    private suspend fun send(req: Request): Pair<ByteArray, Response> = withContext(Dispatchers.IO) {
        try {
            http.newCall(req).execute().use { resp ->
                val data = resp.body?.bytes() ?: ByteArray(0)
                check(resp.code, resp.headers, data)
                data to resp
            }
        } catch (e: IOException) {
            throw mapTransport(e)
        }
    }

    private suspend fun obj(req: Request): JsonObject {
        val (data, _) = send(req)
        val el = try {
            json.parseToJsonElement(data.toString(Charsets.UTF_8))
        } catch (_: Exception) {
            null
        }
        return el as? JsonObject ?: throw SyncException.Message("GitHub sent something unexpected.")
    }

    // Endpoints

    /** GET /repos/:o/:r — the default branch and whether the token can push. */
    suspend fun repoInfo(): RepoInfo {
        val o = obj(request("GET", base))
        val branch = o.str("default_branch") ?: "main"
        val push = ((o["permissions"] as? JsonObject)?.get("push") as? JsonPrimitive)?.booleanOrNull ?: true
        return RepoInfo(branch, push)
    }

    suspend fun user(): GitHubUser {
        val o = obj(request("GET", "/user"))
        return GitHubUser(o.str("login") ?: "", (o["id"] as? JsonPrimitive)?.longOrNull?.toInt() ?: 0)
    }

    /** The branch's head commit sha (Accept: vnd.github.sha returns the bare sha). */
    suspend fun headSha(branch: String): String {
        val (data, _) = send(request("GET", "$base/commits/${encodePath(branch)}", accept = "application/vnd.github.sha"))
        val sha = data.toString(Charsets.UTF_8).trim()
        if (sha.length != 40) throw SyncException.Message("GitHub didn't return a commit for $branch.")
        return sha
    }

    suspend fun treeSha(ofCommit: String): String {
        val o = obj(request("GET", "$base/git/commits/$ofCommit"))
        return (o["tree"] as? JsonObject)?.str("sha") ?: throw SyncException.Message("Commit $ofCommit has no tree.")
    }

    /**
     * Changed files between two commits. Returns null when GitHub caps the list (300 files),
     * so the caller falls back to a tarball.
     */
    suspend fun compare(from: String, to: String): List<CompareFile>? {
        val files = mutableListOf<CompareFile>()
        var page = 1
        while (true) {
            val o = obj(request("GET", "$base/compare/$from...$to", query = listOf("per_page" to "100", "page" to page.toString())))
            val raw = (o["files"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
            if (raw.size >= 300) return null
            for (f in raw) {
                val name = f.str("filename") ?: continue
                val status = f.str("status") ?: continue
                files.add(CompareFile(name, status, f.str("sha"), f.str("previous_filename")))
            }
            // Files are paged alongside commits; keep going while a page of commits is full.
            val commits = (o["commits"] as? JsonArray)?.size ?: 0
            val total = (o["total_commits"] as? JsonPrimitive)?.longOrNull?.toInt() ?: 0
            if (commits < 100 || page * 100 >= total || raw.isEmpty()) break
            page += 1
            if (page > 20) return null
        }
        // A path can show up on several pages; the last mention wins.
        val seen = HashSet<String>()
        val result = files.asReversed().filter { seen.add(it.filename) }.asReversed()
        return if (result.size >= 300) null else result
    }

    /** A file's bytes at `ref`, via the contents API's raw media type. */
    suspend fun raw(path: String, ref: String): ByteArray {
        val (data, _) = send(request("GET", "$base/contents/${encodePath(path)}", query = listOf("ref" to ref), accept = "application/vnd.github.raw"))
        return data
    }

    /** GET /tarball/:ref (redirects to codeload) into a temp file the caller removes. */
    suspend fun downloadTarball(ref: String): File = withContext(Dispatchers.IO) {
        val req = request("GET", "$base/tarball/${encodePath(ref)}")
        try {
            http.newCall(req).execute().use { resp ->
                if (resp.code !in 200..299) {
                    val body = resp.body?.bytes() ?: ByteArray(0)
                    check(resp.code, resp.headers, body)
                }
                val dest = File.createTempFile("quire-", ".tar.gz")
                try {
                    resp.body?.byteStream()?.use { input -> dest.outputStream().use { input.copyTo(it, 1 shl 16) } }
                } catch (e: Throwable) {
                    dest.delete()
                    throw e
                }
                dest
            }
        } catch (e: IOException) {
            throw mapTransport(e)
        }
    }

    suspend fun createBlob(data: ByteArray): String {
        val o = obj(request("POST", "$base/git/blobs", json = mapOf("content" to Base64.getEncoder().encodeToString(data), "encoding" to "base64")))
        return o.str("sha") ?: throw SyncException.Message("GitHub didn't make the blob.")
    }

    /** `entries` are tree entries ({path, mode, type, sha}); a null sha deletes the path. */
    suspend fun createTree(base: String, entries: List<Map<String, Any?>>): String {
        val o = obj(request("POST", "${this.base}/git/trees", json = mapOf("base_tree" to base, "tree" to entries)))
        return o.str("sha") ?: throw SyncException.Message("GitHub didn't make the tree.")
    }

    suspend fun createCommit(message: String, tree: String, parent: String, author: Map<String, String>): String {
        val o = obj(request("POST", "$base/git/commits", json = mapOf("message" to message, "tree" to tree, "parents" to listOf(parent), "author" to author)))
        return o.str("sha") ?: throw SyncException.Message("GitHub didn't make the commit.")
    }

    /** Fast-forward the branch. A 422 means someone pushed first: SyncException.RefMoved. */
    suspend fun updateRef(branch: String, to: String) {
        try {
            send(request("PATCH", "$base/git/refs/heads/${encodePath(branch)}", json = mapOf("sha" to to, "force" to false)))
        } catch (e: SyncException.Http) {
            if (e.code == 422) throw SyncException.RefMoved
            throw e
        }
    }
}
