import SwiftUI
import UIKit

/// Everything the vault's NavigationStack can push.
enum VaultRoute: Hashable {
    case page(String)
    case folder(String)
    case settings
    case syncSettings
    case editorSettings
}

/// The stack's path, shared with every vault screen so a row, the + button or a launch
/// argument can push.
@MainActor
final class VaultNavigator: ObservableObject {
    @Published var path = NavigationPath()

    func push(_ route: VaultRoute) { path.append(route) }
}

// MARK: - Home

/// "Pages": the vault menu, search over titles and text, Recent, then the vault tree.
struct VaultHomeView: View {
    @ObservedObject var vault: VaultModel
    @EnvironmentObject private var index: VaultIndex
    @EnvironmentObject private var nav: VaultNavigator
    @ObservedObject private var recent = RecentPages.shared
    @State private var query = LaunchOptions.search ?? ""

    var body: some View {
        VaultList(vault: vault, folder: "") {
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                let hits = index.search(query, in: vault.pages)
                if hits.isEmpty {
                    ContentUnavailableView.search(text: query)
                        .listRowBackground(Color.clear)
                } else {
                    Section("Results") {
                        ForEach(hits) { hit in
                            PageRow(page: hit.page, subtitle: hit.page.parentPath.isEmpty ? nil : AttributedString(hit.page.parentPath), snippet: hit.snippet)
                        }
                    }
                }
            } else {
                let recents = recent.paths.compactMap { p in vault.pages.first { $0.path == p } }
                if !recents.isEmpty {
                    Section("Recent") {
                        ForEach(recents) { page in
                            PageRow(page: page, subtitle: AttributedString(Self.recentLine(page)))
                        }
                    }
                }
                Section("All pages") {
                    VaultTreeRows(nodes: vault.tree)
                }
            }
        }
        .navigationTitle("Pages")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search pages and text")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { VaultMenu(vault: vault) }
            ToolbarItem(placement: .topBarTrailing) {
                Button { nav.push(.settings) } label: {
                    Image(systemName: "gearshape")
                        .foregroundStyle(Theme.muted)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Settings")
            }
        }
    }

    /// "Journal · edited 9:12".
    static func recentLine(_ page: VaultNode) -> String {
        let folder = page.parentPath.split(separator: "/").last.map(String.init)
        let edited = VaultIndex.edited(page).map { "edited \(Self.relative($0))" }
        return [folder, edited].compactMap { $0 }.joined(separator: " · ")
    }

    static func relative(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(date) { return "yesterday" }
        if cal.isDate(date, equalTo: .now, toGranularity: .year) { return date.formatted(.dateTime.month(.abbreviated).day()) }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

/// The vault name at the top left: its folder in Files, and (later) other vaults.
private struct VaultMenu: View {
    @ObservedObject var vault: VaultModel

    var body: some View {
        let name = vault.store?.name ?? Brand.name
        Menu {
            Section(name) {
                Button {
                    guard let root = vault.store?.root,
                          let url = URL(string: "shareddocuments://" + (root.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? root.path))
                    else { return }
                    UIApplication.shared.open(url)
                } label: {
                    Label("Show in Files", systemImage: "folder")
                }
                Button {} label: { Label("Other vaults", systemImage: "square.stack") }
                    .disabled(true)
            }
        } label: {
            HStack(spacing: 8) {
                Text(name.prefix(1).uppercased())
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 26, height: 26)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: 6))
                Text(name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.ink)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.muted)
            }
            .frame(minHeight: 44)
        }
        .accessibilityLabel("Vault: \(name)")
    }
}

// MARK: - Folder

struct VaultFolderView: View {
    @ObservedObject var vault: VaultModel
    let path: String

    var body: some View {
        let node = vault.tree.walked().first { $0.kind == .folder && $0.path == path }
        VaultList(vault: vault, folder: path) {
            if let node {
                if node.children.contains(where: { $0.kind != .file }) {
                    Section { VaultTreeRows(nodes: node.children) }
                } else {
                    ContentUnavailableView("No pages here", systemImage: "folder", description: Text("Tap + to make one."))
                        .listRowBackground(Color.clear)
                }
            } else {
                ContentUnavailableView("No folder: \(path)", systemImage: "folder.badge.questionmark")
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle(path.split(separator: "/").last.map(String.init) ?? path)
        .navigationBarTitleDisplayMode(.large)
    }
}

// MARK: - The shared list: grouped look, footer, new page, delete, refresh

/// A grouped list of vault rows with the sync footer and + (new page in `folder`), swipe and
/// context-menu delete, and pull to refresh (rescan + sync).
private struct VaultList<Content: View>: View {
    @ObservedObject var vault: VaultModel
    let folder: String
    @ViewBuilder var content: Content

    @EnvironmentObject private var nav: VaultNavigator
    @State private var naming = false
    @State private var newName = ""
    @State private var pendingDelete: VaultNode?
    @State private var errorText: String?

    var body: some View {
        List { content }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.sidebar)
            .toolbarBackground(Theme.sidebar, for: .navigationBar)
            .environment(\.vaultRowActions, VaultRowActions(delete: { pendingDelete = $0 }))
            .refreshable {
                vault.refresh()
                await SyncEngine.shared.syncNow()
                vault.refresh()
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VaultFooter { newName = ""; naming = true }
            }
            .alert("New page", isPresented: $naming) {
                TextField("Name", text: $newName)
                Button("Cancel", role: .cancel) {}
                Button("Create", action: createPage)
                    .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
            } message: {
                if !folder.isEmpty { Text("In \(folder)") }
            }
            .confirmationDialog(
                "Delete \(pendingDelete?.title ?? "")?",
                isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { node in
                Button("Delete", role: .destructive) { delete(node) }
            } message: { node in
                Text(node.kind == .folder ? "The folder and its pages move to the vault's .trash folder." : "The page moves to the vault's .trash folder.")
            }
            .alert("Couldn't do that", isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(errorText ?? "")
            }
    }

    private func createPage() {
        guard let store = vault.store else { return }
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/", with: "-")
        guard !name.isEmpty, !name.hasPrefix(".") else {
            errorText = "Page names can't be empty or start with a dot."
            return
        }
        let p = folder.isEmpty ? name : "\(folder)/\(name)"
        do {
            let page = try store.createPage(p)
            VaultChanges.shared.markChanged(path: "\(page.path)/\(VaultStore.manifestName)")
            VaultChanges.shared.markChanged(path: "\(page.path)/\(page.entry)")
            vault.refresh()
            PageOpenIntent.requestEdit(page.path)
            nav.push(.page(page.path))
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func delete(_ node: VaultNode) {
        guard let store = vault.store else { return }
        do {
            for file in try store.trash(node.path) { VaultChanges.shared.markChanged(path: file) }
            RecentPages.shared.remove(node.path)
            vault.refresh()
        } catch {
            errorText = error.localizedDescription
        }
    }
}

private struct VaultRowActions {
    var delete: (VaultNode) -> Void = { _ in }
}

private struct VaultRowActionsKey: EnvironmentKey {
    static let defaultValue = VaultRowActions()
}

private extension EnvironmentValues {
    var vaultRowActions: VaultRowActions {
        get { self[VaultRowActionsKey.self] }
        set { self[VaultRowActionsKey.self] = newValue }
    }
}

/// Sync status and the + button, pinned under the list.
private struct VaultFooter: View {
    @ObservedObject private var sync = SyncEngine.shared
    var onNew: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 6) {
                Circle()
                    .fill(sync.isHealthy ? Color(hex: 0x1E8E5A) : Theme.muted.opacity(0.5))
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(sync.statusText)
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button(action: onNew) {
                Image(systemName: "plus")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: 14))
            }
            .accessibilityLabel("New page")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(Theme.sidebar)
        .overlay(alignment: .top) { Theme.line.frame(height: 1) }
    }
}

// MARK: - Rows

/// Folders then pages of one tree level (plain files are left out).
private struct VaultTreeRows: View {
    let nodes: [VaultNode]

    var body: some View {
        ForEach(nodes.filter { $0.kind != .file }) { node in
            if node.kind == .folder {
                FolderRow(folder: node)
            } else {
                PageRow(page: node)
            }
        }
    }
}

private struct FolderRow: View {
    let folder: VaultNode
    @Environment(\.vaultRowActions) private var actions

    var body: some View {
        let count = folder.children.walked().filter(\.isPage).count
        NavigationLink(value: VaultRoute.folder(folder.path)) {
            HStack(spacing: 12) {
                Image(systemName: "folder")
                    .foregroundStyle(Theme.muted)
                    .frame(minWidth: 24)
                    .accessibilityHidden(true)
                Text(folder.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Text("\(count)")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                    .accessibilityLabel("\(count) pages")
            }
            .frame(minHeight: 44)
        }
        .contextMenu {
            Button { UIPasteboard.general.string = folder.path } label: { Label("Copy path", systemImage: "doc.on.doc") }
            Button(role: .destructive) { actions.delete(folder) } label: { Label("Delete", systemImage: "trash") }
        }
    }
}

struct PageRow: View {
    let page: VaultNode
    var subtitle: AttributedString?
    var snippet: AttributedString?
    @EnvironmentObject private var index: VaultIndex
    @Environment(\.vaultRowActions) private var actions

    var body: some View {
        NavigationLink(value: VaultRoute.page(page.path)) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .foregroundStyle(Theme.muted)
                    .frame(minWidth: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(page.title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Theme.ink)
                    if let subtitle {
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                    }
                    if let snippet {
                        Text(snippet)
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                if page.hasBackend || page.isBuilt {
                    Text("Runs on your Mac")
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Color(hex: 0xF3F4F6), in: Capsule())
                        .overlay(Capsule().stroke(Theme.line))
                }
            }
            .frame(minHeight: 44)
            .padding(.vertical, 2)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button { actions.delete(page) } label: { Label("Delete", systemImage: "trash") }
                .tint(.red)
        }
        .contextMenu {
            Button { UIPasteboard.general.string = page.path } label: { Label("Copy path", systemImage: "doc.on.doc") }
            Button(role: .destructive) { actions.delete(page) } label: { Label("Delete", systemImage: "trash") }
        }
    }

    /// display = runs a backend; square.grid.2x2 = an app (a script or a build); doc.text = notes.
    private var icon: String {
        if page.hasBackend { return "display" }
        if page.isMarkdown { return "doc.text" }
        if page.isBuilt || index.entries[page.path]?.hasScript == true { return "square.grid.2x2" }
        return "doc.text"
    }
}
