package org.harborapps.quire.sync

import android.os.Build
import android.provider.Settings
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import java.io.File
import java.text.NumberFormat
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.harborapps.quire.app.QuireApp
import org.harborapps.quire.bridge.VaultChanges
import org.harborapps.quire.vault.VaultEvents
import org.harborapps.quire.vault.VaultPaths

/** What the vault footer shows. */
data class SyncStatus(
    /** "Synced 2 min ago", "Syncing…", "Not set up", "Offline", "Sync failed — tap for details". */
    val text: String = "Not set up",
    /** Green dot when true, grey otherwise. */
    val healthy: Boolean = false,
    val syncing: Boolean = false,
    val setUp: Boolean = false,
)

/**
 * Vault sync with its GitHub remote over the GitHub REST API (port of ios/Quire/Sync/Sync.swift).
 * The repo and branch live in SyncStore's config.json, the last synced commit and manifest in
 * state.json, the token in TokenStore. See SyncRunner for the pull/push rules.
 *
 * Every StateFlow is written on the main thread; network and disk work runs on Dispatchers.IO.
 */
object SyncEngine {
    private const val CHECK_EVERY_MS = 300_000L
    private const val TICK_MS = 30_000L
    private const val FOREGROUND_RECHECK_MS = 10_000L

    private enum class Failure { OFFLINE, FAILED }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _config = MutableStateFlow<SyncConfig?>(null)
    private val _conflicts = MutableStateFlow<List<SyncConflict>>(emptyList())
    private val _status = MutableStateFlow(SyncStatus())
    private val _lastError = MutableStateFlow<String?>(null)
    private val _phase = MutableStateFlow<String?>(null)

    /** One line for the vault footer, plus the dot and the syncing flag. */
    val status: StateFlow<SyncStatus> = _status
    /** The last failure, in plain words (rate limits include the requests left). */
    val lastError: StateFlow<String?> = _lastError
    /** Files changed on both sides that haven't been looked at yet. */
    val conflicts: StateFlow<List<SyncConflict>> = _conflicts
    /** What a running sync or connect is doing: "Downloading…", "Pushing 2 changes…". */
    val phase: StateFlow<String?> = _phase
    val config: StateFlow<SyncConfig?> = _config

    val isSetUp: Boolean get() = _config.value != null

    /** The vault folder this repo syncs into. */
    val vaultRoot: File? get() = _config.value?.let { File(VaultPaths.vaultsDir, it.folder) }

    private var failure: Failure? = null
    private var syncing = false
    private var running: Job? = null
    private var ticker: Job? = null
    private var lastAttempt = 0L
    private var started = false

    init {
        var c = SyncStore.loadConfig()
        if (c != null && TokenStore.token() == null) c = null // token gone (restored backup): not set up
        _config.value = c
        _conflicts.value = c?.conflicts ?: emptyList()
        refreshStatus()
    }

    // Auto sync: on foreground, then every 5 min while in the foreground

    /** Start watching the app's foreground state. Safe to call more than once. */
    fun start() {
        scope.launch {
            if (started) return@launch
            started = true
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) = becameActive()
                override fun onStop(owner: LifecycleOwner) = resignedActive()
            })
        }
    }

    private fun now() = System.currentTimeMillis()

    private fun becameActive() {
        ticker?.cancel()
        ticker = scope.launch {
            while (isActive) {
                delay(TICK_MS)
                refreshStatus()
                if (isSetUp && now() - lastAttempt >= CHECK_EVERY_MS) syncAndWait()
            }
        }
        refreshStatus()
        // Coming back to the app always checks, unless a sync just ran.
        if (isSetUp && now() - lastAttempt > FOREGROUND_RECHECK_MS) syncNow()
    }

    private fun resignedActive() {
        ticker?.cancel()
        ticker = null
    }

    // Sync

    /** Pull then push now (no-op when not set up). */
    fun syncNow() {
        scope.launch { syncAndWait() }
    }

    /**
     * Pull, then push local changes. Safe to call often; does nothing when not set up. While a
     * sync is running, waits for it instead of starting another.
     */
    suspend fun syncAndWait() {
        withContext(Dispatchers.Main.immediate) {
            running?.let { it.join(); return@withContext }
            val c = _config.value
            val token = c?.let { withContext(Dispatchers.IO) { TokenStore.token() } }
            val root = vaultRoot
            if (c == null || token == null || root == null) { refreshStatus(); return@withContext }
            val state = withContext(Dispatchers.IO) { SyncStore.loadState() }
            if (state == null) {
                fail(SyncException.Message("This vault's sync record is missing. Disconnect and connect again."))
                return@withContext
            }
            if (running != null) { running?.join(); return@withContext } // started while we read
            lastAttempt = now()
            val gh = GitHubClient(token, c.owner, c.repo)
            val author = authorInfo(c)
            val job = scope.launch {
                syncing = true
                refreshStatus()
                try {
                    val runner = SyncRunner(gh, root, c.branch, state, author) { p -> postPhase(p) }
                    val outcome = runner.run()
                    finished(outcome)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    fail(e)
                } finally {
                    syncing = false
                    _phase.value = null
                    running = null
                    refreshStatus()
                }
            }
            running = job
            job.join()
        }
    }

    /** SyncRunner reports progress from an IO thread; hop to main. */
    private fun postPhase(p: String) {
        scope.launch(Dispatchers.Main) { if (syncing) _phase.value = p }
    }

    private suspend fun finished(outcome: SyncRunner.Outcome) {
        failure = null
        _lastError.value = null
        // The push went through: everything the phone wrote is on the remote now.
        VaultChanges.clear()
        val cur = _config.value ?: return
        val c = cur.copy(
            lastSyncAt = Instant.now(),
            conflicts = if (outcome.conflicts.isEmpty()) cur.conflicts else cur.conflicts + outcome.conflicts,
        )
        _config.value = c
        _conflicts.value = c.conflicts
        withContext(Dispatchers.IO) { runCatching { SyncStore.saveConfig(c) } }
        if (outcome.pulled.isNotEmpty() || outcome.conflicts.isNotEmpty()) VaultEvents.postChanged()
    }

    private fun fail(e: Throwable) {
        if (e is SyncException.Offline) {
            failure = Failure.OFFLINE
            _lastError.value = SyncException.Offline.message
        } else {
            failure = Failure.FAILED
            _lastError.value = describe(e)
        }
        refreshStatus()
    }

    private fun describe(e: Throwable): String =
        e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName

    private fun deviceName(): String {
        val name = try {
            Settings.Global.getString(QuireApp.context.contentResolver, Settings.Global.DEVICE_NAME)
        } catch (_: Exception) {
            null
        }
        return name?.takeIf { it.isNotBlank() } ?: Build.MODEL ?: "Android"
    }

    private fun authorInfo(c: SyncConfig): Map<String, String> {
        val login = c.login
        val id = c.userId
        val email = if (!login.isNullOrEmpty() && id != null && id > 0) {
            "$id+$login@users.noreply.github.com"
        } else {
            "android@quire.local"
        }
        return mapOf(
            "name" to deviceName(),
            "email" to email,
            "date" to DateTimeFormatter.ISO_INSTANT.format(Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS)),
        )
    }

    private fun refreshStatus() {
        val setUp = isSetUp
        _status.value = when {
            !setUp -> SyncStatus("Not set up", healthy = false, syncing = syncing, setUp = false)
            syncing -> SyncStatus("Syncing…", healthy = failure == null, syncing = true, setUp = true)
            failure == Failure.OFFLINE -> SyncStatus("Offline", healthy = false, setUp = true)
            failure == Failure.FAILED -> SyncStatus("Sync failed — tap for details", healthy = false, setUp = true)
            else -> {
                val at = _config.value?.lastSyncAt
                if (at != null) SyncStatus(syncedText(at), healthy = true, setUp = true)
                else SyncStatus("Not synced yet", healthy = false, setUp = true)
            }
        }
    }

    fun syncedText(d: Instant, now: Instant = Instant.now()): String {
        val s = Duration.between(d, now).seconds
        if (s < 60) return "Synced just now"
        if (s < 3600) return "Synced ${s / 60} min ago"
        if (s < 86400) return "Synced ${s / 3600} hr ago"
        val f = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withZone(ZoneId.systemDefault())
        return "Synced " + f.format(d)
    }

    // Connect / disconnect

    /**
     * Check the repo and token, clone the branch into a new vault folder named after the repo
     * and make it the current vault. Throws SyncException with a plain-words message.
     */
    suspend fun connect(repo: String, token: String) {
        withContext(Dispatchers.Main.immediate) {
            if (running != null) throw SyncException.Message("A sync is running. Try again in a moment.")
            val parsed = parseRepoInput(repo)
                ?: throw SyncException.Message("Enter the repo as owner/repo, like you/field-notes.")
            val (owner, name) = parsed
            val tok = token.trim()
            if (tok.isEmpty()) throw SyncException.Message("Paste a GitHub token.")
            val gh = GitHubClient(tok, owner, name)

            val job = scope.async {
                syncing = true
                _phase.value = "Checking the repo…"
                refreshStatus()
                try {
                    val info = try {
                        gh.repoInfo()
                    } catch (_: SyncException.NotFound) {
                        throw SyncException.Message("Can't find $owner/$name. Check the name, and that the token has the repo scope.")
                    }
                    if (!info.canPush) throw SyncException.Message("This token can read $owner/$name but can't push to it.")
                    val me = try { gh.user() } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
                    val folder = withContext(Dispatchers.IO) { freeFolderName(name) }
                    val root = File(VaultPaths.vaultsDir, folder)
                    try {
                        SyncRunner.clone(gh, info.defaultBranch, root, name) { p -> postPhase(p) }
                    } catch (e: Throwable) {
                        withContext(Dispatchers.IO) { root.deleteRecursively() }
                        if (e is SyncException.NotFound) throw SyncException.Message("$owner/$name has no commits on ${info.defaultBranch} yet.")
                        if (e is SyncException.Http && e.code == 409) throw SyncException.Message("$owner/$name is empty. Push the vault from your Mac first.")
                        throw e
                    }
                    val c = SyncConfig(
                        owner = owner, repo = name, branch = info.defaultBranch, folder = folder,
                        login = me?.login, userId = me?.id, lastSyncAt = Instant.now(), conflicts = emptyList(),
                    )
                    withContext(Dispatchers.IO) {
                        TokenStore.setToken(tok)
                        SyncStore.saveConfig(c)
                    }
                    _config.value = c
                    _conflicts.value = emptyList()
                    failure = null
                    _lastError.value = null
                    lastAttempt = now()
                    withContext(Dispatchers.IO) { VaultSelection.select(folder) }
                    VaultEvents.postChanged()
                } finally {
                    syncing = false
                    _phase.value = null
                    running = null
                    refreshStatus()
                }
            }
            running = job
            try {
                job.await()
            } catch (e: CancellationException) {
                throw SyncException.Message("Connecting was cancelled.")
            } catch (e: SyncException) {
                throw e
            } catch (e: Exception) {
                throw SyncException.Message(describe(e))
            }
        }
    }

    private fun freeFolderName(repo: String): String {
        val dir = VaultPaths.vaultsDir
        var i = 1
        while (true) {
            val n = if (i == 1) repo else "$repo $i"
            if (!File(dir, n).exists()) return n
            i++
        }
    }

    /** Forget the repo and token. The vault folder stays on the phone. */
    fun disconnect() {
        running?.cancel()
        running = null
        syncing = false
        _phase.value = null
        _config.value = null
        _conflicts.value = emptyList()
        failure = null
        _lastError.value = null
        refreshStatus()
        scope.launch(Dispatchers.IO) { SyncStore.clear() }
    }

    // Conflicts

    /** "Keep both": both files stay, the note goes away. */
    fun dismissConflict(c: SyncConflict) {
        val cfg = _config.value ?: return
        val next = cfg.copy(conflicts = cfg.conflicts.filter { it.id != c.id })
        _config.value = next
        _conflicts.value = next.conflicts
        scope.launch(Dispatchers.IO) { runCatching { SyncStore.saveConfig(next) } }
    }

    /** The remote version (in place) and this phone's version (the conflict copy), as text. Reads disk. */
    fun texts(c: SyncConflict): Pair<String, String> {
        val root = vaultRoot ?: return "" to ""
        fun read(rel: String): String {
            val f = VaultFiles.url(root, rel)
            val d = try { f.readBytes() } catch (_: Exception) { return "(This file is gone.)" }
            val decoder = Charsets.UTF_8.newDecoder()
            return try {
                decoder.decode(java.nio.ByteBuffer.wrap(d)).toString()
            } catch (_: Exception) {
                "(Not a text file, ${NumberFormat.getIntegerInstance().format(d.size)} bytes.)"
            }
        }
        return read(c.path) to read(c.copy)
    }
}
