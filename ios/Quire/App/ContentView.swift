import SwiftUI

/// The navigation shell: the vault home, pushing folders, pages and settings.
struct ContentView: View {
    @ObservedObject var vault: VaultModel
    @StateObject private var nav = VaultNavigator()
    @StateObject private var index = VaultIndex()
    @State private var launched = false

    var body: some View {
        NavigationStack(path: $nav.path) {
            Group {
                if let error = vault.error {
                    ContentUnavailableView("Couldn't open the vault", systemImage: "exclamationmark.triangle", description: Text(error))
                } else {
                    VaultHomeView(vault: vault)
                }
            }
            .navigationDestination(for: VaultRoute.self) { route in
                destination(route)
            }
        }
        .environmentObject(nav)
        .environmentObject(index)
        .tint(Theme.accent)
        .onAppear(perform: launch)
        .onReceive(vault.$tree) { _ in index.update(pages: vault.pages) }
    }

    @ViewBuilder
    private func destination(_ route: VaultRoute) -> some View {
        switch route {
        case .page(let pagePath):
            if let store = vault.store, let handler = vault.schemeHandler, let page = vault.page(pagePath) {
                PageScreen(page: page, store: store, schemeHandler: handler)
                    .onAppear { RecentPages.shared.record(page.path) }
            } else {
                ContentUnavailableView("No page: \(pagePath)", systemImage: "doc.questionmark")
            }
        case .folder(let folderPath):
            VaultFolderView(vault: vault, path: folderPath)
        case .settings:
            SettingsView()
        case .syncSettings:
            SyncSettingsView()
        case .editorSettings:
            EditorSettingsView()
        }
    }

    /// Launch arguments for screenshots and tests: `-openPage "<path or id>"`,
    /// `-openSettings YES` (`-search "<text>"` is read by the home screen).
    private func launch() {
        guard !launched else { return }
        launched = true
        if LaunchOptions.openSettings {
            nav.push(.settings)
        } else if let ref = LaunchOptions.openPage ?? LaunchOptions.editPage, let page = vault.page(ref) {
            nav.push(.page(page.path))
        }
    }
}
