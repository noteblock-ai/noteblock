import Foundation

enum VaultEditError: LocalizedError {
    case emptyName
    case exists(String)
    case noFolder(String)
    case parentIsPage(String)
    case locked
    case notFound(String)

    var errorDescription: String? {
        switch self {
        case .emptyName: return "Give the page a name"
        case .exists(let p): return "Already exists: \(p)"
        case .noFolder(let p): return "No folder: \(p)"
        case .parentIsPage(let p): return "\(p) is a page; pages can't hold other pages or folders"
        case .locked: return "Claude is editing this page on your Mac"
        case .notFound(let p): return "Not found: \(p)"
        }
    }
}

/// Writes to the vault tree: core/pages.mjs createPage, and delete (the Mac moves to the OS
/// Trash; the phone moves to a vault-local `.trash/`, which listTree skips).
extension VaultStore {
    private static let idChars = Array("abcdefghijklmnopqrstuvwxyz0123456789")

    /// A fresh page id (10 chars, [a-z0-9]), as core's newPageId.
    static func newPageId() -> String {
        String((0..<10).map { _ in idChars.randomElement()! })
    }

    /// core's blankHtml.
    static func blankHtml(_ title: String) -> String {
        let t = title.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>\(t)</title></head><body>\n<h1>\(t)</h1>\n<p><br></p>\n</body></html>\n"
    }

    /// Create an HTML page at `path`; its parent folder must exist and not be a page.
    @discardableResult
    func createPage(_ path: String) throws -> VaultNode {
        let norm = try Self.normPath(path)
        guard !norm.isEmpty else { throw VaultEditError.emptyName }
        let dir = try pathDir(norm)
        let fm = FileManager.default
        if fm.fileExists(atPath: dir.path) { throw VaultEditError.exists(norm) }
        let parent = norm.split(separator: "/").dropLast().joined(separator: "/")
        if !parent.isEmpty {
            let pdir = try pathDir(parent)
            guard fm.fileExists(atPath: pdir.path) else { throw VaultEditError.noFolder(parent) }
            if isPageDir(pdir) { throw VaultEditError.parentIsPage(parent) }
        }
        let title = norm.split(separator: "/").last.map(String.init) ?? norm
        try fm.createDirectory(at: dir, withIntermediateDirectories: false)
        // JSON.stringify({id, entry}, null, 2) + "\n", byte for byte.
        let manifest = "{\n  \"id\": \"\(Self.newPageId())\",\n  \"entry\": \"index.html\"\n}\n"
        try Data(manifest.utf8).write(to: dir.appendingPathComponent(Self.manifestName))
        try Data(Self.blankHtml(title).utf8).write(to: dir.appendingPathComponent("index.html"))
        return try findPage(norm)
    }

    /// Move a page or folder to `<vault>/.trash/<name>` (numbered when the name is taken).
    /// Refused while an agent holds a lock on the page or on any page under the folder.
    /// Returns the vault paths of the files that went (for VaultChanges).
    @discardableResult
    func trash(_ path: String) throws -> [String] {
        let norm = try Self.normPath(path)
        guard !norm.isEmpty else { throw VaultEditError.notFound(path) }
        let src = try pathDir(norm)
        let fm = FileManager.default
        guard fm.fileExists(atPath: src.path) else { throw VaultEditError.notFound(norm) }
        if isPageDir(src), lock(id: readManifest(src)?["id"] as? String) != nil { throw VaultEditError.locked }
        if let under = try? findTree(norm), under.walked().contains(where: \.isLocked) { throw VaultEditError.locked }
        let trash = root.appendingPathComponent(".trash", isDirectory: true)
        try fm.createDirectory(at: trash, withIntermediateDirectories: true)
        let name = src.lastPathComponent
        var dest = trash.appendingPathComponent(name, isDirectory: true)
        var n = 2
        while fm.fileExists(atPath: dest.path) {
            dest = trash.appendingPathComponent("\(name) \(n)", isDirectory: true)
            n += 1
        }
        var files: [String] = []
        for case let rel as String in fm.enumerator(atPath: src.path) ?? FileManager.DirectoryEnumerator() {
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: src.appendingPathComponent(rel).path, isDirectory: &isDir), !isDir.boolValue {
                files.append("\(norm)/\(rel)")
            }
        }
        try fm.moveItem(at: src, to: dest)
        return files
    }

    /// The children of the folder at `path` (nil when it's not a folder in the tree).
    private func findTree(_ path: String) throws -> [VaultNode]? {
        listTree().walked().first { $0.path == path && $0.kind == .folder }?.children
    }
}
