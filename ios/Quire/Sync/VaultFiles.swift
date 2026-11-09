import CryptoKit
import Darwin
import Foundation

enum GitBlob {
    /// git's blob id: sha1("blob <len>\0" + content).
    static func sha(_ data: Data) -> String {
        var h = Insecure.SHA1()
        h.update(data: Data("blob \(data.count)\0".utf8))
        h.update(data: data)
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func sha(fileAt url: URL) throws -> String {
        try sha(Data(contentsOf: url, options: .mappedIfSafe))
    }
}

/// The vault's .gitignore, plus what sync never carries no matter what it says.
struct IgnoreRules {
    private struct Rule {
        var pattern: String
        var negate: Bool
        var dirOnly: Bool
        var anchored: Bool
    }

    /// Always skipped: git's own folder, page data, locks/snapshots, Finder and trash litter.
    private static let builtin: [Rule] = parse(".git/\ndata/\nnode_modules/\n" + VaultNames.ignoreLines.joined(separator: "\n") + "\n.DS_Store\n.trash/\n.Trash/\n")

    private let rules: [Rule]

    init(text: String) {
        rules = Self.parse(text)
    }

    init(root: URL) {
        let text = (try? String(contentsOf: root.appendingPathComponent(".gitignore"), encoding: .utf8)) ?? VaultStore.gitignore
        self.init(text: text)
    }

    private static func parse(_ text: String) -> [Rule] {
        text.split(whereSeparator: \.isNewline).compactMap { raw in
            var line = String(raw)
            while line.hasSuffix(" ") && !line.hasSuffix("\\ ") { line.removeLast() }
            if line.isEmpty || line.hasPrefix("#") { return nil }
            var negate = false
            if line.hasPrefix("!") { negate = true; line.removeFirst() }
            if line.hasPrefix("\\") { line.removeFirst() }
            var dirOnly = false
            if line.hasSuffix("/") { dirOnly = true; line.removeLast() }
            var anchored = line.contains("/")
            if line.hasPrefix("/") { line.removeFirst(); anchored = true }
            if line.hasPrefix("**/") { line.removeFirst(3); anchored = line.contains("/") }
            if line.isEmpty { return nil }
            return Rule(pattern: line, negate: negate, dirOnly: dirOnly, anchored: anchored)
        }
    }

    private static func matches(_ rule: Rule, _ path: String, isDir: Bool) -> Bool {
        if rule.dirOnly && !isDir { return false }
        if rule.anchored {
            let flags = rule.pattern.contains("**") ? Int32(0) : FNM_PATHNAME
            return fnmatch(rule.pattern, path, flags) == 0
        }
        let base = path.split(separator: "/").last.map(String.init) ?? path
        return fnmatch(rule.pattern, base, 0) == 0
    }

    private func matchOne(_ path: String, isDir: Bool) -> Bool {
        if Self.builtin.contains(where: { Self.matches($0, path, isDir: isDir) }) { return true }
        var ignored = false
        for r in rules where Self.matches(r, path, isDir: isDir) { ignored = !r.negate }
        return ignored
    }

    /// True when `path` (vault-relative) or any folder above it is ignored.
    func isIgnored(_ path: String, isDir: Bool = false) -> Bool {
        let comps = path.split(separator: "/").map(String.init)
        for i in comps.indices {
            let sub = comps[0...i].joined(separator: "/")
            let last = i == comps.count - 1
            if matchOne(sub, isDir: last ? isDir : true) { return true }
        }
        return false
    }
}

struct FileStat: Equatable {
    var size: Int
    var mtime: Double
    var exec: Bool
}

enum VaultFiles {
    /// A remote path we're willing to write: no "..", no ".git", nothing absolute.
    static func safeRelative(_ p: String) -> String? {
        let comps = p.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !comps.isEmpty, !p.hasPrefix("/") else { return nil }
        for c in comps where c.isEmpty || c == "." || c == ".." { return nil }
        if comps[0] == ".git" { return nil }
        return comps.joined(separator: "/")
    }

    static func url(_ root: URL, _ rel: String) -> URL {
        rel.split(separator: "/").reduce(root) { $0.appendingPathComponent(String($1)) }
    }

    static func stat(_ url: URL) -> FileStat? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path),
              (a[.type] as? FileAttributeType) == .typeRegular else { return nil }
        let size = (a[.size] as? NSNumber)?.intValue ?? 0
        let mtime = (a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let perms = (a[.posixPermissions] as? NSNumber)?.intValue ?? 0o644
        return FileStat(size: size, mtime: mtime, exec: perms & 0o100 != 0)
    }

    /// Every regular, non-ignored file under `root`, vault-relative.
    static func scan(_ root: URL, rules: IgnoreRules) -> [String: FileStat] {
        var out: [String: FileStat] = [:]
        let fm = FileManager.default
        func walk(_ dir: URL, _ rel: String) {
            guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
            for name in names {
                let p = rel.isEmpty ? name : "\(rel)/\(name)"
                let u = dir.appendingPathComponent(name)
                var isDir: ObjCBool = false
                guard fm.fileExists(atPath: u.path, isDirectory: &isDir) else { continue }
                if rules.isIgnored(p, isDir: isDir.boolValue) { continue }
                if isDir.boolValue {
                    // Don't follow symlinked folders.
                    if (try? u.resourceValues(forKeys: [.isSymbolicLinkKey]))?.isSymbolicLink == true { continue }
                    walk(u, p)
                } else if let s = stat(u) {
                    out[p] = s
                }
            }
        }
        walk(root, "")
        return out
    }

    /// "a/index.html" → "a/index (conflict 2026-10-21 1403).html", never an existing file.
    /// Same naming as app/main/sync.mjs conflictName.
    static func conflictName(_ root: URL, _ rel: String, when: Date = Date()) -> String {
        let comps = rel.split(separator: "/").map(String.init)
        let dir = comps.dropLast().joined(separator: "/")
        let base = comps.last ?? rel
        let dot = base.lastIndex(of: ".").map { base.distance(from: base.startIndex, to: $0) } ?? -1
        let (name, ext) = dot > 0
            ? (String(base.prefix(dot)), String(base.dropFirst(dot)))
            : (base, "")
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: when)
        let stamp = String(format: "%04d-%02d-%02d %02d%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0)
        for i in 1... {
            let tag = "conflict \(stamp)\(i > 1 ? " \(i)" : "")"
            let out = (dir.isEmpty ? "" : dir + "/") + "\(name) (\(tag))\(ext)"
            if !FileManager.default.fileExists(atPath: url(root, out).path) { return out }
        }
        return rel
    }

    /// Remove empty folders from `rel`'s parent up to (not including) the root.
    static func pruneEmptyParents(_ root: URL, _ rel: String) {
        var comps = rel.split(separator: "/").map(String.init)
        comps.removeLast()
        let fm = FileManager.default
        while !comps.isEmpty {
            let u = url(root, comps.joined(separator: "/"))
            guard let items = try? fm.contentsOfDirectory(atPath: u.path) else { return }
            if !items.allSatisfy({ $0 == ".DS_Store" }) { return }
            try? fm.removeItem(at: u)
            comps.removeLast()
        }
    }
}
