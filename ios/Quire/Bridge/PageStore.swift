import Foundation
import SQLite3

/// A page's own data, the phone side of core/store.mjs: one SQLite file per page per user,
/// `<page dir>/data/<user>.sqlite`, with the SAME schema, row shape and ids, so a file copied
/// between the Mac and the phone opens on either:
///
///     rows (tbl TEXT, id TEXT, data TEXT JSON, created INTEGER ms, updated INTEGER ms,
///           PRIMARY KEY (tbl, id))
///     kv   (key TEXT PRIMARY KEY, value TEXT JSON)
///
/// A row as pages see it (core's toRow): the stored JSON object, plus `id`, `_created` and
/// `_updated` (numbers, ms since 1970). Handles are cached per file for the app's life, WAL
/// mode, like the Mac. Thread-safe (one lock per file).
final class PageStore: @unchecked Sendable {
    enum StoreError: LocalizedError {
        case sqlite(String)
        case message(String)
        var errorDescription: String? {
            switch self {
            case .sqlite(let m): return "SQLite: \(m)"
            case .message(let m): return m
            }
        }
    }

    /// The device's store user: the file is `data/<user>.sqlite`.
    ///
    /// The Mac uses core's currentUser(): the login name, lowercased, [a-z0-9_-] only, else
    /// "user". An iPhone has no login name, and since iOS 16 `UIDevice.name` is just the model
    /// ("iPhone") without a special entitlement, so the phone's user is that name's slug:
    /// "iphone" (or "ipad"). It never changes when the device is renamed, and it can't collide
    /// with the Mac's file, so each device keeps its own rows (docs/decisions/mobile.md: page
    /// data isn't synced yet). Override with the `quire.user` default (tests, a second device).
    static let currentUser: String = {
        if let custom = UserDefaults.standard.string(forKey: "quire.user"), !slug(custom).isEmpty { return slug(custom) }
        // The model, not the (renameable) device name: "iPhone15,2" → "iphone".
        let model = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? machine()
        return model.lowercased().hasPrefix("ipad") ? "ipad" : "iphone"
    }()

    private static func machine() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    /// core's currentUser() sanitising: lowercase, keep [a-z0-9_-].
    static func slug(_ s: String) -> String {
        String(s.lowercased().unicodeScalars.filter { c in
            (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "_" || c == "-"
        }.map(Character.init))
    }

    // MARK: - ids (core's newId)

    private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")

    /// `len` chars of [a-z0-9], unbiased (bytes ≥ 252 are skipped), like core's newId.
    static func newId(_ len: Int = 10) -> String {
        var out = ""
        while out.count < len {
            var bytes = [UInt8](repeating: 0, count: len * 2)
            if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
                for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
            }
            for b in bytes where b < 252 {
                out.append(alphabet[Int(b) % 36])
                if out.count == len { break }
            }
        }
        return out
    }

    // MARK: - Open

    private static var cache: [String: PageStore] = [:]
    private static let cacheLock = NSLock()

    /// The store for `pageDir` and `user`, creating `data/` and the file on first use.
    static func open(pageDir: URL, user: String = currentUser) throws -> PageStore {
        let file = pageDir.standardizedFileURL.appendingPathComponent("data", isDirectory: true).appendingPathComponent("\(user).sqlite")
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if let hit = cache[file.path] { return hit }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let store = try PageStore(file: file)
        cache[file.path] = store
        return store
    }

    /// Close every cached handle (before sync replaces files, tests).
    static func closeAll() {
        cacheLock.lock()
        let all = Array(cache.values)
        cache.removeAll()
        cacheLock.unlock()
        all.forEach { $0.close() }
    }

    let file: URL
    private var db: OpaquePointer?
    private let lock = NSLock()

    private init(file: URL) throws {
        self.file = file
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(file.path, &handle, flags, nil) == SQLITE_OK, let handle else {
            let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "could not open \(file.lastPathComponent)"
            sqlite3_close(handle)
            throw StoreError.sqlite(msg)
        }
        db = handle
        try exec("PRAGMA journal_mode=WAL")
        try exec("PRAGMA busy_timeout=2000")
        try exec("""
            CREATE TABLE IF NOT EXISTS rows (
                  tbl TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
                  created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (tbl, id))
            """)
        try exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")
    }

    deinit { close() }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        if let db { sqlite3_close_v2(db) }
        db = nil
    }

    // MARK: - Rows

    func all(_ table: String) throws -> [[String: Any]] {
        try Self.checkTable(table)
        return try locked {
            try query("SELECT tbl, id, data, created, updated FROM rows WHERE tbl = ? ORDER BY created, rowid", [table]).map(Self.toRow)
        }
    }

    /// The row, or nil.
    func get(_ table: String, _ id: String) throws -> [String: Any]? {
        try Self.checkTable(table)
        return try locked { try getRow(table, id) }
    }

    /// Insert `obj` (meta keys dropped); `obj.id` is kept when given, else a new id.
    func insert(_ table: String, _ obj: [String: Any]) throws -> [String: Any] {
        try Self.checkTable(table)
        let given = obj["id"].flatMap { $0 is NSNull ? nil : JSONValue.jsString($0) } ?? ""
        let id = given.isEmpty ? Self.newId() : given
        let now = Self.nowMs()
        return try locked {
            try run("INSERT INTO rows (tbl, id, data, created, updated) VALUES (?, ?, ?, ?, ?)",
                    [table, id, try JSONValue.stringify(Self.strip(obj)), now, now])
            guard let row = try getRow(table, id) else { throw StoreError.message("No row \(id) in \(table)") }
            return row
        }
    }

    /// Merge `patch` (meta keys dropped) into the row's data. Throws "No row <id> in <table>".
    func update(_ table: String, _ id: String, _ patch: [String: Any]) throws -> [String: Any] {
        try Self.checkTable(table)
        return try locked {
            guard let cur = try query("SELECT data FROM rows WHERE tbl = ? AND id = ?", [table, id]).first,
                  let raw = cur["data"] as? String else {
                throw StoreError.message("No row \(id) in \(table)")
            }
            var data = (try? JSONValue.parse(raw)) as? [String: Any] ?? [:]
            for (k, v) in Self.strip(patch) { data[k] = v }
            try run("UPDATE rows SET data = ?, updated = ? WHERE tbl = ? AND id = ?",
                    [try JSONValue.stringify(data), Self.nowMs(), table, id])
            guard let row = try getRow(table, id) else { throw StoreError.message("No row \(id) in \(table)") }
            return row
        }
    }

    func remove(_ table: String, _ id: String) throws -> Bool {
        try Self.checkTable(table)
        try locked { try run("DELETE FROM rows WHERE tbl = ? AND id = ?", [table, id]) }
        return true
    }

    // MARK: - kv

    /// The parsed value, or nil (JS null) when unset.
    func kvGet(_ key: String) throws -> Any? {
        try locked {
            guard let raw = try query("SELECT value FROM kv WHERE key = ?", [key]).first?["value"] as? String else { return nil }
            let v = try JSONValue.parse(raw)
            return v is NSNull ? nil : v
        }
    }

    func kvSet(_ key: String, _ value: Any?) throws -> Bool {
        let json = try JSONValue.stringify(value ?? NSNull())
        try locked {
            try run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, json])
        }
        return true
    }

    func tables() throws -> [String] {
        try locked { try query("SELECT DISTINCT tbl FROM rows ORDER BY tbl", []).compactMap { $0["tbl"] as? String } }
    }

    // MARK: - Shape (core's strip / toRow / checkTable)

    private static let meta: Set<String> = ["id", "_created", "_updated"]

    static func strip(_ obj: [String: Any]) -> [String: Any] {
        obj.filter { !meta.contains($0.key) }
    }

    static func toRow(_ r: [String: Any]) -> [String: Any] {
        var row = ((try? JSONValue.parse(r["data"] as? String ?? "{}")) as? [String: Any]) ?? [:]
        row["id"] = r["id"] as? String ?? ""
        row["_created"] = NSNumber(value: (r["created"] as? Int64) ?? 0)
        row["_updated"] = NSNumber(value: (r["updated"] as? Int64) ?? 0)
        return row
    }

    static func checkTable(_ table: String) throws {
        if table.isEmpty { throw StoreError.message("table must be a non-empty string") }
    }

    private static func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)) }

    // MARK: - SQLite

    private func locked<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        guard db != nil else { throw StoreError.message("Store is closed: \(file.lastPathComponent)") }
        return try body()
    }

    private func getRow(_ table: String, _ id: String) throws -> [String: Any]? {
        try query("SELECT tbl, id, data, created, updated FROM rows WHERE tbl = ? AND id = ?", [table, id]).first.map(Self.toRow)
    }

    private var errmsg: String { db.map { String(cString: sqlite3_errmsg($0)) } ?? "closed" }

    private func exec(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw StoreError.sqlite(errmsg) }
    }

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private func prepare(_ sql: String, _ args: [Any]) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw StoreError.sqlite(errmsg) }
        for (i, arg) in args.enumerated() {
            let idx = Int32(i + 1)
            let rc: Int32
            switch arg {
            case let s as String: rc = sqlite3_bind_text(stmt, idx, s, -1, Self.transient)
            case let n as Int64: rc = sqlite3_bind_int64(stmt, idx, n)
            case let n as Int: rc = sqlite3_bind_int64(stmt, idx, Int64(n))
            default: rc = sqlite3_bind_null(stmt, idx)
            }
            if rc != SQLITE_OK {
                sqlite3_finalize(stmt)
                throw StoreError.sqlite(errmsg)
            }
        }
        return stmt
    }

    private func run(_ sql: String, _ args: [Any]) throws {
        let stmt = try prepare(sql, args)
        defer { sqlite3_finalize(stmt) }
        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_DONE || rc == SQLITE_ROW else { throw StoreError.sqlite(errmsg) }
    }

    private func query(_ sql: String, _ args: [Any]) throws -> [[String: Any]] {
        let stmt = try prepare(sql, args)
        defer { sqlite3_finalize(stmt) }
        var out: [[String: Any]] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw StoreError.sqlite(errmsg) }
            var row: [String: Any] = [:]
            for c in 0..<sqlite3_column_count(stmt) {
                let name = String(cString: sqlite3_column_name(stmt, c))
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER: row[name] = sqlite3_column_int64(stmt, c)
                case SQLITE_FLOAT: row[name] = sqlite3_column_double(stmt, c)
                case SQLITE_NULL: row[name] = NSNull()
                default:
                    if let text = sqlite3_column_text(stmt, c) { row[name] = String(cString: text) }
                    else { row[name] = NSNull() }
                }
            }
            out.append(row)
        }
        return out
    }
}

/// JSON the way the page's JavaScript writes and reads it (JSON.stringify / JSON.parse):
/// fragments allowed, no escaped slashes, dates as ISO strings. Values from a WKScriptMessage
/// are NSString, NSNumber, NSDate, NSArray, NSDictionary or NSNull.
enum JSONValue {
    static func parse(_ s: String) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(s.utf8), options: [.fragmentsAllowed])
    }

    static func stringify(_ value: Any) throws -> String {
        let clean = sanitize(value)
        let data = try JSONSerialization.data(withJSONObject: clean, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Make a value JSONSerialization accepts, like JSON.stringify would see it.
    static func sanitize(_ value: Any) -> Any {
        switch value {
        case let d as Date: return iso.string(from: d)
        case let a as [Any]: return a.map(sanitize)
        case let o as [String: Any]: return o.mapValues(sanitize)
        case let n as NSNumber:
            // NaN / Infinity serialise as null in JS.
            if CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isNaN || n.doubleValue.isInfinite { return NSNull() }
            return n
        case is String, is NSNull: return value
        default: return NSNull()
        }
    }

    /// String(v) for an id: strings as they are, integral numbers without ".0".
    static func jsString(_ v: Any) -> String {
        switch v {
        case let s as String: return s
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
            let d = n.doubleValue
            if d.rounded() == d, abs(d) < 1e15 { return String(Int64(d)) }
            return "\(d)"
        default: return "\(v)"
        }
    }
}
