import Foundation
import JavaScriptCore
import WebKit

/// One rpc from a page's runtime (app/runtime/runtime.js, the `nativeHost` transport):
/// `window.webkit.messageHandlers.quire.postMessage({id, method, params, page})`.
/// `params` always carries `from` (the calling page's own path) and `page` (the target page
/// for query/navigate, else the caller). See docs/contract.md, "Messages: page ⇄ renderer".
struct RpcRequest {
    let id: String
    let method: String
    let params: [String: Any]
    /// The calling page's path (the frame's `<meta name="quire-page">`).
    let page: String
    /// The frame that sent it: the top page or an embed iframe. The reply goes back to it.
    let frame: WKFrameInfo?

    init?(body: Any, frame: WKFrameInfo?) {
        guard let obj = body as? [String: Any], let id = obj["id"] as? String, let method = obj["method"] as? String else { return nil }
        self.id = id
        self.method = method
        self.params = obj["params"] as? [String: Any] ?? [:]
        self.page = obj["page"] as? String ?? ""
        self.frame = frame
    }

    /// The page store/kv/save calls act on: `params.from` unless empty, else the frame's page
    /// (runRpc's `from`).
    var from: String {
        if let f = params["from"] as? String, !f.isEmpty { return f }
        return page
    }
}

enum RpcError: LocalizedError {
    case notImplemented(String)
    case message(String)

    var errorDescription: String? {
        switch self {
        case .notImplemented(let m): return "not implemented: \(m)"
        case .message(let m): return m
        }
    }
}

/// The return value is sent to the page as the rpc result, so it must be JSON-like:
/// String, NSNumber/Int/Double/Bool, [Any], [String: Any] or NSNull.
@MainActor
protocol RpcHandling: AnyObject {
    func handle(_ request: RpcRequest) async throws -> Any
    /// Called after a store/kv write with (page path, table or nil for kv). The page
    /// controller forwards it to the page as `store-changed`, like the desktop renderer.
    var onStoreChanged: ((String, String?) -> Void)? { get set }
}

/// Answers page rpcs exactly like runRpc in app/main/ipc.mjs: store.* / kv.* on the page's
/// SQLite (PageStore), query, pages, navigate, save and embed.setHeight. Writes are refused
/// on a page an agent has locked, and every file written is put in VaultChanges for sync.
/// Differences from the Mac, by design: no autosave commit (sync commits what VaultChanges
/// lists) and no rebuild after saving a built page (builds are Mac only; the built entry is
/// patched in place, as the Mac does before its rebuild lands).
@MainActor
final class RpcBridge: RpcHandling {
    /// app/main/ipc.mjs READ_ONLY_MSG, word for word.
    static let readOnlyMessage = "Page is read-only while it is being edited"

    /// The methods after which the desktop renderer posts `store-changed` (App.jsx WRITE_METHODS).
    static let storeWrites: Set<String> = ["store.insert", "store.update", "store.remove", "kv.set"]

    let vault: VaultStore
    let user: String
    /// Set by the page screen: open another page (the `navigate` rpc), with a page path.
    var onNavigate: ((String) -> Void)?
    /// Set by PageController: a store/kv write happened on (page, table).
    var onStoreChanged: ((String, String?) -> Void)?

    init(vault: VaultStore, user: String = PageStore.currentUser) {
        self.vault = vault
        self.user = user
    }

    func handle(_ request: RpcRequest) async throws -> Any {
        let p = request.params
        let from = request.from
        func page() throws -> VaultNode { try findPage(from) }

        switch request.method {
        case "store.all":
            return try store(page()).all(try table(p))
        case "store.get":
            return try store(page()).get(try table(p), try id(p)) ?? NSNull()
        case "store.insert", "store.update", "store.remove":
            let node = try page()
            try assertWritable(node)
            let s = try store(node)
            let t = try table(p)
            let result: Any
            switch request.method {
            case "store.insert": result = try s.insert(t, p["obj"] as? [String: Any] ?? [:])
            case "store.update": result = try s.update(t, try id(p), p["patch"] as? [String: Any] ?? [:])
            default: result = try s.remove(t, try id(p))
            }
            dataChanged(node, table: t)
            return result
        case "kv.get":
            return try store(page()).kvGet(try key(p)) ?? NSNull()
        case "kv.set":
            let node = try page()
            try assertWritable(node)
            let value = p["value"].flatMap { $0 is NSNull ? nil : $0 }
            let result = try store(node).kvSet(try key(p), value)
            dataChanged(node, table: nil)
            return result
        case "query":
            let target = try findPage(p["page"] as? String ?? "")
            return try store(target).all(try table(p))
        case "pages":
            return publicTree(vault.listTree())
        case "navigate":
            if let target = resolveNavigation(p["page"] as? String ?? "") { onNavigate?(target) }
            return NSNull()
        case "save":
            return try save(page(), p)
        case "embed.setHeight":
            return try setEmbedHeight(findPage(p["page"] as? String ?? ""), p["height"])
        default:
            throw RpcError.message("Unknown method: \(request.method)")
        }
    }

    // MARK: - Params

    private func table(_ p: [String: Any]) throws -> String {
        guard let t = p["table"] as? String, !t.isEmpty else { throw RpcError.message("table must be a non-empty string") }
        return t
    }

    private func id(_ p: [String: Any]) throws -> String {
        guard let raw = p["id"], !(raw is NSNull) else { throw RpcError.message("id is required") }
        let s = JSONValue.jsString(raw)
        if s.isEmpty { throw RpcError.message("id is required") }
        return s
    }

    private func key(_ p: [String: Any]) throws -> String {
        guard let raw = p["key"], !(raw is NSNull) else { throw RpcError.message("key is required") }
        return JSONValue.jsString(raw)
    }

    // MARK: - Pages

    private func findPage(_ ref: String) throws -> VaultNode {
        do { return try vault.findPage(ref) } catch { throw RpcError.message("No page: \(ref)") }
    }

    private func store(_ node: VaultNode) throws -> PageStore {
        try PageStore.open(pageDir: node.dir, user: user)
    }

    /// core's lockOf: the node's lock, else the lock file for its id (read fresh).
    private func assertWritable(_ node: VaultNode) throws {
        if node.lock != nil || vault.lock(id: node.pageId) != nil { throw RpcError.message(Self.readOnlyMessage) }
    }

    private func dataChanged(_ node: VaultNode, table: String?) {
        VaultChanges.shared.markChanged(path: "\(node.path)/data/\(user).sqlite")
        onStoreChanged?(node.path, table)
    }

    private func written(_ node: VaultNode, _ file: String) {
        VaultChanges.shared.markChanged(path: "\(node.path)/\(file)")
    }

    /// The desktop renderer's navigate: a page (or plain file) path opens as itself, a path
    /// inside a page opens that page (the phone has no file view), a page id opens its page.
    private func resolveNavigation(_ target: String) -> String? {
        let p = (try? VaultStore.normPath(target)) ?? target
        guard !p.isEmpty else { return nil }
        let nodes = vault.listTree().walked()
        if nodes.contains(where: { $0.path == p }) { return p }
        if let host = nodes.filter({ $0.isPage && p.hasPrefix($0.path + "/") }).max(by: { $0.path.count < $1.path.count }) {
            return host.path
        }
        if let byId = try? vault.findPage(target) { return byId.path }
        return p
    }

    /// ipc.mjs publicTree(listTree(vault)): every node without `dir`, in core's field set.
    func publicTree(_ nodes: [VaultNode]) -> [[String: Any]] {
        nodes.map { n in
            var o: [String: Any] = [
                "kind": n.kind.rawValue,
                "id": n.pageId ?? NSNull(),
                "title": n.title,
                "path": n.path,
                "children": publicTree(n.children),
                "lock": NSNull(),
            ]
            guard n.isPage else { return o }
            o["entry"] = n.entry
            o["source"] = n.source ?? NSNull()
            o["build"] = n.build ?? NSNull()
            o["renderer"] = n.renderer
            o["embedHeight"] = n.embedHeight ?? NSNull()
            if let b = n.backend {
                o["backend"] = ["dir": b.dir, "run": b.run, "proxy": b.proxy ?? NSNull()] as [String: Any]
            } else {
                o["backend"] = NSNull()
            }
            o["format"] = n.format.rawValue
            o["lock"] = rawLock(n.pageId) ?? NSNull()
            return o
        }
    }

    /// The lock file as JSON (core returns it as is), or nil.
    private func rawLock(_ id: String?) -> [String: Any]? {
        guard let id, !id.isEmpty else { return nil }
        let url = VaultNames.metaURL(vault.root, "locks/\(id).json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    // MARK: - save (ipc.mjs save)

    private func save(_ node: VaultNode, _ p: [String: Any]) throws -> Any {
        try assertWritable(node)
        let markdownBody = p["markdownBody"].flatMap { $0 is NSNull ? nil : $0 }
        if node.format == .md || markdownBody != nil {
            guard let body = markdownBody as? String else {
                throw RpcError.message("save: markdownBody is required for a markdown page")
            }
            let file = node.dir.appendingPathComponent(node.entry)
            // The editor never sees frontmatter (it isn't rendered), so carry it over.
            var front = ""
            if let current = try? String(contentsOf: file, encoding: .utf8) {
                front = (try? HostJS.shared.splitFrontmatter(current).frontmatter) ?? ""
            }
            let md = front + (try HostJS.shared.htmlToMarkdown(body))
            try AtomicFile.write(md, to: file)
            written(node, node.entry)
            return ["ok": true]
        }

        let regions = (p["regions"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
        // A built page's prose lives in its source template; its entry is build output.
        let target = editFile(node)
        let file = node.dir.appendingPathComponent(target)
        // Always the RAW live file, never the snapshot and never the served (indexed) copy.
        let raw = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        let next = try HostJS.shared.applyRegions(raw, regions: regions)
        if next != raw {
            try AtomicFile.write(next, to: file)
            written(node, target)
            if target != node.entry {
                // Patch the built copy too: the build keeps body markup in place, so the same
                // element numbers line up. (The rebuild itself happens on the Mac.)
                let out = node.dir.appendingPathComponent(node.entry)
                if let built = try? String(contentsOf: out, encoding: .utf8),
                   let patched = try? HostJS.shared.applyRegions(built, regions: regions) {
                    if (try? AtomicFile.write(patched, to: out)) != nil { written(node, node.entry) }
                }
            }
        }
        return ["ok": true]
    }

    /// core's editFile: the `source` template for a built page when it exists, else the entry.
    private func editFile(_ node: VaultNode) -> String {
        if let source = node.source, FileManager.default.fileExists(atPath: node.dir.appendingPathComponent(source).path) {
            return source
        }
        return node.entry
    }

    // MARK: - embed.setHeight (ipc.mjs setEmbedHeight)

    private func setEmbedHeight(_ node: VaultNode, _ height: Any?) throws -> Any {
        try assertWritable(node)
        let n = (height as? NSNumber)?.doubleValue ?? Double(height as? String ?? "") ?? 0
        let h = n.isFinite ? Int((n).rounded(.toNearestOrAwayFromZero)) : 0
        // Read whichever manifest the page has; always write the new name, and drop a legacy
        // `.quire` once its content lives in `.noteblock` (sync sees the deletion on disk).
        let existing = vault.manifestURL(node.dir)
        let url = node.dir.appendingPathComponent(VaultStore.manifestName)
        let current = existing.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        let next = try ManifestJSON.shared.setEmbedHeight(current, h)
        let legacy = existing.map { $0.lastPathComponent != VaultStore.manifestName } ?? false
        if next != current || legacy {
            try AtomicFile.write(next, to: url)
            written(node, VaultStore.manifestName)
            if let existing, legacy {
                try? FileManager.default.removeItem(at: existing)
                written(node, existing.lastPathComponent)
            }
        }
        return ["height": h > 0 ? h : NSNull()] as [String: Any]
    }
}

/// Edits a page manifest (`.noteblock`) with JavaScript's own JSON, so the file comes out byte for byte
/// as core's writeManifest writes it (`JSON.stringify(obj, null, 2) + "\n"`, key order kept).
/// Foundation's pretty printer writes `"key" : value` and reorders keys, which would churn
/// every manifest the phone touches in git.
@MainActor
final class ManifestJSON {
    static let shared = ManifestJSON()

    private let context: JSContext = {
        let ctx = JSContext()!
        ctx.evaluateScript("""
        function setEmbedHeight(text, h) {
          var m = null;
          try { m = JSON.parse(text); } catch (e) {}
          if (!m || typeof m !== "object" || Array.isArray(m)) m = {};
          if (h > 0) m.embed = Object.assign({}, m.embed || {}, { height: h });
          else if (m.embed) {
            delete m.embed.height;
            if (!Object.keys(m.embed).length) delete m.embed;
          }
          return JSON.stringify(m, null, 2) + "\\n";
        }
        """)
        return ctx
    }()

    func setEmbedHeight(_ text: String, _ height: Int) throws -> String {
        guard let fn = context.objectForKeyedSubscript("setEmbedHeight"),
              let out = fn.call(withArguments: [text, height]), out.isString, let s = out.toString() else {
            throw RpcError.message("Could not update the page's manifest")
        }
        return s
    }
}
