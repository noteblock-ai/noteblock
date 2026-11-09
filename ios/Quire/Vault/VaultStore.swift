import Foundation

enum VaultError: LocalizedError {
    case noPage(String)
    case badPath(String)
    case seedMissing

    var errorDescription: String? {
        switch self {
        case .noPage(let ref): return "No page: \(ref)"
        case .badPath(let p): return "Bad path: \(p)"
        case .seedMissing: return "The starter vault is missing from the app bundle"
        }
    }
}

/// The vault on disk: a folder in the app's Documents (visible in the Files app). Mirrors
/// core/pages.mjs (listTree, findPage, entryFile, readManifest) and the lock/snapshot reads of
/// core/lock.mjs. Only reads and plain file I/O, no state beyond `root`, so it is safe to use
/// from any thread (the scheme handler calls it off the main thread).
final class VaultStore: @unchecked Sendable {
    /// The name a page manifest is WRITTEN under. Read through `manifestURL(_:)`, which also
    /// accepts the pre-rename `.quire` (see VaultNames).
    static let manifestName = VaultNames.current
    private static let entries = ["index.html", "index.md"]
    private static let renderers = ["quire", "view", "source"]
    /// Same as core/vault.mjs GITIGNORE (snapshots/locks under both metadata folder names).
    static let gitignore = "data/\n" + VaultNames.ignoreLines.joined(separator: "\n") + "\n.DS_Store\nnode_modules/\n.env\n.env.*\n!.env.example\n"

    let root: URL
    private let fm = FileManager.default

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    // MARK: - Opening / seeding

    private static let currentKey = "quire.vault"

    static var documents: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    /// The current vault: the folder named in UserDefaults, else the first vault in Documents,
    /// else a new "My First Vault" seeded from the bundle's Seed/My First Vault.
    static func openDefault(bundle: Bundle = .main) throws -> VaultStore {
        let fm = FileManager.default
        let docs = documents
        func isVault(_ url: URL) -> Bool { VaultNames.isVault(url) }
        if let name = UserDefaults.standard.string(forKey: currentKey) {
            let url = docs.appendingPathComponent(name, isDirectory: true)
            if isVault(url) { return VaultStore(root: url) }
        }
        let existing = (try? fm.contentsOfDirectory(at: docs, includingPropertiesForKeys: [.isDirectoryKey]))?
            .filter { !$0.lastPathComponent.hasPrefix(".") && isVault($0) }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        if let first = existing?.first {
            UserDefaults.standard.set(first.lastPathComponent, forKey: currentKey)
            return VaultStore(root: first)
        }
        let store = try seed(named: "My First Vault", into: docs, bundle: bundle)
        UserDefaults.standard.set(store.root.lastPathComponent, forKey: currentKey)
        return store
    }

    /// Copy the bundled starter vault into `parent/<name>` and add what core's createVault
    /// writes (.noteblock/vault.json, .gitignore). No git here; sync (M-004) owns that.
    static func seed(named name: String, into parent: URL, bundle: Bundle = .main) throws -> VaultStore {
        guard let seed = bundle.url(forResource: "Seed", withExtension: nil)?.appendingPathComponent("My First Vault") else {
            throw VaultError.seedMissing
        }
        let fm = FileManager.default
        let dest = parent.appendingPathComponent(name, isDirectory: true)
        if !fm.fileExists(atPath: dest.path) {
            try fm.copyItem(at: seed, to: dest)
            // The bundled seed may still use the old names; a fresh copy gets the new ones.
            VaultNames.migrateFresh(dest)
        }
        if !VaultNames.isVault(dest) {
            let vaultJSON = VaultNames.metaWriteURL(dest, "vault.json")
            try fm.createDirectory(at: vaultJSON.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: ["name": name, "version": 2], options: [.prettyPrinted, .sortedKeys])
            try (data + Data("\n".utf8)).write(to: vaultJSON)
        }
        let gi = dest.appendingPathComponent(".gitignore")
        if !fm.fileExists(atPath: gi.path) { try Data(gitignore.utf8).write(to: gi) }
        return VaultStore(root: dest)
    }

    /// vault.json "name", else the folder name.
    var name: String {
        let url = VaultNames.metaURL(root, "vault.json")
        if let data = try? Data(contentsOf: url),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let n = obj["name"] as? String, !n.isEmpty {
            return n
        }
        return root.lastPathComponent
    }

    // MARK: - Paths

    /// Trim slashes; reject ".", ".." and hidden segments (core's normPath).
    static func normPath(_ p: String) throws -> String {
        let segs = p.split(separator: "/").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        for s in segs where s == "." || s == ".." || s.hasPrefix(".") { throw VaultError.badPath(p) }
        return segs.joined(separator: "/")
    }

    /// Absolute folder of a vault path.
    func pathDir(_ p: String) throws -> URL {
        let norm = try Self.normPath(p)
        return norm.split(separator: "/").reduce(root) { $0.appendingPathComponent(String($1), isDirectory: true) }
    }

    /// The page's manifest file, `.noteblock` or the older `.quire` (nil when not a page).
    func manifestURL(_ dir: URL) -> URL? {
        VaultNames.manifestURL(in: dir)
    }

    /// True when `dir` holds a manifest FILE (the vault's own metadata folder is a directory).
    func isPageDir(_ dir: URL) -> Bool {
        manifestURL(dir) != nil
    }

    func readManifest(_ dir: URL) -> [String: Any]? {
        guard let url = manifestURL(dir), let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// manifest.entry when that file exists, else index.html, else index.md, else the named
    /// entry (or index.html).
    func entryFile(_ dir: URL, manifest: [String: Any]?) -> String {
        let named = (manifest?["entry"] as? String).flatMap { $0.contains("..") ? nil : $0 }
        if let named, fm.fileExists(atPath: dir.appendingPathComponent(named).path) { return named }
        for f in Self.entries where fm.fileExists(atPath: dir.appendingPathComponent(f).path) { return f }
        return named ?? "index.html"
    }

    // MARK: - Locks (agents editing a page on the Mac; synced in with the vault)

    func lock(id: String?) -> VaultNode.Lock? {
        guard let id, !id.isEmpty else { return nil }
        let url = VaultNames.metaURL(root, "locks/\(id).json")
        guard let data = try? Data(contentsOf: url),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return VaultNode.Lock(
            id: obj["id"] as? String ?? id,
            path: obj["path"] as? String,
            by: obj["by"] as? String,
            message: obj["message"] as? String,
            startedAt: obj["startedAt"] as? String
        )
    }

    func snapshotDir(id: String) -> URL {
        VaultNames.metaURL(root, "snapshots/\(id)")
    }

    // MARK: - Tree

    /// Folders first, then pages and plain files together, each by name (numeric-aware).
    func listTree() -> [VaultNode] {
        readChildren(root, parentPath: "")
    }

    /// Every page in tree order.
    func allPages() -> [VaultNode] {
        listTree().walked().filter(\.isPage)
    }

    /// ref = page path or page id. Throws VaultError.noPage.
    func findPage(_ ref: String) throws -> VaultNode {
        if ref.isEmpty { throw VaultError.noPage(ref) }
        if let norm = try? Self.normPath(ref), !norm.isEmpty, let dir = try? pathDir(norm), isPageDir(dir) {
            return pageNode(dir, path: norm)
        }
        if let hit = allPages().first(where: { $0.pageId == ref }) { return hit }
        throw VaultError.noPage(ref)
    }

    func pageNode(_ dir: URL, path p: String) -> VaultNode {
        let m = readManifest(dir) ?? [:]
        let id = m["id"] as? String
        let entry = entryFile(dir, manifest: m)
        let name = p.split(separator: "/").last.map(String.init) ?? p
        let title = (m["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name
        let source = (m["source"] as? String).flatMap { $0.contains("..") ? nil : $0 }
        let build = (m["build"] as? String).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
        let renderer = (m["renderer"] as? String).flatMap { Self.renderers.contains($0) ? $0 : nil } ?? "quire"
        var embedHeight: Int?
        if let embed = m["embed"] as? [String: Any], let h = (embed["height"] as? NSNumber)?.doubleValue, h > 0 {
            embedHeight = Int(h.rounded())
        }
        let format: VaultNode.Format = fm.fileExists(atPath: dir.appendingPathComponent(entry).path)
            ? (entry.lowercased().hasSuffix(".md") ? .md : .html) : .none
        return VaultNode(
            kind: .page, pageId: id, title: title, path: p, dir: dir, entry: entry, source: source, build: build,
            renderer: renderer, embedHeight: embedHeight, backend: Self.parseBackend(m["backend"]), format: format,
            children: [], lock: lock(id: id)
        )
    }

    /// core's parseBackend: {dir, run: string | {name: cmd}, proxy}.
    static func parseBackend(_ raw: Any?) -> VaultNode.Backend? {
        guard let b = raw as? [String: Any] else { return nil }
        var dir = "backend"
        if let d = (b["dir"] as? String)?.trimmingCharacters(in: .whitespaces), !d.isEmpty,
           !d.split(separator: "/").contains(where: { $0 == ".." || $0.hasPrefix(".") }) {
            dir = d.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        var run: [String: String] = [:]
        if let s = (b["run"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
            run["main"] = s
        } else if let obj = b["run"] as? [String: Any] {
            for (name, cmd) in obj {
                guard name.range(of: "^[a-z][a-z0-9_-]{0,31}$", options: [.regularExpression, .caseInsensitive]) != nil,
                      let c = (cmd as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty else { continue }
                run[name] = c
            }
        }
        let proxy: String?
        if let p = b["proxy"] as? String, run[p] != nil { proxy = p }
        else if run["api"] != nil { proxy = "api" }
        else { proxy = run.keys.sorted().first }
        return VaultNode.Backend(dir: dir, run: run, proxy: proxy)
    }

    private static let skipNames: Set<String> = ["node_modules", "data"]

    private func readChildren(_ dir: URL, parentPath: String) -> [VaultNode] {
        guard let urls = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey]) else {
            return []
        }
        var folders: [VaultNode] = []
        var items: [VaultNode] = []
        for url in urls {
            let name = url.lastPathComponent
            if name.hasPrefix(".") || Self.skipNames.contains(name) { continue }
            let p = parentPath.isEmpty ? name : "\(parentPath)/\(name)"
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
            if values?.isRegularFile == true {
                items.append(VaultNode(kind: .file, title: name, path: p, dir: dir))
                continue
            }
            guard values?.isDirectory == true else { continue }
            if isPageDir(url) {
                items.append(pageNode(url, path: p))
            } else {
                var folder = VaultNode(kind: .folder, title: name, path: p, dir: url)
                folder.children = readChildren(url, parentPath: p)
                folders.append(folder)
            }
        }
        let byName: (VaultNode, VaultNode) -> Bool = { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return folders.sorted(by: byName) + items.sorted(by: byName)
    }
}
