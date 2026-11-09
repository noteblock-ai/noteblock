package org.harborapps.quire.sync

import java.io.File
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import org.harborapps.quire.app.QuireApp
import org.harborapps.quire.vault.VaultEvents
import org.harborapps.quire.vault.VaultPaths

/** An Instant as an ISO-8601 string, like JSONEncoder's `.iso8601` ("2026-10-23T14:03:00Z"). */
object Iso8601InstantSerializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("Iso8601Instant", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: Instant) {
        encoder.encodeString(DateTimeFormatter.ISO_INSTANT.format(value.truncatedTo(ChronoUnit.SECONDS)))
    }

    override fun deserialize(decoder: Decoder): Instant = Instant.parse(decoder.decodeString())
}

/** The connected repo, kept in no-backup app storage (never in the vault, so it isn't synced). */
@Serializable
data class SyncConfig(
    val owner: String,
    val repo: String,
    val branch: String,
    /** The vault folder (under VaultPaths.vaultsDir) this repo syncs into. */
    val folder: String,
    val login: String? = null,
    val userId: Int? = null,
    @Serializable(with = Iso8601InstantSerializer::class)
    val lastSyncAt: Instant? = null,
    val conflicts: List<SyncConflict> = emptyList(),
) {
    val fullName: String get() = "$owner/$repo"
}

/**
 * A file changed on both sides. The remote version sits at `path`; this phone's version was
 * written beside it as `copy`.
 */
@Serializable
data class SyncConflict(
    val path: String,
    val copy: String,
    @Serializable(with = Iso8601InstantSerializer::class)
    val at: Instant,
) {
    val id: String get() = copy
}

/** Size, mtime and exec bit let a scan skip re-hashing files that didn't change. */
@Serializable
data class ManifestEntry(
    /** git blob sha */
    val s: String,
    /** size in bytes */
    val z: Long,
    /** mtime, seconds since 1970 */
    val m: Double,
    /** owner-exec bit */
    val x: Boolean? = null,
)

/**
 * The last synced commit and, for every tracked file, the blob sha it had at that commit.
 * A local file whose sha differs from its entry was changed on this phone since.
 */
@Serializable
data class SyncState(
    val sha: String,
    val files: Map<String, ManifestEntry>,
)

object SyncStore {
    @OptIn(ExperimentalSerializationApi::class)
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    /** Not backed up (like Application Support kept out of the vault on iOS). */
    val dir: File get() = File(QuireApp.context.noBackupFilesDir, "Sync")

    private val configFile: File get() = File(dir, "config.json")
    private val stateFile: File get() = File(dir, "state.json")

    /** Temp file in the same folder, then rename over the target. */
    @Throws(IOException::class)
    private fun writeAtomic(text: String, file: File) {
        val d = file.parentFile ?: throw IOException("No parent for ${file.path}")
        if (!d.isDirectory && !d.mkdirs()) throw IOException("Couldn't create ${d.path}")
        val tmp = File(d, ".${file.name}.${System.nanoTime()}.tmp")
        try {
            tmp.outputStream().use { out ->
                out.write(text.toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            try {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }

    private inline fun <reified T> read(file: File): T? = try {
        json.decodeFromString<T>(file.readText(Charsets.UTF_8))
    } catch (_: Exception) {
        null
    }

    fun loadConfig(): SyncConfig? = read(configFile)

    @Throws(IOException::class)
    fun saveConfig(c: SyncConfig) = writeAtomic(json.encodeToString(SyncConfig.serializer(), c), configFile)

    fun loadState(): SyncState? = read(stateFile)

    @Throws(IOException::class)
    fun saveState(s: SyncState) = writeAtomic(json.encodeToString(SyncState.serializer(), s), stateFile)

    /** Forget the repo, the synced state and the token. The vault folder stays. */
    fun clear() {
        configFile.delete()
        stateFile.delete()
        TokenStore.deleteToken()
    }
}

/**
 * Which vault folder is open. VaultModel reads the same prefs key (VaultPaths.CURRENT_KEY) and
 * reopens on VaultEvents.selected.
 */
object VaultSelection {
    val current: String? get() = QuireApp.prefs.getString(VaultPaths.CURRENT_KEY, null)

    fun select(folder: String) {
        QuireApp.prefs.edit().putString(VaultPaths.CURRENT_KEY, folder).commit()
        VaultEvents.postSelected()
    }
}
