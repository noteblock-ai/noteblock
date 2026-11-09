import SwiftUI
import UIKit
import WebKit

/// The native half of the editor: talks to `window.quire.editor` in the page
/// (app/runtime/runtime.js, "native editor commands") and hears back on the `quireEditor`
/// script message handler. Owns the keyboard bar installed over WKWebView's own.
@MainActor
final class EditorSession: ObservableObject {
    /// What `quire.editor.state()` reports for the caret.
    struct State: Equatable {
        var editing = false
        var bold = false
        var italic = false
        /// "p", "h1"…"h3", "ol", "ul", "checklist", "quote", "code".
        var block = "p"
        var canUndo = false
        var canRedo = false
        var saving = false
    }

    @Published private(set) var state = State()
    @Published var showInsert = false

    private weak var controller: PageController?
    private weak var installedOn: WKWebView?
    private var accessory: UIView?

    /// Wires the message handler and the keyboard bar into the controller's web view. Safe to
    /// call repeatedly; returns false until the web view exists.
    @discardableResult
    func attach(_ controller: PageController) -> Bool {
        self.controller = controller
        guard let webView = controller.webView else { return false }
        if installedOn !== webView {
            let ucc = webView.configuration.userContentController
            ucc.removeScriptMessageHandler(forName: "quireEditor")
            ucc.add(EditorMessageHandler(self), name: "quireEditor")
            installedOn = webView
        }
        return KeyboardAccessory.install(on: webView) { [weak self] in
            MainActor.assumeIsolated { self?.accessoryView() }
        }
    }

    private func accessoryView() -> UIView? {
        guard let controller, controller.mode.edit else { return nil }
        if let accessory { return accessory }
        let view = KeyboardBarHost(session: self)
        accessory = view
        return view
    }

    /// Edit mode turned on or off: the keyboard bar comes or goes.
    func modeChanged() {
        if let webView = controller?.webView { KeyboardAccessory.reload(on: webView) }
        if controller?.mode.edit == false {
            state = State()
        } else {
            // The caret into the page once the runtime has applied the mode (a tap that
            // started editing has already put it under the finger; focus() keeps that).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.focus() }
        }
    }

    // MARK: - Commands

    /// `quire.editor.<call>` in the top page, with `args` bound as JS variables.
    func run(_ call: String, _ args: [String: Any] = [:]) {
        guard let webView = controller?.webView else { return }
        let js = "var e = window.quire && window.quire.editor; return e ? e.\(call) : null"
        webView.callAsyncJavaScript(js, arguments: args, in: nil, in: .page) { result in
            if case .failure(let error) = result { print("[quire] editor.\(call) failed: \(error.localizedDescription)") }
        }
    }

    func bold() { run("bold()") }
    func italic() { run("italic()") }
    func heading(_ level: Int) { run("heading(level)", ["level": level]) }
    func list(_ kind: String) { run("list(kind)", ["kind": kind]) }
    func checklist() { run("checklist()") }
    func indent() { run("indent()") }
    func outdent() { run("outdent()") }
    func undo() { run("undo()") }
    func redo() { run("redo()") }
    func insertBlock(_ kind: String) { run("insertBlock(kind)", ["kind": kind]) }
    func insertEmbed(_ path: String) { run("insertEmbed(path)", ["path": path]) }
    func insertImage(_ src: String, alt: String = "") { run("insertImage(src, alt)", ["src": src, "alt": alt]) }
    func focus() { run("focus()") }
    func setTapToEdit(_ on: Bool) { run("setTapToEdit(on)", ["on": on]) }

    func hideKeyboard() {
        run("blur()")
        controller?.webView?.endEditing(true)
    }

    // MARK: - Messages from the page

    fileprivate func receive(_ body: Any) {
        guard let obj = body as? [String: Any] else { return }
        switch obj["type"] as? String {
        case "state":
            var s = State()
            s.editing = obj["editing"] as? Bool ?? false
            s.bold = obj["bold"] as? Bool ?? false
            s.italic = obj["italic"] as? Bool ?? false
            s.block = obj["block"] as? String ?? "p"
            s.canUndo = obj["canUndo"] as? Bool ?? false
            s.canRedo = obj["canRedo"] as? Bool ?? false
            s.saving = obj["saving"] as? Bool ?? false
            if s != state { state = s }
        case "tap-edit":
            // The runtime already turned the editor on inside the tap; catch the app's mode up.
            if let controller, !controller.mode.edit, controller.canEdit { controller.setEditing(true) }
        default:
            break
        }
    }
}

/// WKUserContentController retains its handlers; this keeps it from retaining the session.
private final class EditorMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: EditorSession?
    init(_ target: EditorSession) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        MainActor.assumeIsolated { target?.receive(message.body) }
    }
}

/// The keyboard bar as a UIKit view the keyboard can hold (inputAccessoryView).
private final class KeyboardBarHost: UIView {
    private let host: UIHostingController<EditorKeyboardBar>

    init(session: EditorSession) {
        host = UIHostingController(rootView: EditorKeyboardBar(session: session))
        super.init(frame: CGRect(x: 0, y: 0, width: UIScreen.main.bounds.width, height: EditorKeyboardBar.height))
        autoresizingMask = [.flexibleWidth]
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: trailingAnchor),
            host.view.topAnchor.constraint(equalTo: topAnchor),
            host.view.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: EditorKeyboardBar.height)
    }
}

extension LaunchOptions {
    /// `-editPage "<path or id>"`: that page opens in edit mode (with -openPage, or once
    /// ContentView also opens it; see PageScreen).
    static var editPage: String? {
        UserDefaults.standard.string(forKey: "editPage").flatMap { $0.isEmpty ? nil : $0 }
    }
}
