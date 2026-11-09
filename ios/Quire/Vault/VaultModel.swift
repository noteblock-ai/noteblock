import Foundation
import SwiftUI

/// The app's open vault, for SwiftUI: the store plus its tree, refreshed on demand.
@MainActor
final class VaultModel: ObservableObject {
    @Published private(set) var store: VaultStore?
    @Published private(set) var tree: [VaultNode] = []
    @Published private(set) var error: String?
    /// One `quire://` handler for every page web view of this vault.
    private(set) var schemeHandler: QuireSchemeHandler?

    private var observers: [NSObjectProtocol] = []

    init() {
        // Sync picked a new vault folder (first clone), or pulled changes into this one.
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .quireVaultSelected, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.open() }
        })
        observers.append(nc.addObserver(forName: .quireVaultChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        })
    }

    /// Every page, flattened in tree order.
    var pages: [VaultNode] { tree.walked().filter(\.isPage) }

    func open() {
        do {
            let store = try VaultStore.openDefault()
            self.store = store
            schemeHandler = QuireSchemeHandler(vault: store, hooks: .init(editorPrefs: { EditorPrefs.dict() }))
            refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func refresh() {
        guard let store else { return }
        tree = store.listTree()
    }

    func page(_ ref: String) -> VaultNode? {
        try? store?.findPage(ref)
    }
}
