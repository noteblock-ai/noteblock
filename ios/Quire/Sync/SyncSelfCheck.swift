#if DEBUG
import Foundation

/// Pure checks for the sync building blocks. Nothing calls this; run it from a debugger
/// (`po SyncSelfCheck.run()`) or a scratch call site. Returns the failures (empty = all good).
enum SyncSelfCheck {
    static func run() -> [String] {
        var fails: [String] = []
        func expect(_ ok: Bool, _ what: String) { if !ok { fails.append(what) } }

        // git hash-object of "hello\n"
        expect(GitBlob.sha(Data("hello\n".utf8)) == "ce013625030ba8dba906f756967f9e9ca394464a", "blob sha hello")
        expect(GitBlob.sha(Data()) == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", "blob sha empty")

        // A tar with a global pax comment, a pax long path, and a plain ustar file.
        let longPath = "owner-repo-abc/" + String(repeating: "deep/", count: 25) + "note.md"
        var tar = Data()
        tar += paxBlock("g", ["comment": String(repeating: "a", count: 40)])
        tar += paxBlock("x", ["path": longPath])
        tar += fileBlock("ignored-short-name", Data("long".utf8))
        tar += fileBlock("owner-repo-abc/a/index.html", Data("<p>hi</p>".utf8))
        tar += Data(count: 1024)
        let r = TarReader(data: tar)
        var got: [String: String] = [:]
        while let e = try? r.next() {
            if e.isFile, let body = try? r.readBody() { got[e.path] = String(decoding: body, as: UTF8.self) }
        }
        expect(got[longPath] == "long", "tar pax path")
        expect(got["owner-repo-abc/a/index.html"] == "<p>hi</p>", "tar ustar file")
        expect(r.globalComment == String(repeating: "a", count: 40), "tar global comment")

        // .gitignore rules
        let rules = IgnoreRules(text: VaultStore.gitignore + "*.log\n/build/\n")
        expect(rules.isIgnored("Habits/data/me.sqlite"), "ignore data/")
        expect(rules.isIgnored(".quire/locks/x.json"), "ignore locks")
        expect(!rules.isIgnored(".quire/vault.json"), "keep vault.json")
        expect(rules.isIgnored(".noteblock/locks/x.json"), "ignore locks (new name)")
        expect(rules.isIgnored(".noteblock/snapshots/abc/index.html"), "ignore snapshots (new name)")
        expect(!rules.isIgnored(".noteblock/vault.json"), "keep vault.json (new name)")
        expect(rules.isIgnored("a/.DS_Store"), "ignore DS_Store")
        expect(rules.isIgnored(".trash/old.md"), "ignore trash")
        expect(rules.isIgnored("x/y.log"), "ignore *.log")
        expect(rules.isIgnored("build/out.js") && !rules.isIgnored("a/build/out.js"), "anchored /build/")
        expect(!rules.isIgnored(".env.example") && rules.isIgnored(".env.local"), "negation")
        expect(!rules.isIgnored("Notes/index.md"), "keep notes")

        // Conflict copy naming (sync.mjs)
        let when = Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 14, minute: 3))!
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("quire-selfcheck-\(UUID().uuidString)")
        expect(VaultFiles.conflictName(tmp, "a/index.html", when: when) == "a/index (conflict 2026-10-21 1403).html", "conflict name")
        expect(VaultFiles.conflictName(tmp, "README", when: when) == "README (conflict 2026-10-21 1403)", "conflict name no ext")

        expect(parseRepoInput("https://github.com/basketbla/quire-vault.git").map { "\($0.owner)/\($0.repo)" } == "basketbla/quire-vault", "repo url")
        expect(parseRepoInput("git@github.com:you/field-notes").map { "\($0.owner)/\($0.repo)" } == "you/field-notes", "repo ssh")
        expect(parseRepoInput("nope") == nil, "repo bad")
        return fails
    }

    private static func header(_ name: String, type: Character, size: Int) -> Data {
        var b = [UInt8](repeating: 0, count: 512)
        func put(_ s: String, _ at: Int) { for (i, c) in s.utf8.enumerated() { b[at + i] = c } }
        put(String(name.prefix(100)), 0)
        put("0000644", 100)
        put(String(format: "%011o", size), 124)
        put(String(format: "%011o", 0), 136)
        b[156] = UInt8(String(type).utf8.first!)
        put("ustar", 257); put("00", 263)
        for i in 148..<156 { b[i] = 0x20 }
        let sum = b.reduce(0) { $0 + Int($1) }
        put(String(format: "%06o", sum), 148); b[154] = 0; b[155] = 0x20
        return Data(b)
    }

    private static func padded(_ d: Data) -> Data {
        d + Data(count: (512 - d.count % 512) % 512)
    }

    private static func fileBlock(_ name: String, _ body: Data) -> Data {
        header(name, type: "0", size: body.count) + padded(body)
    }

    private static func paxBlock(_ type: Character, _ kv: [String: String]) -> Data {
        var body = Data()
        for (k, v) in kv {
            let rest = " \(k)=\(v)\n"
            var len = rest.utf8.count + 1
            while "\(len)\(rest)".utf8.count != len { len += 1 }
            body += Data("\(len)\(rest)".utf8)
        }
        return header("pax", type: type, size: body.count) + padded(body)
    }
}
#endif
