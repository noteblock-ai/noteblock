import SwiftUI
import UIKit
import WebKit

/// Owns one page's WKWebView: loads `quire://vault/<page>/`, answers its rpcs through the
/// `quire` script message handler (RpcHandling, filled by M-002) and sends it the same
/// `{quire: 1, type: "mode" | "store-changed"}` messages the desktop renderer posts.
///
/// The page is the TOP frame here (no iframe around it). runtime.js sees
/// `window.webkit.messageHandlers.quire` and switches to the native transport: rpcs arrive as
/// `{id, method, params, page}` and are answered with `window.__quireRpcReply(id, ok, value)`
/// in the frame that asked (embeds are iframes and ask for themselves).
@MainActor
final class PageController: NSObject, ObservableObject {
    struct Mode: Equatable {
        var edit = false
        var readOnly = false
        /// Built pages save on demand (⌘S on the Mac) instead of autosaving.
        var manualSave = false
    }

    let page: VaultNode
    let bridge: RpcHandling
    let schemeHandler: QuireSchemeHandler

    @Published private(set) var isLoading = true
    @Published private(set) var loadError: String?
    /// The mode last sent (or to be sent once the page loads).
    @Published private(set) var mode: Mode

    private(set) weak var webView: WKWebView?

    init(page: VaultNode, bridge: RpcHandling, schemeHandler: QuireSchemeHandler) {
        self.page = page
        self.bridge = bridge
        self.schemeHandler = schemeHandler
        // Reading mode by default (the Mobile design: Edit turns the editor on). A page an
        // agent is editing on the Mac is read-only; store writes are refused then.
        self.mode = Mode(edit: false, readOnly: page.isLocked, manualSave: page.isBuilt)
        super.init()
        // A store/kv write → `store-changed` to the page and its embeds (desktop App.jsx).
        bridge.onStoreChanged = { [weak self] changed, table in self?.notifyStoreChanged(page: changed, table: table) }
    }

    static func pageURL(_ path: String) -> URL {
        let encoded = path.split(separator: "/").map { QuireSchemeHandler.encodeURIComponent(String($0)) }.joined(separator: "/")
        return URL(string: "quire://vault/\(encoded)/")!
    }

    var url: URL { Self.pageURL(page.path) }

    /// Whether this page may enter edit mode on the phone: Quire's editor renderer, not
    /// locked, no backend (Mac only).
    var canEdit: Bool { page.renderer == "quire" && !page.isLocked && !page.hasBackend }

    // MARK: - Web view

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: "quire")
        config.userContentController.add(WeakMessageHandler(self), name: "quire")
        #if DEBUG
        // Page console errors, uncaught errors and rejections → the app's log (every frame).
        config.userContentController.add(ConsoleLogHandler(), name: "quireLog")
        config.userContentController.addUserScript(WKUserScript(source: ConsoleLogHandler.script, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        #endif
        config.allowsInlineMediaPlayback = true
        config.dataDetectorTypes = []
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = Theme.uiBackground
        web.scrollView.backgroundColor = Theme.uiBackground
        web.scrollView.contentInsetAdjustmentBehavior = .automatic
        web.scrollView.keyboardDismissMode = .interactive
        web.allowsLinkPreview = false
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }
        #endif
        webView = web
        web.load(URLRequest(url: url))
        return web
    }

    func reload() {
        loadError = nil
        webView?.load(URLRequest(url: url))
    }

    // MARK: - Messages to the page

    /// Turn edit mode on or off, the way the desktop renderer does: a `mode` message the
    /// runtime applies to the top page and relays to its embeds. Off keeps store writes
    /// working (apps stay live in reading mode) unless the page is locked.
    func setEditing(_ edit: Bool) {
        setMode(Mode(edit: edit && canEdit, readOnly: page.isLocked, manualSave: page.isBuilt))
    }

    func setMode(_ newMode: Mode) {
        mode = newMode
        if !isLoading { sendMode() }
    }

    private func sendMode() {
        post(["quire": 1, "type": "mode", "edit": mode.edit, "readOnly": mode.readOnly, "manualSave": mode.manualSave])
    }

    /// Tell the page (and its embeds) a table changed, so `subscribe` callbacks fire.
    /// table nil = kv.
    func notifyStoreChanged(page changed: String, table: String?) {
        post(["quire": 1, "type": "store-changed", "page": changed, "table": table ?? NSNull()])
    }

    /// Ask the runtime to save pending edits now (the desktop's "save" message).
    func flushSave() {
        post(["quire": 1, "type": "save"])
    }

    /// `window.postMessage(message, "*")` in the top frame; the runtime treats it as coming
    /// from its host.
    func post(_ message: [String: Any]) {
        webView?.callAsyncJavaScript("window.postMessage(message, \"*\")", arguments: ["message": message], in: nil, in: .page) { result in
            if case .failure(let error) = result { print("[quire] post failed: \(error.localizedDescription)") }
        }
    }

    // MARK: - Rpc

    fileprivate func receive(_ message: WKScriptMessage) {
        guard let request = RpcRequest(body: message.body, frame: message.frameInfo) else { return }
        Task { @MainActor in
            do {
                let value = try await bridge.handle(request)
                reply(request, ok: true, value: value)
            } catch {
                reply(request, ok: false, value: error.localizedDescription)
            }
        }
    }

    private func reply(_ request: RpcRequest, ok: Bool, value: Any) {
        guard let webView else { return }
        let js = "window.__quireRpcReply && window.__quireRpcReply(id, ok, value)"
        webView.callAsyncJavaScript(js, arguments: ["id": request.id, "ok": ok, "value": value], in: request.frame, in: .page) { result in
            if case .failure(let error) = result { print("[quire] rpc reply failed (\(request.method)): \(error.localizedDescription)") }
        }
    }
}

extension PageController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        switch url.scheme?.lowercased() {
        case "quire", "about", "blob", "data":
            return .allow
        case "http", "https", "mailto", "tel":
            // Links out of the vault open outside the app (contract: "Links").
            if action.navigationType == .linkActivated || action.targetFrame == nil {
                await UIApplication.shared.open(url)
                return .cancel
            }
            return .allow
        default:
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        sendMode()
        #if DEBUG
        // -debugEval "<js expression>": evaluated in the page 1.5 s after it loads, result
        // printed as `[debugEval] …`. For checking page state from the shell.
        if let js = LaunchOptions.debugEval {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak webView] in
                // A promise is awaited, so an expression can wait for the page.
                webView?.callAsyncJavaScript("try { return String(await (\(js))) } catch (e) { return 'threw: ' + e }", arguments: [:], in: nil, in: .page) { result in
                    switch result {
                    case .success(let value): print("[debugEval] \(value)")
                    case .failure(let error): print("[debugEval] failed: \(error.localizedDescription)")
                    }
                }
            }
        }
        #endif
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        loadError = error.localizedDescription
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        loadError = error.localizedDescription
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reload()
    }
}

/// WKUserContentController retains its handlers; this keeps it from retaining the controller.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: PageController?
    init(_ target: PageController) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { target?.receive(message) }
    }
}

#if DEBUG
/// DEBUG only: forwards console.error/warn/log, window errors and unhandled rejections from
/// every frame to the app log as `[page <path>] …` (see them with `log stream` or Xcode).
private final class ConsoleLogHandler: NSObject, WKScriptMessageHandler {
    static let script = """
    (function () {
      var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.quireLog;
      if (!h) return;
      var send = function (level, args) {
        try { h.postMessage({ level: level, url: location.href, text: Array.prototype.map.call(args, function (a) {
          if (a instanceof Error) return a.message + (a.stack ? "\\n" + a.stack : "");
          try { return typeof a === "string" ? a : JSON.stringify(a); } catch (e) { return String(a); }
        }).join(" ") }); } catch (e) {}
      };
      ["log", "warn", "error"].forEach(function (k) {
        var orig = console[k];
        console[k] = function () { send(k, arguments); return orig.apply(console, arguments); };
      });
      window.addEventListener("error", function (e) { send("error", [e.message + " @ " + (e.filename || "") + ":" + (e.lineno || "")]); });
      window.addEventListener("unhandledrejection", function (e) { send("error", ["Unhandled rejection:", e.reason]); });
    })();
    """

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        print("[page \(body["level"] ?? "log")] \(body["url"] ?? ""): \(body["text"] ?? "")")
    }
}
#endif

/// A page, full screen. Hosts the controller's web view.
struct PageWebView: UIViewRepresentable {
    @ObservedObject var controller: PageController

    func makeUIView(context: Context) -> WKWebView {
        controller.webView ?? controller.makeWebView()
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
