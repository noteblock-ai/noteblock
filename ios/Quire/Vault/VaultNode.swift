import Foundation

/// One row of the vault tree, as core/pages.mjs `listTree` returns it (docs/contract.md,
/// "Vault format"): a folder, a page (a folder holding a `.quire` file) or a plain file.
struct VaultNode: Identifiable, Hashable {
    enum Kind: String { case folder, page, file }
    enum Format: String { case html, md, none }

    struct Backend: Hashable {
        /// The backend folder (default "backend"); never served to the page.
        var dir: String
        /// Process name → command.
        var run: [String: String]
        /// The process /api/* goes to.
        var proxy: String?
    }

    struct Lock: Hashable {
        var id: String
        var path: String?
        var by: String?
        var message: String?
        var startedAt: String?
    }

    var kind: Kind
    /// The page's `.quire` id (pages only).
    var pageId: String?
    /// Manifest title, else the folder (or file) name.
    var title: String
    /// Vault-relative path, "Kyoto trip/Trip budget". Also the Identifiable id.
    var path: String
    /// Absolute folder of a page or folder; the containing folder for a plain file.
    var dir: URL
    var entry: String = "index.html"
    var source: String?
    var build: String?
    /// "quire" (editor), "view" (rendered, no text editing) or "source".
    var renderer: String = "quire"
    var embedHeight: Int?
    var backend: Backend?
    var format: Format = .none
    var children: [VaultNode] = []
    var lock: Lock?

    var id: String { path }
    var name: String { path.split(separator: "/").last.map(String.init) ?? path }
    /// The folder holding this node ("" at the vault root).
    var parentPath: String { path.split(separator: "/").dropLast().joined(separator: "/") }

    var isPage: Bool { kind == .page }
    var isMarkdown: Bool { format == .md }
    /// The page runs a backend (node processes): Mac only, read-only on the phone.
    var hasBackend: Bool { backend != nil }
    /// The page is built (`.quire` "build"): its committed output is shown, never rebuilt here.
    var isBuilt: Bool { build != nil }
    var isLocked: Bool { lock != nil }
}

extension Array where Element == VaultNode {
    /// Every node, depth first, in tree order (core's walkTree).
    func walked() -> [VaultNode] {
        flatMap { [$0] + $0.children.walked() }
    }
}
