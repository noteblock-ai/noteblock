import SwiftUI

/// Settings › Sync. Pushed from the vault's settings screen (designs/canvas/project/MobileSync.dc.html).
struct SyncSettingsView: View {
    @ObservedObject private var engine = SyncEngine.shared

    var body: some View {
        Group {
            if engine.isSetUp {
                SyncStatusForm(engine: engine)
            } else {
                ConnectGitHubForm(engine: engine)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.sidebar)
        .navigationTitle("Sync")
        .tint(Theme.accent)
    }
}

// MARK: - Connected

private struct SyncStatusForm: View {
    @ObservedObject var engine: SyncEngine
    @State private var pageCount: Int?
    @State private var backendCount = 0
    @State private var showError = false
    @State private var confirmDisconnect = false
    @State private var comparing: SyncConflict?

    private var dotColor: Color {
        if engine.isHealthy { return Color(hex: 0x1E8E5A) }
        return engine.lastError != nil && engine.statusText != "Offline" ? .red : Color(hex: 0xA3A9B3)
    }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 12) {
                    Circle().fill(dotColor).frame(width: 10, height: 10).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(engine.isSyncing ? (engine.phase ?? engine.statusText) : engine.statusText)
                            .font(.body.weight(.medium))
                        Text(pageCount.map { "\($0) \($0 == 1 ? "page" : "pages") · on this iPhone" } ?? "On this iPhone")
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture { if engine.lastError != nil { showError = true } }
                    .accessibilityAddTraits(engine.lastError != nil ? .isButton : [])
                    Button("Sync now") { Task { await engine.syncNow() } }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .disabled(engine.isSyncing)
                }
                .padding(.vertical, 6)

                if let c = engine.config {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Remote").font(.footnote).foregroundStyle(Theme.muted)
                        Text(verbatim: "github.com/\(c.fullName)")
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 2)
                }
                LabeledContent("Check for changes", value: "On open, every 5 min")
            }

            if !engine.conflicts.isEmpty || backendCount > 0 {
                Section("Needs a look") {
                    ForEach(engine.conflicts) { c in
                        VStack(alignment: .leading, spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(Self.title(c.path)) was changed on both devices")
                                    .font(.body.weight(.medium))
                                Text("This iPhone's version is kept as “\(Self.fileName(c.copy))”.")
                                    .font(.footnote)
                                    .foregroundStyle(Theme.muted)
                            }
                            HStack(spacing: 8) {
                                Button("Compare") { comparing = c }
                                Button("Keep both") { engine.dismissConflict(c) }
                            }
                            .buttonStyle(.bordered)
                            .tint(Theme.ink)
                        }
                        .padding(.vertical, 4)
                    }
                    if backendCount > 0 {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(backendCount) \(backendCount == 1 ? "page runs" : "pages run") on your Mac")
                                    .font(.body.weight(.medium))
                                Text("They have a backend. Open read-only here.")
                                    .font(.footnote)
                                    .foregroundStyle(Theme.muted)
                            }
                        } icon: {
                            Image(systemName: "desktopcomputer").foregroundStyle(Theme.muted)
                        }
                    }
                }
            }

            Section {
                Button("Disconnect", role: .destructive) { confirmDisconnect = true }
            }
        }
        .task(id: engine.config?.lastSyncAt) { await countPages() }
        .alert("Sync failed", isPresented: $showError) {
            Button("Try again") { Task { await engine.syncNow() } }
            Button("OK", role: .cancel) {}
        } message: {
            Text(engine.lastError ?? "")
        }
        .confirmationDialog("Disconnect from GitHub?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { engine.disconnect() }
        } message: {
            Text("The vault stays on this iPhone. It stops syncing until you connect again.")
        }
        .sheet(item: $comparing) { c in
            ConflictCompareView(conflict: c, texts: engine.texts(for: c))
        }
    }

    private func countPages() async {
        guard let root = engine.vaultRoot else { return }
        let (pages, backends) = await Task.detached(priority: .utility) { () -> (Int, Int) in
            let all = VaultStore(root: root).allPages()
            return (all.count, all.filter(\.hasBackend).count)
        }.value
        pageCount = pages
        backendCount = backends
    }

    static func fileName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    /// "Journal/Oct 22/index.md" → "Oct 22"; "notes/todo.md" → "todo.md".
    static func title(_ path: String) -> String {
        let comps = path.split(separator: "/").map(String.init)
        if let last = comps.last, last.hasPrefix("index."), comps.count > 1 { return comps[comps.count - 2] }
        return comps.last ?? path
    }
}

private struct ConflictCompareView: View {
    let conflict: SyncConflict
    let texts: (remote: String, local: String)
    @Environment(\.dismiss) private var dismiss
    @State private var side = 0

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Version", selection: $side) {
                    Text("Other device").tag(0)
                    Text("This iPhone").tag(1)
                }
                .pickerStyle(.segmented)
                .padding()
                ScrollView {
                    Text(verbatim: side == 0 ? texts.remote : texts.local)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
                .background(Theme.background)
            }
            .background(Theme.sidebar)
            .navigationTitle(SyncStatusForm.title(conflict.path))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.bold()
                }
            }
        }
    }
}

// MARK: - Not connected

private struct ConnectGitHubForm: View {
    @ObservedObject var engine: SyncEngine
    @State private var repo = ""
    @State private var token = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    private static let tokenURL = URL(string: "https://github.com/settings/tokens/new?scopes=repo&description=" + (Brand.name + " for iPhone").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!)!

    var body: some View {
        Form {
            Section("Repository") {
                TextField("owner/repo", text: $repo)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .focused($focused)
            }
            Section {
                SecureField("Token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focused)
                Link(destination: Self.tokenURL) {
                    Label("Create a token", systemImage: "arrow.up.right.square")
                }
            } header: {
                Text("GitHub token")
            } footer: {
                Text("A classic token with the repo scope. It stays in this iPhone's Keychain.")
            }
            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                }
            }
            Section {
                Button {
                    Task { await connect() }
                } label: {
                    HStack(spacing: 8) {
                        if engine.isSyncing { ProgressView() }
                        Text(engine.isSyncing ? (engine.phase ?? "Connecting…") : "Connect GitHub")
                            .fontWeight(.semibold)
                    }
                }
                .disabled(engine.isSyncing || repo.isEmpty || token.isEmpty)
            }
        }
        .sensoryFeedback(.success, trigger: engine.isSetUp)
    }

    private func connect() async {
        focused = false
        error = nil
        do {
            try await engine.connect(repo: repo, token: token)
            token = ""
        } catch {
            self.error = error.localizedDescription
        }
    }
}
