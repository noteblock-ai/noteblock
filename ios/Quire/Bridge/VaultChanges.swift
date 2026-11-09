import Foundation

/// The local-change journal: which vault files the phone has written since the last push.
///
/// API (all of it, thread-safe):
/// - `VaultChanges.shared.markChanged(path:)` — call after writing a file. `path` is
///   vault-relative with "/" separators, the file itself: "Welcome/index.html",
///   "Habits/.noteblock", "Habits/data/iphone.sqlite".
/// - `changedPaths` — a snapshot of everything marked since the last `clear()`, sorted.
/// - `clear()` — forget it all (sync calls this after a successful push).
///
/// Written by RpcBridge (saves, manifest edits, page data). M-004's sync reads it to know what
/// to commit and push. It persists in UserDefaults, so a change made just before the app was
/// killed is still pushed on the next launch. Page data files (`data/`) are gitignored today
/// and are listed only so sync can decide what to do with them later.
final class VaultChanges: @unchecked Sendable {
    static let shared = VaultChanges()

    private let lock = NSLock()
    private var paths: Set<String>
    private let defaults: UserDefaults
    private let key = "quire.vaultChanges"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        paths = Set(defaults.stringArray(forKey: "quire.vaultChanges") ?? [])
    }

    func markChanged(path: String) {
        let p = path.split(separator: "/").filter { !$0.isEmpty }.joined(separator: "/")
        guard !p.isEmpty else { return }
        lock.lock()
        let inserted = paths.insert(p).inserted
        let snapshot = paths
        lock.unlock()
        if inserted { defaults.set(Array(snapshot).sorted(), forKey: key) }
    }

    var changedPaths: [String] {
        lock.lock()
        defer { lock.unlock() }
        return paths.sorted()
    }

    func clear() {
        lock.lock()
        paths.removeAll()
        lock.unlock()
        defaults.removeObject(forKey: key)
    }
}

/// Atomic file writes for the bridge: write a temp file next to the target, then rename, so a
/// crash mid-save never leaves half a page.
enum AtomicFile {
    static func write(_ text: String, to url: URL) throws {
        try Data(text.utf8).write(to: url, options: [.atomic])
    }
}
