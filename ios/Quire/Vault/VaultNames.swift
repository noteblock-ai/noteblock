import Foundation

/// The on-disk names of a vault's metadata, in one place. Noteblock was called Quire, and the
/// desktop is migrating vaults in place: `<vault>/.quire/` becomes `<vault>/.noteblock/`
/// (vault.json, locks/, snapshots/) and each page's `<page>/.quire` manifest becomes
/// `<page>/.noteblock`. A synced vault can hold either name, or a mix, so readers accept both
/// (the new name wins when both exist) and everything the phone writes uses the new name.
enum VaultNames {
    /// A page's manifest file, and the vault's metadata folder (same name for both).
    static let current = ".noteblock"
    /// The pre-rename name, still read.
    static let legacy = ".quire"
    /// Preferred first.
    static let all = [current, legacy]

    /// True for a path segment that is a manifest file or the metadata folder, either name.
    static func isMeta(_ segment: String) -> Bool {
        segment == current || segment == legacy
    }

    // MARK: - Vault metadata folder

    /// `<root>/<name>/<rel>` for the first metadata folder holding `rel`, new name first.
    static func existingMeta(_ root: URL, _ rel: String) -> URL? {
        let fm = FileManager.default
        for name in all {
            let url = root.appendingPathComponent(name, isDirectory: true).appendingPathComponent(rel)
            if fm.fileExists(atPath: url.path) { return url }
        }
        return nil
    }

    /// Where to read `rel` from: the existing copy (new name first), else the new name.
    static func metaURL(_ root: URL, _ rel: String) -> URL {
        existingMeta(root, rel) ?? root.appendingPathComponent(current, isDirectory: true).appendingPathComponent(rel)
    }

    /// Where to write `rel`: always under the new name.
    static func metaWriteURL(_ root: URL, _ rel: String) -> URL {
        root.appendingPathComponent(current, isDirectory: true).appendingPathComponent(rel)
    }

    /// True when `root` has vault.json under either metadata folder.
    static func isVault(_ root: URL) -> Bool {
        existingMeta(root, "vault.json") != nil
    }

    /// Lines for .gitignore and sync's built-in ignores: snapshots and locks, both names.
    static let ignoreLines: [String] = all.flatMap { ["\($0)/snapshots/", "\($0)/locks/"] }

    // MARK: - Page manifest

    /// The page's manifest FILE (new name first), or nil when `dir` is not a page. A directory
    /// with the name (the vault's own metadata folder) does not count.
    static func manifestURL(in dir: URL) -> URL? {
        let fm = FileManager.default
        for name in all {
            var isDir: ObjCBool = false
            let url = dir.appendingPathComponent(name)
            if fm.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue { return url }
        }
        return nil
    }

    /// Rename every legacy page manifest under `root` (not the metadata folder's contents) to
    /// the new name, and the legacy metadata folder too when there is no new one. For a
    /// freshly copied seed vault only: a synced vault is migrated by the desktop.
    static func migrateFresh(_ root: URL) {
        let fm = FileManager.default
        let oldMeta = root.appendingPathComponent(legacy, isDirectory: true)
        let newMeta = root.appendingPathComponent(current, isDirectory: true)
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: oldMeta.path, isDirectory: &isDir), isDir.boolValue, !fm.fileExists(atPath: newMeta.path) {
            try? fm.moveItem(at: oldMeta, to: newMeta)
        }
        guard let walk = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { return }
        var olds: [URL] = []
        for case let url as URL in walk {
            if url.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL, isMeta(url.lastPathComponent),
               (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile != true {
                walk.skipDescendants()
                continue
            }
            if url.lastPathComponent == legacy, (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true {
                olds.append(url)
            }
        }
        for old in olds {
            let new = old.deletingLastPathComponent().appendingPathComponent(current)
            if fm.fileExists(atPath: new.path) { try? fm.removeItem(at: old) } else { try? fm.moveItem(at: old, to: new) }
        }
    }
}
