import SwiftUI
import UIKit

// M-004. The vault screens (M-003) use statusText / isHealthy / syncNow() / SyncSettingsView.
//
// Vault sync with its GitHub remote over the GitHub REST API (no git on the phone). The repo
// and branch live in Application Support/Sync/config.json, the last synced commit and the
// per-file blob manifest in state.json, the token in the Keychain. See SyncRunner for the
// pull/push rules (same conflict copies as app/main/sync.mjs).

/// Vault sync with its GitHub remote, over the GitHub API.
@MainActor
final class SyncEngine: ObservableObject {
    static let shared = SyncEngine()

    /// One line for the vault footer: "Synced 2 min ago", "Syncing…", "Not set up", "Offline",
    /// "Sync failed — tap for details".
    @Published private(set) var statusText = "Not set up"
    /// Green dot when true, grey otherwise.
    @Published private(set) var isHealthy = false
    /// The last failure, in plain words (rate limits include the requests left).
    @Published private(set) var lastError: String?
    /// Files changed on both sides that haven't been looked at yet.
    @Published private(set) var conflicts: [SyncConflict] = []
    @Published private(set) var isSyncing = false
    /// What a running sync or connect is doing: "Downloading…", "Pushing 2 changes…".
    @Published private(set) var phase: String?
    @Published private(set) var config: SyncConfig?

    var isSetUp: Bool { config != nil }
    /// The vault folder this repo syncs into.
    var vaultRoot: URL? { config.map { VaultStore.documents.appendingPathComponent($0.folder, isDirectory: true) } }

    private enum Failure { case offline, failed }
    private var failure: Failure?
    private var running: Task<Void, Never>?
    private var ticker: Task<Void, Never>?
    private var lastAttempt = Date.distantPast
    private var observers: [NSObjectProtocol] = []

    static let checkEvery: TimeInterval = 300

    private init() {
        config = SyncStore.loadConfig()
        if config != nil, Keychain.token() == nil { config = nil } // token gone (restored backup): not set up
        conflicts = config?.conflicts ?? []
        refreshStatus()
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in SyncEngine.shared.becameActive() }
        })
        observers.append(nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in SyncEngine.shared.resignedActive() }
        })
        if UIApplication.shared.applicationState == .active { becameActive() }
    }

    // MARK: - Auto sync: on open, then every 5 min while active

    private func becameActive() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.refreshStatus()
                if self.isSetUp, Date().timeIntervalSince(self.lastAttempt) >= Self.checkEvery {
                    await self.syncNow()
                }
                try? await Task.sleep(nanoseconds: 30_000_000_000)
            }
        }
        // Coming back to the app always checks, unless a sync just ran.
        if isSetUp, Date().timeIntervalSince(lastAttempt) > 10 {
            Task { await syncNow() }
        }
    }

    private func resignedActive() {
        ticker?.cancel()
        ticker = nil
    }

    // MARK: - Sync

    /// Pull, then push local changes. Safe to call often; does nothing when not set up. While a
    /// sync is running, waits for it instead of starting another.
    func syncNow() async {
        if let running { await running.value; return }
        guard let config, let token = Keychain.token(), let root = vaultRoot else { refreshStatus(); return }
        guard let state = SyncStore.loadState() else {
            fail(SyncError.message("This vault's sync record is missing. Disconnect and connect again."))
            return
        }
        lastAttempt = Date()
        let gh = GitHubClient(token: token, owner: config.owner, repo: config.repo)
        let author = authorInfo(config)
        let task = Task {
            self.isSyncing = true
            self.refreshStatus()
            defer {
                self.isSyncing = false
                self.phase = nil
                self.running = nil
                self.refreshStatus()
            }
            do {
                let outcome = try await Task.detached(priority: .utility) {
                    let runner = SyncRunner(gh: gh, root: root, branch: config.branch, state: state, author: author) { p in
                        Task { @MainActor in SyncEngine.shared.phase = p }
                    }
                    return try await runner.run()
                }.value
                self.finished(outcome)
            } catch {
                self.fail(error)
            }
        }
        running = task
        await task.value
    }

    private func finished(_ outcome: SyncRunner.Outcome) {
        failure = nil
        lastError = nil
        guard var c = config else { return }
        c.lastSyncAt = Date()
        if !outcome.conflicts.isEmpty { c.conflicts += outcome.conflicts }
        config = c
        conflicts = c.conflicts
        try? SyncStore.saveConfig(c)
        if !outcome.pulled.isEmpty || !outcome.conflicts.isEmpty {
            NotificationCenter.default.post(name: .quireVaultChanged, object: outcome.pulled)
        }
    }

    private func fail(_ error: Error) {
        if case SyncError.offline = error {
            failure = .offline
            lastError = SyncError.offline.localizedDescription
        } else {
            failure = .failed
            lastError = error.localizedDescription
        }
        refreshStatus()
    }

    private func authorInfo(_ c: SyncConfig) -> [String: String] {
        let email: String
        if let login = c.login, !login.isEmpty, let id = c.userId, id > 0 {
            email = "\(id)+\(login)@users.noreply.github.com"
        } else {
            email = "iphone@quire.local"
        }
        return ["name": UIDevice.current.name, "email": email, "date": ISO8601DateFormatter().string(from: Date())]
    }

    private func refreshStatus() {
        if !isSetUp {
            statusText = "Not set up"
            isHealthy = false
        } else if isSyncing {
            statusText = "Syncing…"
            isHealthy = failure == nil
        } else if failure == .offline {
            statusText = "Offline"
            isHealthy = false
        } else if failure == .failed {
            statusText = "Sync failed — tap for details"
            isHealthy = false
        } else if let at = config?.lastSyncAt {
            statusText = Self.syncedText(at)
            isHealthy = true
        } else {
            statusText = "Not synced yet"
            isHealthy = false
        }
    }

    static func syncedText(_ d: Date, now: Date = Date()) -> String {
        let s = now.timeIntervalSince(d)
        if s < 60 { return "Synced just now" }
        if s < 3600 { return "Synced \(Int(s / 60)) min ago" }
        if s < 86400 { return "Synced \(Int(s / 3600)) hr ago" }
        return "Synced " + d.formatted(date: .abbreviated, time: .omitted)
    }

    // MARK: - Connect / disconnect

    /// Check the repo and token, clone the branch into a new vault folder named after the repo
    /// and make it the current vault.
    func connect(repo input: String, token rawToken: String) async throws {
        guard running == nil else { throw SyncError.message("A sync is running. Try again in a moment.") }
        guard let (owner, repo) = parseRepoInput(input) else {
            throw SyncError.message("Enter the repo as owner/repo, like you/field-notes.")
        }
        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw SyncError.message("Paste a GitHub token.") }
        let gh = GitHubClient(token: token, owner: owner, repo: repo)

        var thrown: Error?
        let task = Task {
            self.isSyncing = true
            self.phase = "Checking the repo…"
            defer { self.isSyncing = false; self.phase = nil; self.running = nil; self.refreshStatus() }
            do {
                let info: (defaultBranch: String, canPush: Bool)
                do { info = try await gh.repoInfo() } catch SyncError.notFound {
                    throw SyncError.message("Can't find \(owner)/\(repo). Check the name, and that the token has the repo scope.")
                }
                if !info.canPush { throw SyncError.message("This token can read \(owner)/\(repo) but can't push to it.") }
                let me = try? await gh.user()
                let folder = Self.freeFolderName(repo)
                let root = VaultStore.documents.appendingPathComponent(folder, isDirectory: true)
                do {
                    _ = try await Task.detached(priority: .userInitiated) {
                        try await SyncRunner.clone(gh: gh, branch: info.defaultBranch, into: root, vaultName: repo) { p in
                            Task { @MainActor in SyncEngine.shared.phase = p }
                        }
                    }.value
                } catch {
                    try? FileManager.default.removeItem(at: root)
                    if case SyncError.notFound = error { throw SyncError.message("\(owner)/\(repo) has no commits on \(info.defaultBranch) yet.") }
                    if case SyncError.http(409, _) = error { throw SyncError.message("\(owner)/\(repo) is empty. Push the vault from your Mac first.") }
                    throw error
                }
                try Keychain.setToken(token)
                let c = SyncConfig(owner: owner, repo: repo, branch: info.defaultBranch, folder: folder,
                                   login: me?.login, userId: me?.id, lastSyncAt: Date(), conflicts: [])
                try SyncStore.saveConfig(c)
                self.config = c
                self.conflicts = []
                self.failure = nil
                self.lastError = nil
                self.lastAttempt = Date()
                VaultSelection.select(folder)
                NotificationCenter.default.post(name: .quireVaultChanged, object: nil)
            } catch {
                thrown = error
            }
        }
        running = task
        await task.value
        if let thrown { throw thrown }
    }

    private static func freeFolderName(_ repo: String) -> String {
        let fm = FileManager.default
        for i in 1... {
            let name = i == 1 ? repo : "\(repo) \(i)"
            if !fm.fileExists(atPath: VaultStore.documents.appendingPathComponent(name).path) { return name }
        }
        return repo
    }

    /// Forget the repo and token. The vault folder stays on the phone.
    func disconnect() {
        running?.cancel()
        SyncStore.clear()
        config = nil
        conflicts = []
        failure = nil
        lastError = nil
        refreshStatus()
    }

    // MARK: - Conflicts

    /// "Keep both": both files stay, the note goes away.
    func dismissConflict(_ c: SyncConflict) {
        guard var cfg = config else { return }
        cfg.conflicts.removeAll { $0.id == c.id }
        config = cfg
        conflicts = cfg.conflicts
        try? SyncStore.saveConfig(cfg)
    }

    /// The remote version (in place) and this iPhone's version (the conflict copy), as text.
    func texts(for c: SyncConflict) -> (remote: String, local: String) {
        guard let root = vaultRoot else { return ("", "") }
        func read(_ rel: String) -> String {
            guard let d = try? Data(contentsOf: VaultFiles.url(root, rel)) else { return "(This file is gone.)" }
            return String(data: d, encoding: .utf8) ?? "(Not a text file, \(d.count.formatted()) bytes.)"
        }
        return (read(c.path), read(c.copy))
    }
}
