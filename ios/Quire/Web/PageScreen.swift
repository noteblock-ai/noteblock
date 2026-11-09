import SwiftUI
import UIKit

/// One page, full screen. Reading mode (MobilePage.dc.html): back, the page menu and an Edit
/// capsule; a tap on text also starts editing. Edit mode (MobileEdit.dc.html): Undo/Redo,
/// the save status and Done, with the keyboard bar (Editor/) above the keyboard.
struct PageScreen: View {
    @StateObject private var controller: PageController
    @StateObject private var editor = EditorSession()
    @State private var showSource = false
    private let store: VaultStore

    init(page: VaultNode, store: VaultStore, schemeHandler: QuireSchemeHandler) {
        self.store = store
        _controller = StateObject(wrappedValue: PageController(
            page: page,
            bridge: RpcBridge(vault: store),
            schemeHandler: schemeHandler
        ))
    }

    private var editing: Bool { controller.mode.edit }

    var body: some View {
        PageWebView(controller: controller)
            .ignoresSafeArea(.container, edges: .bottom)
            .background(Theme.background)
            .overlay {
                if let error = controller.loadError {
                    ContentUnavailableView {
                        Label("Couldn't open this page", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try Again") { controller.reload() }
                    }
                    .background(Theme.background)
                }
            }
            .navigationTitle(controller.page.title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(editing)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbar { if editing { editToolbar } else { readingToolbar } }
            .sheet(isPresented: $editor.showInsert) {
                InsertSheet(page: controller.page, pages: store.allPages()) { insertion in
                    switch insertion {
                    case .block(let kind): editor.insertBlock(kind)
                    case .embed(let path): editor.insertEmbed(path)
                    case .image(let src): editor.insertImage(src)
                    }
                }
            }
            .sheet(isPresented: $showSource) {
                SourceView(page: controller.page)
            }
            .task { await attachEditor() }
            .onChange(of: controller.mode.edit) { _, _ in editor.modeChanged() }
            .onChange(of: controller.isLoading) { _, loading in
                if !loading { editor.setTapToEdit(controller.canEdit) }
            }
    }

    @ToolbarContentBuilder
    private var readingToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Menu {
                Button { showSource = true } label: { Label("Show source", systemImage: "chevron.left.forwardslash.chevron.right") }
                Button { UIPasteboard.general.string = controller.page.path } label: { Label("Copy path", systemImage: "doc.on.doc") }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(Theme.muted)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Page menu")

            if controller.canEdit {
                Button { controller.setEditing(true) } label: {
                    Text("Edit")
                        .font(.subheadline.weight(.medium))
                        .padding(.horizontal, 14)
                        .frame(minHeight: 36)
                        .background(EditorTheme.accentSoft, in: Capsule())
                        .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ToolbarContentBuilder
    private var editToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarLeading) {
            Button(action: editor.undo) {
                Image(systemName: "arrow.uturn.backward").frame(width: 44, height: 44)
            }
            .disabled(!editor.state.canUndo)
            .accessibilityLabel("Undo")
            Button(action: editor.redo) {
                Image(systemName: "arrow.uturn.forward").frame(width: 44, height: 44)
            }
            .disabled(!editor.state.canRedo)
            .accessibilityLabel("Redo")
        }
        ToolbarItem(placement: .principal) {
            Text(editor.state.saving ? "Saving…" : "Saved")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .contentTransition(.opacity)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                editor.hideKeyboard()
                controller.flushSave()
                controller.setEditing(false)
            } label: {
                Text("Done")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 16)
                    .frame(minHeight: 36)
                    .background(Theme.accent, in: Capsule())
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
        }
    }

    /// The web view exists once PageWebView has been made; wire the editor into it, and
    /// honour `-editPage`.
    private func attachEditor() async {
        for _ in 0..<40 {
            if editor.attach(controller) { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
        let launchEdit = LaunchOptions.editPage.map { $0 == controller.page.path || $0 == controller.page.pageId } ?? false
        // A page made with + opens ready to type (PageOpenIntent, set by the vault screens).
        if (launchEdit || PageOpenIntent.consumeEdit(controller.page.path)), controller.canEdit, !editing {
            controller.setEditing(true)
        }
    }
}

/// "Show source": the page's entry file, read only.
private struct SourceView: View {
    let page: VaultNode
    @Environment(\.dismiss) private var dismiss
    @State private var text: String?

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                Text(text ?? "")
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .background(Theme.background)
            .navigationTitle(page.entry)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.bold()
                }
            }
        }
        .task {
            let url = page.dir.appendingPathComponent(page.entry)
            text = (try? String(contentsOf: url, encoding: .utf8)) ?? "Couldn't read \(page.entry)."
        }
    }
}
