package org.harborapps.quire.sync

import java.io.File
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.text.NumberFormat
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import org.harborapps.quire.vault.VaultPaths

/**
 * One sync pass over a vault folder, off the main thread: pull what the remote gained since
 * the last synced commit, then push this phone's changes as one commit.
 * Port of ios/Quire/Sync/SyncRunner.swift.
 *
 * Like app/main/sync.mjs, when both sides changed a file the remote wins in place and the
 * local version is kept beside it as "name (conflict <date> <time>).ext" (and then pushed).
 * Local changes are found by comparing each file's git blob sha with the manifest saved at
 * the last sync, so edits from the web view, new pages and file-manager edits all count.
 *
 * Everything runs on Dispatchers.IO, so `progress` is called from a background thread.
 */
class SyncRunner(
    private val gh: GitHubClient,
    private val root: File,
    private val branch: String,
    state: SyncState,
    private val author: Map<String, String>,
    private val progress: (String) -> Unit,
) {
    data class Outcome(
        val head: String = "",
        val pulled: List<String> = emptyList(),
        val pushed: List<String> = emptyList(),
        val conflicts: List<SyncConflict> = emptyList(),
    )

    private data class Change(val path: String, val stat: FileStat, val sha: String)

    private var sha: String = state.sha
    private val files: MutableMap<String, ManifestEntry> = HashMap(state.files)
    private var rules = IgnoreRules(root)

    private var head = ""
    private val pulled = mutableListOf<String>()
    private val pushed = mutableListOf<String>()
    private val conflicts = mutableListOf<SyncConflict>()

    /** The state as of now (what the last checkpoint saved, plus any in-memory progress). */
    val state: SyncState get() = SyncState(sha, HashMap(files))

    private fun outcome() = Outcome(head, pulled.toList(), pushed.toList(), conflicts.toList())

    private fun checkpoint() = SyncStore.saveState(state)

    companion object {
        /** Download the branch as one tarball into `into` (a new, empty folder) and record it. */
        suspend fun clone(
            gh: GitHubClient,
            branch: String,
            into: File,
            vaultName: String,
            progress: (String) -> Unit,
        ): SyncState = withContext(Dispatchers.IO) {
            val root = into
            progress("Downloading…")
            val tgz = gh.downloadTarball(branch)
            val ex = try {
                progress("Unpacking…")
                val fmt = NumberFormat.getIntegerInstance()
                Archive.extractTarball(tgz, root) { n -> progress("Unpacking ${fmt.format(n)} files…") }
            } finally {
                tgz.delete()
            }
            var sha = ex.commit ?: ""
            if (sha.isEmpty()) sha = gh.headSha(branch)
            // A repo that was never a Quire vault still opens as one.
            val meta = VaultPaths.metaFile(root, "vault.json")
            if (!meta.exists()) {
                meta.parentFile?.mkdirs()
                meta.writeText("{\n  \"name\": ${JsonPrimitive(vaultName)},\n  \"version\": 2\n}\n", Charsets.UTF_8)
            }
            progress("Indexing…")
            val files = HashMap<String, ManifestEntry>()
            val rules = IgnoreRules(root)
            for ((rel, exec) in ex.files) {
                if (rules.isIgnored(rel)) continue
                val f = VaultFiles.url(root, rel)
                val st = VaultFiles.stat(f) ?: continue
                val s = try { GitBlob.sha(f) } catch (_: Exception) { continue }
                files[rel] = ManifestEntry(s = s, z = st.size, m = st.mtime, x = exec)
            }
            val state = SyncState(sha, files)
            SyncStore.saveState(state)
            state
        }

        fun message(paths: List<String>): String {
            val shown = paths.take(3).joinToString(", ")
            val more = if (paths.size > 3) " and ${paths.size - 3} more" else ""
            return "Edit from Android: $shown$more\n\n" + paths.joinToString("\n")
        }

        /** Write bytes beside the target, then rename over it. */
        private fun writeAtomic(data: ByteArray, file: File) {
            val dir = file.parentFile ?: throw IOException("No parent for ${file.path}")
            val tmp = File(dir, ".${file.name}.${System.nanoTime()}.tmp")
            try {
                tmp.writeBytes(data)
                try {
                    Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                } catch (_: AtomicMoveNotSupportedException) {
                    Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }
            } finally {
                if (tmp.exists()) tmp.delete()
            }
        }
    }

    // Sync

    suspend fun run(): Outcome = withContext(Dispatchers.IO) {
        repeat(4) {
            progress("Checking…")
            val remoteHead = gh.headSha(branch)
            if (remoteHead != sha) pull(remoteHead)
            val (changed, deleted) = localChanges()
            if (changed.isEmpty() && deleted.isEmpty()) {
                head = sha
                return@withContext outcome()
            }
            try {
                push(changed, deleted)
                return@withContext outcome()
            } catch (_: SyncException.RefMoved) {
                // someone pushed first: pull their commit, then try again
            }
        }
        throw SyncException.Message("The repo kept changing while syncing. Try again in a minute.")
    }

    // Pull

    private suspend fun pull(to: String) {
        progress("Pulling…")
        var list: List<CompareFile>? = null
        if (sha.isNotEmpty()) {
            list = try {
                gh.compare(sha, to) // null when GitHub caps the list
            } catch (_: SyncException.NotFound) {
                null // base gone (force push)
            }
        }
        if (list != null) {
            for (f in list) {
                when (f.status) {
                    "removed" -> remove(f.filename)
                    "renamed" -> {
                        f.previous?.let { remove(it) }
                        apply(f.filename, f.sha) { gh.raw(f.filename, to) }
                    }
                    else -> apply(f.filename, f.sha) { gh.raw(f.filename, to) }
                }
            }
        } else {
            pullTarball(to)
        }
        sha = to
        rules = IgnoreRules(root)
        checkpoint()
    }

    /** Too many changes for compare: diff the whole tree against the manifest. */
    private suspend fun pullTarball(remoteHead: String) {
        val tgz = gh.downloadTarball(remoteHead)
        val tmp = Files.createTempDirectory("quire-pull-").toFile()
        try {
            val ex = Archive.extractTarball(tgz, tmp)
            for (rel in ex.files.keys.sorted()) {
                val src = VaultFiles.url(tmp, rel)
                val s = GitBlob.sha(src)
                if (files[rel]?.s == s) continue
                apply(rel, s) { src.readBytes() }
            }
            for (rel in files.keys.toList()) {
                if (rel !in ex.files) remove(rel)
            }
        } finally {
            tgz.delete()
            tmp.deleteRecursively()
        }
    }

    /**
     * This phone's sha for `rel` (null when the file is gone), skipping the hash when size and
     * mtime match the manifest.
     */
    private fun localSha(rel: String): String? {
        val f = VaultFiles.url(root, rel)
        val st = VaultFiles.stat(f) ?: return null
        val e = files[rel]
        if (e != null && e.z == st.size && e.m == st.mtime) return e.s
        return try { GitBlob.sha(f) } catch (_: Exception) { null }
    }

    private fun record(rel: String, sha: String) {
        val st = VaultFiles.stat(VaultFiles.url(root, rel))
        if (st == null) {
            files.remove(rel)
            return
        }
        files[rel] = ManifestEntry(s = sha, z = st.size, m = st.mtime, x = st.exec)
    }

    private suspend fun apply(path: String, remoteSha: String?, fetch: suspend () -> ByteArray) {
        val rel = VaultFiles.safeRelative(path) ?: return
        val f = VaultFiles.url(root, rel)
        val local = localSha(rel)
        if (remoteSha != null && local == remoteSha) { record(rel, remoteSha); return }
        val data = fetch()
        val rsha = GitBlob.sha(data)
        if (local == rsha) { record(rel, rsha); return }
        val dirty = local != null && local != files[rel]?.s
        val hidden = (rel.split("/").lastOrNull() ?: "").startsWith(".")
        if (dirty && !hidden && !rules.isIgnored(rel)) {
            val copy = VaultFiles.conflictName(root, rel)
            Files.copy(f.toPath(), VaultFiles.url(root, copy).toPath(), StandardCopyOption.COPY_ATTRIBUTES)
            conflicts.add(SyncConflict(path = rel, copy = copy, at = Instant.now()))
        }
        f.parentFile?.let { if (!it.isDirectory && !it.mkdirs()) throw IOException("Couldn't create ${it.path}") }
        writeAtomic(data, f)
        record(rel, rsha)
        pulled.add(rel)
    }

    private fun remove(path: String) {
        val rel = VaultFiles.safeRelative(path) ?: return
        try {
            val local = localSha(rel) ?: return
            // Changed here, deleted there: keep this phone's file (it gets pushed back).
            if (local != files[rel]?.s) return
            val f = VaultFiles.url(root, rel)
            if (!f.delete() && f.exists()) throw IOException("Couldn't remove $rel")
            VaultFiles.pruneEmptyParents(root, rel)
            pulled.add(rel)
        } finally {
            files.remove(rel)
        }
    }

    // Push

    private fun localChanges(): Pair<List<Change>, List<String>> {
        val scanned = VaultFiles.scan(root, rules)
        val changed = mutableListOf<Change>()
        for ((rel, st) in scanned) {
            val e = files[rel]
            if (e != null && e.z == st.size && e.m == st.mtime) continue
            val s = try { GitBlob.sha(VaultFiles.url(root, rel)) } catch (_: Exception) { continue }
            if (e != null && e.s == s) {
                files[rel] = ManifestEntry(s = s, z = st.size, m = st.mtime, x = e.x) // touched, not changed
                continue
            }
            changed.add(Change(rel, st, s))
        }
        val deleted = files.keys.filter { !VaultFiles.url(root, it).exists() }
        return changed.sortedBy { it.path } to deleted.sorted()
    }

    private suspend fun push(changed: List<Change>, deleted: List<String>) {
        val n = changed.size + deleted.size
        progress("Pushing $n ${if (n == 1) "change" else "changes"}…")
        val baseTree = gh.treeSha(sha)
        val entries = mutableListOf<Map<String, Any?>>()
        val pushedShas = HashMap<String, String>()
        for (c in changed) {
            val data = VaultFiles.url(root, c.path).readBytes()
            val blob = gh.createBlob(data)
            pushedShas[c.path] = blob
            val exec = files[c.path]?.x ?: c.stat.exec
            entries.add(mapOf("path" to c.path, "mode" to if (exec) "100755" else "100644", "type" to "blob", "sha" to blob))
        }
        for (d in deleted) {
            entries.add(mapOf("path" to d, "mode" to "100644", "type" to "blob", "sha" to null))
        }
        val tree = gh.createTree(baseTree, entries)
        val paths = changed.map { it.path } + deleted
        val commit = gh.createCommit(message(paths), tree, sha, author)
        gh.updateRef(branch, commit)
        for (c in changed) {
            files[c.path] = ManifestEntry(
                s = pushedShas[c.path] ?: c.sha,
                z = c.stat.size,
                m = c.stat.mtime,
                x = files[c.path]?.x ?: c.stat.exec,
            )
        }
        for (d in deleted) files.remove(d)
        sha = commit
        checkpoint()
        pushed.addAll(paths)
        head = commit
    }
}
