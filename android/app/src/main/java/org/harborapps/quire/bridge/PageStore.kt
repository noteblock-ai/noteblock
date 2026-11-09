package org.harborapps.quire.bridge

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.harborapps.quire.app.QuireApp
import java.io.File
import java.security.SecureRandom

/**
 * A page's own data, the phone side of core/store.mjs: one SQLite file per page per user,
 * `<page dir>/data/<user>.sqlite`, with the SAME schema, row shape and ids, so a file copied
 * between the Mac and the phone opens on either:
 *
 *     rows (tbl TEXT, id TEXT, data TEXT JSON, created INTEGER ms, updated INTEGER ms,
 *           PRIMARY KEY (tbl, id))
 *     kv   (key TEXT PRIMARY KEY, value TEXT JSON)
 *
 * A row as pages see it (core's toRow): the stored JSON object, plus `id`, `_created` and
 * `_updated` (numbers, ms since 1970). Handles are cached per file for the app's life, WAL
 * mode, busy_timeout 2000, like the Mac. Thread-safe (one lock per store). Port of
 * ios/Quire/Bridge/PageStore.swift. Errors are [RpcException] with the Swift's messages
 * ("SQLite: …", "No row <id> in <table>", "table must be a non-empty string").
 */
class PageStore private constructor(val file: File) {
    private var db: SQLiteDatabase? = null
    private val lock = Any()

    init {
        val handle = try {
            // NO_LOCALIZED_COLLATORS: no android_metadata table, so the file matches the Mac's.
            SQLiteDatabase.openDatabase(
                file.path, null,
                SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY or
                    SQLiteDatabase.NO_LOCALIZED_COLLATORS or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING,
            )
        } catch (e: SQLiteException) {
            throw RpcException("SQLite: ${e.message ?: "could not open ${file.name}"}")
        }
        db = handle
        sqlite {
            // ENABLE_WRITE_AHEAD_LOGGING already sets it; the pragma makes it explicit like core.
            handle.rawQuery("PRAGMA journal_mode=WAL", null).use { it.moveToFirst() }
            handle.rawQuery("PRAGMA busy_timeout=2000", null).use { it.moveToFirst() }
            handle.execSQL(
                """
                CREATE TABLE IF NOT EXISTS rows (
                      tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
                      created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (tbl, id))
                """.trimIndent(),
            )
            handle.execSQL("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")
        }
    }

    /** Close the handle and drop it from the cache (core's close()). */
    fun close() {
        synchronized(lock) {
            db?.close()
            db = null
        }
        synchronized(cache) { if (cache[file.path] === this) cache.remove(file.path) }
    }

    // ---- Rows

    fun all(table: String): List<JsonObject> {
        checkTable(table)
        return locked { db ->
            db.rawQuery(
                "SELECT tbl, id, data, created, updated FROM rows WHERE tbl = ? ORDER BY created, rowid",
                arrayOf(table),
            ).use { c -> buildList { while (c.moveToNext()) add(toRow(c)) } }
        }
    }

    /** The row, or null. */
    fun get(table: String, id: String): JsonObject? {
        checkTable(table)
        return locked { getRow(it, table, id) }
    }

    /** Insert `obj` (meta keys dropped); `obj.id` is kept when given, else a new id. */
    fun insert(table: String, obj: JsonObject): JsonObject {
        checkTable(table)
        val given = obj["id"]?.takeIf { it !is JsonNull }?.let { JsonValue.jsString(it) } ?: ""
        val id = given.ifEmpty { newId() }
        val now = nowMs()
        return locked { db ->
            db.execSQL(
                "INSERT INTO rows (tbl, id, data, created, updated) VALUES (?, ?, ?, ?, ?)",
                arrayOf<Any>(table, id, JsonValue.stringify(strip(obj)), now, now),
            )
            getRow(db, table, id) ?: throw RpcException("No row $id in $table")
        }
    }

    /** Merge `patch` (meta keys dropped) into the row's data. Throws "No row <id> in <table>". */
    fun update(table: String, id: String, patch: JsonObject): JsonObject {
        checkTable(table)
        return locked { db ->
            val raw = db.rawQuery("SELECT data FROM rows WHERE tbl = ? AND id = ?", arrayOf(table, id)).use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
            } ?: throw RpcException("No row $id in $table")
            val data = LinkedHashMap<String, JsonElement>(parseObject(raw))
            for ((k, v) in strip(patch)) data[k] = v
            db.execSQL(
                "UPDATE rows SET data = ?, updated = ? WHERE tbl = ? AND id = ?",
                arrayOf<Any>(JsonValue.stringify(JsonObject(data)), nowMs(), table, id),
            )
            getRow(db, table, id) ?: throw RpcException("No row $id in $table")
        }
    }

    fun remove(table: String, id: String): Boolean {
        checkTable(table)
        locked { it.execSQL("DELETE FROM rows WHERE tbl = ? AND id = ?", arrayOf<Any>(table, id)) }
        return true
    }

    // ---- kv

    /** The parsed value, or [JsonNull] (JS null) when unset. */
    fun kvGet(key: String): JsonElement = locked { db ->
        val raw = db.rawQuery("SELECT value FROM kv WHERE key = ?", arrayOf(key)).use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
        } ?: return@locked JsonNull
        try { JsonValue.parse(raw) } catch (e: Exception) { throw RpcException(e.message ?: "Bad JSON in kv $key") }
    }

    fun kvSet(key: String, value: JsonElement?): Boolean {
        val json = JsonValue.stringify(value ?: JsonNull)
        locked { db ->
            // core uses INSERT … ON CONFLICT DO UPDATE; upsert needs SQLite 3.24 (API 30+) and
            // minSdk is 26, so INSERT OR REPLACE, which leaves the same (key, value) row.
            db.execSQL("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", arrayOf<Any>(key, json))
        }
        return true
    }

    fun tables(): List<String> = locked { db ->
        db.rawQuery("SELECT DISTINCT tbl FROM rows ORDER BY tbl", null).use { c ->
            buildList { while (c.moveToNext()) if (!c.isNull(0)) add(c.getString(0)) }
        }
    }

    // ---- SQLite

    private fun <T> locked(body: (SQLiteDatabase) -> T): T = synchronized(lock) {
        val handle = db ?: throw RpcException("Store is closed: ${file.name}")
        sqlite { body(handle) }
    }

    private fun getRow(db: SQLiteDatabase, table: String, id: String): JsonObject? =
        db.rawQuery("SELECT tbl, id, data, created, updated FROM rows WHERE tbl = ? AND id = ?", arrayOf(table, id))
            .use { c -> if (c.moveToFirst()) toRow(c) else null }

    companion object {
        private val meta = setOf("id", "_created", "_updated")
        private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
        private val random = SecureRandom()
        private val cache = HashMap<String, PageStore>()

        /**
         * The device's store user: the file is `data/<user>.sqlite`. Like iOS ("iphone"/"ipad",
         * from the model, never the renameable device name), a fixed "android", so renaming the
         * phone never moves its data. The `quire.user` pref overrides it (a second device).
         */
        val currentUser: String by lazy {
            val prefs = runCatching { QuireApp.prefs }.getOrNull()
            prefs?.getString("quire.user", null)?.let(::slug)?.takeIf { it.isNotEmpty() } ?: "android"
        }

        /** core's currentUser() sanitising: lowercase, keep [a-z0-9_-]. */
        fun slug(s: String): String =
            s.lowercase().filter { it in 'a'..'z' || it in '0'..'9' || it == '_' || it == '-' }

        /** `len` chars of [a-z0-9], unbiased (bytes ≥ 252 are skipped), like core's newId. */
        fun newId(len: Int = 10): String {
            val out = StringBuilder()
            while (out.length < len) {
                val bytes = ByteArray(len * 2)
                random.nextBytes(bytes)
                for (signed in bytes) {
                    val b = signed.toInt() and 0xff
                    if (b >= 252) continue
                    out.append(ALPHABET[b % 36])
                    if (out.length == len) break
                }
            }
            return out.toString()
        }

        /** The store for `pageDir` and `user`, creating `data/` and the file on first use. */
        fun open(pageDir: File, user: String = currentUser): PageStore {
            val file = File(File(pageDir.absoluteFile.normalize(), "data"), "$user.sqlite")
            synchronized(cache) {
                cache[file.path]?.let { return it }
                val dir = file.parentFile!!
                if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) {
                    throw RpcException("Could not create ${dir.path}")
                }
                val store = PageStore(file)
                cache[file.path] = store
                return store
            }
        }

        /** Close every cached handle (before sync replaces files, tests). */
        fun closeAll() {
            val all = synchronized(cache) { cache.values.toList().also { cache.clear() } }
            all.forEach { it.close() }
        }

        fun strip(obj: JsonObject): JsonObject = JsonObject(obj.filterKeys { it !in meta })

        /** core's toRow: the data object, then id, _created, _updated. */
        private fun toRow(c: Cursor): JsonObject {
            val raw = c.getString(c.getColumnIndexOrThrow("data")) ?: "{}"
            val row = LinkedHashMap<String, JsonElement>(parseObject(raw))
            row.remove("id"); row.remove("_created"); row.remove("_updated")
            row["id"] = JsonPrimitive(c.getString(c.getColumnIndexOrThrow("id")) ?: "")
            row["_created"] = JsonPrimitive(c.getLong(c.getColumnIndexOrThrow("created")))
            row["_updated"] = JsonPrimitive(c.getLong(c.getColumnIndexOrThrow("updated")))
            return JsonObject(row)
        }

        private fun parseObject(raw: String): JsonObject =
            runCatching { JsonValue.parse(raw) as? JsonObject }.getOrNull() ?: JsonObject(emptyMap())

        fun checkTable(table: String) {
            if (table.isEmpty()) throw RpcException("table must be a non-empty string")
        }

        private fun nowMs(): Long = System.currentTimeMillis()

        private inline fun <T> sqlite(body: () -> T): T = try {
            body()
        } catch (e: SQLiteException) {
            throw RpcException("SQLite: ${e.message}")
        }
    }
}
