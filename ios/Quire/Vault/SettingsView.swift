import SwiftUI

/// Settings: Sync (M-004's screen), Editor, About.
struct SettingsView: View {
    var body: some View {
        List {
            Section {
                NavigationLink(value: VaultRoute.syncSettings) {
                    Label("Sync", systemImage: "arrow.triangle.2.circlepath")
                }
                NavigationLink(value: VaultRoute.editorSettings) {
                    Label("Editor", systemImage: "textformat.size")
                }
            }
            Section("About") {
                LabeledContent("Version", value: Self.version)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.sidebar)
        .toolbarBackground(Theme.sidebar, for: .navigationBar)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }

    static var version: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "?"
        let b = info?["CFBundleVersion"] as? String
        return b.map { "\(v) (\($0))" } ?? v
    }
}

/// Settings › Editor: page text size, applied to pages as they next open.
struct EditorSettingsView: View {
    @State private var textSize = EditorPrefs.textSize

    var body: some View {
        List {
            Section {
                Stepper(value: $textSize, in: EditorPrefs.range) {
                    LabeledContent("Text size", value: "\(textSize) pt")
                }
                Text("The quick brown fox jumps over the lazy dog.")
                    // A preview of the page size itself, so a literal point size is the point.
                    .font(.system(size: CGFloat(textSize)))
                    .foregroundStyle(Theme.ink)
                    .padding(.vertical, 4)
            } footer: {
                Text("Pages pick this up the next time they open.")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.sidebar)
        .navigationTitle("Editor")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: textSize) { _, v in EditorPrefs.textSize = v }
    }
}
