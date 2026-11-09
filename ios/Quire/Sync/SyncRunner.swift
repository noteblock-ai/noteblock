import Foundation

/// One sync pass over a vault folder, off the main thread: pull what the remote gained since
/// the last synced commit, then push this iPhone's changes as one commit.
///
/// Like app/main/sync.mjs, when both sides changed a file the remote wins in place and the
/// local version is kept beside it as "name (conflict <date> <time>).ext" (and then pushed).
/// Local changes are found by comparing each file's git blob sha with the manifest saved at
/// the last sync, so edits from the web view, new pages and Files-app edits all count.
final class SyncRunner {
    struct Outcome {
        var head = ""
        var pulled: [String] = []
        var pushed: [String] = []
        var conflicts: [SyncConflict] = []
    }

    private struct Change {
        var path: String
        var stat: FileStat
        var sha: String
    }

    private let gh: GitHubClient
    private let root: URL
    private let branch: String
    private let author: [String: String]
    private let progress: (String) -> Void
    private var state: SyncState
    private var rules: IgnoreRules
    private var outcome = Outcome()
    private let fm = FileManager.default

    init(gh: GitHubClient, root: URL, branch: String, state: SyncState, author: [String: String], progress: @escaping (String) -> Void) {
        self.gh = gh
        self.root = root
        self.branch = branch
        self.state = state
        self.author = author
        self.progress = progress
        rules = IgnoreRules(root: root)
    }

    private func checkpoint() throws { try SyncStore.saveState(state) }

    // MARK: - Clone

    /// Download the branch as one tarball into `root` (a new, empty folder) and record it.
    static func clone(gh: GitHubClient, branch: String, into root: URL, vaultName: String, progress: @escaping (String) -> Void) async throws -> SyncState {
        progress("Downloading…")
        let tgz = try await gh.downloadTarball(branch)
        defer { try? FileManager.default.removeItem(at: tgz) }
        progress("Unpacking…")
        let ex = try Archive.extractTarball(tgz, into: root) { n in progress("Unpacking \(n.formatted()) files…") }
        var sha = ex.commit ?? ""
        if sha.isEmpty { sha = try await gh.headSha(branch) }
        // A repo that was never a Quire vault still opens as one.
        if !VaultNames.isVault(root) {
            let meta = VaultNames.metaWriteURL(root, "vault.json")
            try FileManager.default.createDirectory(at: meta.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: ["name": vaultName, "version": 2], options: [.prettyPrinted, .sortedKeys])
            try (data + Data("\n".utf8)).write(to: meta)
        }
        progress("Indexing…")
        var files: [String: ManifestEntry] = [:]
        let rules = IgnoreRules(root: root)
        for (rel, exec) in ex.files where !rules.isIgnored(rel) {
            let url = VaultFiles.url(root, rel)
            guard let st = VaultFiles.stat(url), let s = try? GitBlob.sha(fileAt: url) else { continue }
            files[rel] = ManifestEntry(s: s, z: st.size, m: st.mtime, x: exec)
        }
        let state = SyncState(sha: sha, files: files)
        try SyncStore.saveState(state)
        return state
    }

    // MARK: - Sync

    func run() async throws -> Outcome {
        for _ in 0..<4 {
            progress("Checking…")
            let head = try await gh.headSha(branch)
            if head != state.sha { try await pull(to: head) }
            let (changed, deleted) = localChanges()
            if changed.isEmpty && deleted.isEmpty {
                outcome.head = state.sha
                return outcome
            }
            do {
                try await push(changed, deleted)
                return outcome
            } catch SyncError.refMoved {
                continue // someone pushed first: pull their commit, then try again
            }
        }
        throw SyncError.message("The repo kept changing while syncing. Try again in a minute.")
    }

    // MARK: Pull

    private func pull(to head: String) async throws {
        progress("Pulling…")
        var files: [CompareFile]?
        if !state.sha.isEmpty {
            do { files = try await gh.compare(state.sha, head) } catch SyncError.notFound { files = nil } // base gone (force push)
        }
        if let files {
            for f in files {
                switch f.status {
                case "removed":
                    try remove(f.filename)
                case "renamed":
                    if let prev = f.previous { try remove(prev) }
                    try await apply(f.filename, remoteSha: f.sha) { try await self.gh.raw(f.filename, ref: head) }
                default:
                    try await apply(f.filename, remoteSha: f.sha) { try await self.gh.raw(f.filename, ref: head) }
                }
            }
        } else {
            try await pullTarball(head)
        }
        state.sha = head
        rules = IgnoreRules(root: root)
        try checkpoint()
    }

    /// Too many changes for compare: diff the whole tree against the manifest.
    private func pullTarball(_ head: String) async throws {
        let tgz = try await gh.downloadTarball(head)
        defer { try? fm.removeItem(at: tgz) }
        let tmp = fm.temporaryDirectory.appendingPathComponent("quire-pull-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: tmp) }
        let ex = try Archive.extractTarball(tgz, into: tmp)
        for rel in ex.files.keys.sorted() {
            let src = VaultFiles.url(tmp, rel)
            let sha = try GitBlob.sha(fileAt: src)
            if state.files[rel]?.s == sha { continue }
            try await apply(rel, remoteSha: sha) { try Data(contentsOf: src) }
        }
        for rel in state.files.keys where ex.files[rel] == nil {
            try remove(rel)
        }
    }

    /// This iPhone's sha for `rel` (nil when the file is gone), skipping the hash when size
    /// and mtime match the manifest.
    private func localSha(_ rel: String) -> String? {
        let url = VaultFiles.url(root, rel)
        guard let st = VaultFiles.stat(url) else { return nil }
        if let e = state.files[rel], e.z == st.size, e.m == st.mtime { return e.s }
        return try? GitBlob.sha(fileAt: url)
    }

    private func record(_ rel: String, sha: String) {
        guard let st = VaultFiles.stat(VaultFiles.url(root, rel)) else { state.files[rel] = nil; return }
        state.files[rel] = ManifestEntry(s: sha, z: st.size, m: st.mtime, x: st.exec)
    }

    private func apply(_ path: String, remoteSha: String?, fetch: () async throws -> Data) async throws {
        guard let rel = VaultFiles.safeRelative(path) else { return }
        let url = VaultFiles.url(root, rel)
        let local = localSha(rel)
        if let r = remoteSha, local == r { record(rel, sha: r); return }
        let data = try await fetch()
        let rsha = GitBlob.sha(data)
        if local == rsha { record(rel, sha: rsha); return }
        let dirty = local != nil && local != state.files[rel]?.s
        let hidden = (rel.split(separator: "/").last ?? "").hasPrefix(".")
        if dirty && !hidden, !rules.isIgnored(rel) {
            let copy = VaultFiles.conflictName(root, rel)
            try fm.copyItem(at: url, to: VaultFiles.url(root, copy))
            outcome.conflicts.append(SyncConflict(path: rel, copy: copy, at: Date()))
        }
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        record(rel, sha: rsha)
        outcome.pulled.append(rel)
    }

    private func remove(_ path: String) throws {
        guard let rel = VaultFiles.safeRelative(path) else { return }
        defer { state.files[rel] = nil }
        guard let local = localSha(rel) else { return }
        // Changed here, deleted there: keep this iPhone's file (it gets pushed back).
        if local != state.files[rel]?.s { return }
        try fm.removeItem(at: VaultFiles.url(root, rel))
        VaultFiles.pruneEmptyParents(root, rel)
        outcome.pulled.append(rel)
    }

    // MARK: Push

    private func localChanges() -> ([Change], [String]) {
        let files = VaultFiles.scan(root, rules: rules)
        var changed: [Change] = []
        for (rel, st) in files {
            if let e = state.files[rel], e.z == st.size, e.m == st.mtime { continue }
            guard let sha = try? GitBlob.sha(fileAt: VaultFiles.url(root, rel)) else { continue }
            if let e = state.files[rel], e.s == sha {
                state.files[rel] = ManifestEntry(s: sha, z: st.size, m: st.mtime, x: e.x) // touched, not changed
                continue
            }
            changed.append(Change(path: rel, stat: st, sha: sha))
        }
        let deleted = state.files.keys.filter { !fm.fileExists(atPath: VaultFiles.url(root, $0).path) }
        return (changed.sorted { $0.path < $1.path }, deleted.sorted())
    }

    private func push(_ changed: [Change], _ deleted: [String]) async throws {
        let n = changed.count + deleted.count
        progress("Pushing \(n) \(n == 1 ? "change" : "changes")…")
        let baseTree = try await gh.treeSha(ofCommit: state.sha)
        var entries: [[String: Any]] = []
        var pushedShas: [String: String] = [:]
        for c in changed {
            let data = try Data(contentsOf: VaultFiles.url(root, c.path))
            let sha = try await gh.createBlob(data)
            pushedShas[c.path] = sha
            let exec = state.files[c.path]?.x ?? c.stat.exec
            entries.append(["path": c.path, "mode": exec ? "100755" : "100644", "type": "blob", "sha": sha])
        }
        for d in deleted {
            entries.append(["path": d, "mode": "100644", "type": "blob", "sha": NSNull()])
        }
        let tree = try await gh.createTree(base: baseTree, entries: entries)
        let paths = changed.map(\.path) + deleted
        let commit = try await gh.createCommit(message: Self.message(paths), tree: tree, parent: state.sha, author: author)
        try await gh.updateRef(branch, to: commit)
        for c in changed {
            state.files[c.path] = ManifestEntry(s: pushedShas[c.path] ?? c.sha, z: c.stat.size, m: c.stat.mtime, x: state.files[c.path]?.x ?? c.stat.exec)
        }
        for d in deleted { state.files[d] = nil }
        state.sha = commit
        try checkpoint()
        outcome.pushed += paths
        outcome.head = commit
    }

    static func message(_ paths: [String]) -> String {
        let shown = paths.prefix(3).joined(separator: ", ")
        let more = paths.count > 3 ? " and \(paths.count - 3) more" : ""
        return "Edit from iPhone: \(shown)\(more)\n\n" + paths.joined(separator: "\n")
    }
}
