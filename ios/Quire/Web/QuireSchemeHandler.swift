import Foundation
import WebKit

/// `quire://` for WKWebView, mirroring app/main/protocol.mjs:
/// - `quire://runtime/<file>`: the bundled copy of app/runtime (runtime.js, theme.css,
///   vendor/*.mjs, fonts).
/// - `quire://vault/<page path>/`: the page's entry, transformed by the Mac's own
///   transformEntry (in JavaScriptCore): indexBody, the import map + theme + runtime head,
///   markdown rendered first. Other files under the page are served raw.
/// - A locked page (an agent is editing it on the Mac) is served from its snapshot; `data/`,
///   The manifest (`.noteblock` / `.quire`) and the backend folder are never served; `/api/…` answers 503 (backends run on
///   the Mac only).
final class QuireSchemeHandler: NSObject, WKURLSchemeHandler {
    struct Hooks {
        /// A page's entry was served (opening it, or an embed of it). Called off the main thread.
        var onEntry: ((String) -> Void)?
        /// The editor settings passed to transformEntry (config.json "editor" on the Mac).
        /// [:] gives the defaults.
        var editorPrefs: () -> [String: Any] = { [:] }
    }

    let vault: VaultStore
    let host: HostJS
    let runtimeRoot: URL
    var hooks: Hooks

    private let queue = DispatchQueue(label: "org.harborapps.quire.scheme", qos: .userInitiated, attributes: .concurrent)
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()

    init(vault: VaultStore, host: HostJS = .shared, runtimeRoot: URL? = nil, hooks: Hooks = Hooks()) {
        self.vault = vault
        self.host = host
        self.runtimeRoot = (runtimeRoot ?? Bundle.main.url(forResource: "runtime", withExtension: nil) ?? Bundle.main.bundleURL).standardizedFileURL
        self.hooks = hooks
    }

    // MARK: - WKURLSchemeHandler

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        queue.async { [weak self] in
            guard let self else { return }
            let result = self.resolve(task.request)
            self.lock.lock()
            defer { self.lock.unlock() }
            // Calling into a stopped task raises an exception.
            if self.stopped.remove(id) != nil { return }
            self.respond(task, result)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock()
        stopped.insert(ObjectIdentifier(task))
        lock.unlock()
    }

    // MARK: - Resolving

    enum Result {
        case notFound(Int, String)
        case file(URL, String)
        case body(Data, String)
    }

    func resolve(_ request: URLRequest) -> Result {
        guard let url = request.url, url.scheme == "quire" else { return .notFound(404, "Not a quire URL") }
        let encodedPath = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
        switch url.host {
        case "runtime": return resolveRuntime(encodedPath)
        case "vault": return resolveVault(encodedPath)
        default: return .notFound(404, "Unknown host: \(url.host ?? "")")
        }
    }

    private func decodeSegs(_ pathname: String) -> [String]? {
        var out: [String] = []
        for raw in pathname.split(separator: "/") where !raw.isEmpty {
            guard let s = String(raw).removingPercentEncoding else { return nil }
            out.append(s)
        }
        return out
    }

    func resolveRuntime(_ pathname: String) -> Result {
        guard let segs = decodeSegs(pathname), !segs.isEmpty,
              !segs.contains(where: { $0 == ".." || $0 == "." || $0.contains("\0") }) else {
            return .notFound(404, "Not found")
        }
        let file = segs.reduce(runtimeRoot) { $0.appendingPathComponent($1) }.standardizedFileURL
        guard file.path.hasPrefix(runtimeRoot.path + "/"), isFile(file) else {
            return .notFound(404, "Not found: \(segs.joined(separator: "/"))")
        }
        return .file(file, host.contentType(file.lastPathComponent))
    }

    func resolveVault(_ pathname: String) -> Result {
        guard let segs = decodeSegs(pathname) else { return .notFound(404, "Bad path") }
        if segs.contains(where: { $0 == ".." || $0 == "." || $0.contains("\0") || $0.contains("\\") }) {
            return .notFound(404, "Bad path")
        }
        let root = vault.root

        // The page part: leading folders up to the first one holding a manifest (.noteblock or .quire).
        var pageSegs: [String]?
        var fileSegs: [String] = []
        var dir = root
        for (i, s) in segs.enumerated() {
            if s.isEmpty || s.hasPrefix(".") { break }
            dir = dir.appendingPathComponent(s, isDirectory: true)
            if vault.isPageDir(dir) {
                pageSegs = Array(segs[...i])
                fileSegs = Array(segs[(i + 1)...])
                break
            }
        }
        guard let pageSegs else {
            if segs.first == "api" { return .notFound(503, "Page backends run on your Mac") }
            // A plain file in a folder (not inside any page) is served as itself.
            if !segs.isEmpty, !segs.contains(where: { $0.hasPrefix(".") }) {
                let loose = segs.reduce(root) { $0.appendingPathComponent($1) }
                if isFile(loose) { return .file(loose, host.contentType(loose.lastPathComponent)) }
            }
            return .notFound(404, "No page: \(segs.joined(separator: "/"))")
        }
        let pagePath = pageSegs.joined(separator: "/")

        // Personal data is never served.
        if fileSegs.first == "data" { return .notFound(404, "Not found") }

        let manifest = vault.readManifest(dir) ?? [:]
        if let backend = VaultStore.parseBackend(manifest["backend"]) {
            let rel = fileSegs.joined(separator: "/")
            if rel == backend.dir || rel.hasPrefix(backend.dir + "/") { return .notFound(404, "Not found") }
            if backend.proxy != nil, fileSegs.first == "api" {
                return .notFound(503, "\(pagePath) has a backend, which runs on your Mac")
            }
        }
        let id = manifest["id"] as? String
        let base = (id.flatMap { vault.lock(id: $0) } != nil) ? vault.snapshotDir(id: id!) : dir

        if let first = fileSegs.first, VaultNames.isMeta(first) { return .notFound(404, "Not found") }
        let title = (manifest["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? pageSegs.last!
        let entry = vault.entryFile(base, manifest: manifest)
        if fileSegs.isEmpty || fileSegs.joined(separator: "/") == entry {
            let file = base.appendingPathComponent(entry)
            let format = entry.lowercased().hasSuffix(".md") ? "md" : "html"
            var src: String?
            if let data = FileManager.default.contents(atPath: file.path) {
                src = String(decoding: data, as: UTF8.self)
            } else if fileSegs.isEmpty {
                src = "<!doctype html><html><head><meta charset=\"utf-8\"><title>\(Self.escAttr(title))</title></head><body></body></html>"
            }
            if let src {
                var baseHref: String?
                if let slash = entry.lastIndex(of: "/") {
                    let entryDir = entry[..<slash].split(separator: "/").map(String.init)
                    baseHref = "quire://vault/" + (pageSegs + entryDir).map(Self.encodeURIComponent).joined(separator: "/") + "/"
                }
                do {
                    let html = try host.transformEntry(src, format: format, pagePath: pagePath, title: title, baseHref: baseHref, editor: hooks.editorPrefs())
                    hooks.onEntry?(pagePath)
                    return .body(Data(Self.addViewport(html).utf8), "text/html; charset=utf-8")
                } catch {
                    return .notFound(500, "Could not render \(pagePath): \(error.localizedDescription)")
                }
            }
        }

        let file = fileSegs.reduce(base) { $0.appendingPathComponent($1) }.standardizedFileURL
        guard file.path.hasPrefix(base.standardizedFileURL.path + "/") else { return .notFound(404, "Not found") }
        guard isFile(file) else { return .notFound(404, "Not found: \(fileSegs.joined(separator: "/"))") }
        return .file(file, host.contentType(file.lastPathComponent))
    }

    // MARK: - Helpers

    /// A phone needs a viewport, which desktop entries don't carry. It goes first in the
    /// injected head block (right before the quire-page meta transformEntry adds).
    static func addViewport(_ html: String) -> String {
        let meta = #"<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">"#
        guard let r = html.range(of: #"<meta name="quire-page""#) else { return html }
        return html.replacingCharacters(in: r.lowerBound..<r.lowerBound, with: meta)
    }

    static func escAttr(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }

    private static let uriComponentAllowed: CharacterSet = {
        CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!~*'()")
    }()

    /// JavaScript's encodeURIComponent.
    static func encodeURIComponent(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) ?? s
    }

    private func isFile(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && !isDir.boolValue
    }

    private static let noCache = [
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "Access-Control-Allow-Origin": "*",
    ]

    private func respond(_ task: WKURLSchemeTask, _ result: Result) {
        guard let url = task.request.url else { return }
        var status = 200
        var type = "text/plain; charset=utf-8"
        var body = Data()
        switch result {
        case .notFound(let code, let text):
            status = code
            body = Data(text.utf8)
        case .body(let data, let t):
            body = data
            type = t
        case .file(let file, let t):
            guard let data = FileManager.default.contents(atPath: file.path) else {
                status = 404
                body = Data("Not found".utf8)
                break
            }
            body = data
            type = t
        }
        var headers = Self.noCache
        headers["Content-Type"] = type
        headers["Content-Length"] = String(body.count)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }
}
