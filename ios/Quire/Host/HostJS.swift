import Foundation
import JavaScriptCore

enum HostJSError: LocalizedError {
    case missingBundle
    case missingFunction(String)
    case exception(String)
    case badResult(String)

    var errorDescription: String? {
        switch self {
        case .missingBundle: return "host.js is missing from the app bundle"
        case .missingFunction(let f): return "QuireHost.\(f) is not defined"
        case .exception(let m): return m
        case .badResult(let f): return "QuireHost.\(f) returned an unexpected value"
        }
    }
}

/// The Mac's pure render/save JavaScript (core/html.mjs + app/main/transform.mjs, bundled from
/// mobile/host.mjs as host.js) in one JSContext. A JSContext isn't thread-safe, so every call
/// runs on one serial queue; the wrappers are synchronous and callable from any thread except
/// that queue itself.
final class HostJS: @unchecked Sendable {
    static let shared: HostJS = {
        do { return try HostJS() } catch { fatalError("HostJS: \(error.localizedDescription)") }
    }()

    private let queue = DispatchQueue(label: "org.harborapps.quire.hostjs")
    private let context: JSContext
    private var lastException: String?

    init(source: String? = nil) throws {
        let js: String
        if let source {
            js = source
        } else {
            guard let url = Bundle.main.url(forResource: "host", withExtension: "js") else { throw HostJSError.missingBundle }
            js = try String(contentsOf: url, encoding: .utf8)
        }
        guard let ctx = JSContext() else { throw HostJSError.exception("Could not create a JSContext") }
        context = ctx
        ctx.name = "Quire host"
        ctx.exceptionHandler = { [weak self] _, value in
            let message = value?.objectForKeyedSubscript("message")?.toString() ?? value?.toString() ?? "JavaScript error"
            let stack = value?.objectForKeyedSubscript("stack")?.toString()
            self?.lastException = [message, stack].compactMap { $0 }.joined(separator: "\n")
        }
        ctx.evaluateScript(js, withSourceURL: URL(string: "quire://host/host.js"))
        if let e = lastException { throw HostJSError.exception("host.js failed to load: \(e)") }
        if ctx.objectForKeyedSubscript("QuireHost")?.isUndefined ?? true { throw HostJSError.missingFunction("(QuireHost)") }
    }

    /// Call QuireHost[name](...args) and convert the result with `convert` on the JS queue.
    func call<T>(_ name: String, _ args: [Any], convert: (JSValue) -> T?) throws -> T {
        try queue.sync {
            lastException = nil
            guard let fn = context.objectForKeyedSubscript("QuireHost")?.objectForKeyedSubscript(name), !fn.isUndefined else {
                throw HostJSError.missingFunction(name)
            }
            let result = fn.call(withArguments: args)
            if let e = lastException { throw HostJSError.exception(e) }
            guard let result, let value = convert(result) else { throw HostJSError.badResult(name) }
            return value
        }
    }

    private func string(_ name: String, _ args: [Any]) throws -> String {
        try call(name, args) { $0.isString ? $0.toString() : nil }
    }

    private static func orNull(_ v: Any?) -> Any { v ?? NSNull() }

    // MARK: - core/html.mjs

    /// Adds data-q-i="0..n-1" to every top-level element child of <body>.
    func indexBody(_ html: String) throws -> String { try string("indexBody", [html]) }

    /// Apply the editor's WYSIWYG regions ([{replace: [Int], before: Int|null, html: String}])
    /// to the RAW file. Throws on an index that isn't a body child.
    func applyRegions(_ html: String, regions: [[String: Any]]) throws -> String {
        try string("applyRegions", [html, regions])
    }

    /// Markdown → full HTML document (body data-q-format="md"); frontmatter isn't shown.
    func renderMarkdown(_ md: String, title: String? = nil) throws -> String {
        try string("renderMarkdown", [md, title.map { ["title": $0] } ?? [String: Any]()])
    }

    /// Body innerHTML → markdown (what a markdown page's save writes, after the frontmatter).
    func htmlToMarkdown(_ bodyHtml: String) throws -> String { try string("htmlToMarkdown", [bodyHtml]) }

    /// The leading YAML block ("" or the whole `---…---\n`) and the rest.
    func splitFrontmatter(_ md: String) throws -> (frontmatter: String, body: String) {
        try call("splitFrontmatter", [md]) { v in
            guard let fm = v.objectForKeyedSubscript("frontmatter")?.toString(),
                  let body = v.objectForKeyedSubscript("body")?.toString() else { return nil }
            return (fm, body)
        }
    }

    /// Remove data-q-* and contenteditable attributes from every start tag.
    func stripEditorAttrs(_ fragment: String) throws -> String { try string("stripEditorAttrs", [fragment]) }

    // MARK: - app/main/transform.mjs

    /// MIME type by extension ("text/javascript; charset=utf-8" for .mjs, …).
    func contentType(_ file: String) -> String {
        (try? string("contentType", [file])) ?? "application/octet-stream"
    }

    /// The block injected after <head>: quire-page meta, import map, theme.css, editor prefs
    /// (when `editor` is non-nil; [:] means the defaults), runtime.js.
    func headInjection(pagePath: String, editor: [String: Any]? = [:]) throws -> String {
        try string("headInjection", [pagePath, Self.orNull(editor)])
    }

    func injectHead(_ html: String, pagePath: String, baseHref: String? = nil, editor: [String: Any]? = [:]) throws -> String {
        try string("injectHead", [html, pagePath, Self.orNull(baseHref), Self.orNull(editor)])
    }

    /// Entry source → the served document (markdown rendered first, then indexBody + head).
    /// format: "html" | "md".
    func transformEntry(_ source: String, format: String, pagePath: String, title: String, baseHref: String? = nil, editor: [String: Any]? = [:]) throws -> String {
        var opts: [String: Any] = ["pagePath": pagePath, "title": title, "baseHref": Self.orNull(baseHref)]
        opts["editor"] = Self.orNull(editor)
        return try string("transformEntry", [source, format, opts])
    }
}
