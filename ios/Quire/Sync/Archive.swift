import Compression
import Foundation

/// gunzip for GitHub's tarball. Compression's `.zlib` is raw deflate, so the gzip header is
/// parsed here and the 8-byte trailer (crc32 + size) is never fed to the decoder.
enum Gzip {
    /// Length of the gzip header at the start of `head`.
    static func headerLength(_ head: [UInt8]) throws -> Int {
        guard head.count >= 10, head[0] == 0x1f, head[1] == 0x8b, head[2] == 8 else {
            throw SyncError.message("The download from GitHub isn't a gzip file.")
        }
        let flags = head[3]
        var i = 10
        func need(_ n: Int) throws { if i + n > head.count { throw SyncError.message("Bad gzip header.") } }
        if flags & 0x04 != 0 { // FEXTRA
            try need(2)
            let len = Int(head[i]) | Int(head[i + 1]) << 8
            i += 2 + len
        }
        if flags & 0x08 != 0 { // FNAME
            while true { try need(1); i += 1; if head[i - 1] == 0 { break } }
        }
        if flags & 0x10 != 0 { // FCOMMENT
            while true { try need(1); i += 1; if head[i - 1] == 0 { break } }
        }
        if flags & 0x02 != 0 { i += 2 } // FHCRC
        try need(0)
        return i
    }

    static func decompress(file src: URL, to dest: URL) throws {
        let input = try FileHandle(forReadingFrom: src)
        defer { try? input.close() }
        let total = Int(try input.seekToEnd())
        try input.seek(toOffset: 0)
        let head = [UInt8](try input.read(upToCount: 65536) ?? Data())
        let start = try headerLength(head)
        try input.seek(toOffset: UInt64(start))
        var remaining = max(0, total - start - 8)
        FileManager.default.createFile(atPath: dest.path, contents: nil)
        let out = try FileHandle(forWritingTo: dest)
        defer { try? out.close() }
        let filter = try InputFilter<Data>(.decompress, using: .zlib) { (n: Int) -> Data? in
            guard remaining > 0 else { return nil }
            let chunk = try input.read(upToCount: min(n, remaining)) ?? Data()
            remaining -= chunk.count
            return chunk.isEmpty ? nil : chunk
        }
        while let page = try filter.readData(ofLength: 1 << 20), !page.isEmpty {
            try out.write(contentsOf: page)
        }
    }

    static func decompress(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        let start = try headerLength(bytes)
        var body = Data(bytes[start..<max(start, bytes.count - 8)])
        var out = Data()
        let filter = try InputFilter<Data>(.decompress, using: .zlib) { (n: Int) -> Data? in
            guard !body.isEmpty else { return nil }
            let chunk = body.prefix(n)
            body.removeFirst(chunk.count)
            return Data(chunk)
        }
        while let page = try filter.readData(ofLength: 1 << 16), !page.isEmpty { out.append(page) }
        return out
    }
}

/// A minimal ustar reader with pax (`x`, `g`) and GNU long-name (`L`) headers.
final class TarReader {
    struct Entry {
        var path: String
        /// "0" file, "5" dir, "2" symlink, …
        var type: UInt8
        var size: Int
        var mode: Int
        var isFile: Bool { type == UInt8(ascii: "0") || type == 0 || type == UInt8(ascii: "7") }
        var isDir: Bool { type == UInt8(ascii: "5") }
    }

    private let readBytes: (Int) throws -> Data
    private var pending = 0
    private var current: Entry?
    /// The global pax `comment`; `git archive` puts the commit sha there.
    private(set) var globalComment: String?

    init(read: @escaping (Int) throws -> Data) {
        readBytes = read
    }

    convenience init(data: Data) {
        var offset = data.startIndex
        self.init { n in
            let end = min(offset + n, data.endIndex)
            defer { offset = end }
            return data.subdata(in: offset..<end)
        }
    }

    private func readExact(_ n: Int) throws -> Data {
        var out = Data()
        while out.count < n {
            let chunk = try readBytes(n - out.count)
            if chunk.isEmpty { break }
            out.append(chunk)
        }
        return out
    }

    private func skip(_ n: Int) throws {
        var left = n
        while left > 0 {
            let chunk = try readExact(min(left, 1 << 20))
            if chunk.isEmpty { return }
            left -= chunk.count
        }
    }

    private static func padded(_ n: Int) -> Int { (n + 511) / 512 * 512 }

    private static func string(_ b: [UInt8], _ from: Int, _ len: Int) -> String {
        let slice = b[from..<from + len]
        let end = slice.firstIndex(of: 0) ?? slice.endIndex
        return String(decoding: b[from..<end], as: UTF8.self)
    }

    private static func number(_ b: [UInt8], _ from: Int, _ len: Int) -> Int {
        if b[from] & 0x80 != 0 { // base-256
            var n = Int(b[from] & 0x7f)
            for i in from + 1..<from + len { n = n << 8 | Int(b[i]) }
            return n
        }
        let s = string(b, from, len).trimmingCharacters(in: .whitespaces)
        return Int(s, radix: 8) ?? 0
    }

    /// "len key=value\n" records.
    static func parsePax(_ d: Data) -> [String: String] {
        let b = [UInt8](d)
        var out: [String: String] = [:]
        var i = 0
        while i < b.count {
            guard let sp = b[i...].firstIndex(of: 0x20),
                  let len = Int(String(decoding: b[i..<sp], as: UTF8.self)), len > 0, i + len <= b.count else { break }
            let rec = b[(sp + 1)..<(i + len - 1)] // drop the trailing \n
            if let eq = rec.firstIndex(of: UInt8(ascii: "=")) {
                out[String(decoding: rec[rec.startIndex..<eq], as: UTF8.self)] = String(decoding: rec[(eq + 1)...], as: UTF8.self)
            }
            i += len
        }
        return out
    }

    /// The next file, folder or link; nil at the end of the archive.
    func next() throws -> Entry? {
        if pending > 0 { try skip(pending); pending = 0 }
        current = nil
        var pax: [String: String] = [:]
        var longName: String?
        while true {
            let block = [UInt8](try readExact(512))
            if block.count < 512 || block.allSatisfy({ $0 == 0 }) { return nil }
            let type = block[156]
            var size = Self.number(block, 124, 12)
            switch type {
            case UInt8(ascii: "x"), UInt8(ascii: "g"), UInt8(ascii: "L"):
                let body = try readExact(size)
                try skip(Self.padded(size) - size)
                if type == UInt8(ascii: "x") { pax.merge(Self.parsePax(body)) { $1 } }
                else if type == UInt8(ascii: "g") { globalComment = Self.parsePax(body)["comment"] ?? globalComment }
                else { longName = String(decoding: body.prefix { $0 != 0 }, as: UTF8.self) }
                continue
            default:
                break
            }
            var path = Self.string(block, 0, 100)
            if Self.string(block, 257, 5) == "ustar" {
                let prefix = Self.string(block, 345, 155)
                if !prefix.isEmpty { path = prefix + "/" + path }
            }
            if let l = longName { path = l }
            if let p = pax["path"] { path = p }
            if let s = pax["size"].flatMap({ Int($0) }) { size = s }
            let entry = Entry(path: path, type: type, size: size, mode: Self.number(block, 100, 8))
            current = entry
            pending = Self.padded(size)
            return entry
        }
    }

    /// Stream the current entry's content.
    func readBody(_ chunk: (Data) throws -> Void) throws {
        guard let e = current else { return }
        var left = e.size
        while left > 0 {
            let d = try readExact(min(left, 1 << 20))
            if d.isEmpty { break }
            try chunk(d)
            left -= d.count
        }
        try skip(Self.padded(e.size) - e.size)
        pending = 0
    }

    func readBody() throws -> Data {
        var out = Data()
        try readBody { out.append($0) }
        return out
    }
}

enum Archive {
    struct Extracted {
        /// vault-relative path → executable bit
        var files: [String: Bool]
        /// The commit sha from the tarball's pax header, when present.
        var commit: String?
    }

    /// Unpack GitHub's `<owner>-<repo>-<sha>/…` tarball into `dest`, dropping that top folder.
    static func extractTarball(_ tgz: URL, into dest: URL, progress: (Int) -> Void = { _ in }) throws -> Extracted {
        let fm = FileManager.default
        let tar = fm.temporaryDirectory.appendingPathComponent("quire-\(UUID().uuidString).tar")
        defer { try? fm.removeItem(at: tar) }
        try Gzip.decompress(file: tgz, to: tar)
        let fh = try FileHandle(forReadingFrom: tar)
        defer { try? fh.close() }
        let reader = TarReader { n in try fh.read(upToCount: n) ?? Data() }
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        var files: [String: Bool] = [:]
        while let e = try reader.next() {
            let comps = e.path.split(separator: "/").dropFirst()
            guard !comps.isEmpty, let rel = VaultFiles.safeRelative(comps.joined(separator: "/")) else { continue }
            let url = VaultFiles.url(dest, rel)
            if e.isDir {
                try fm.createDirectory(at: url, withIntermediateDirectories: true)
                continue
            }
            guard e.isFile else { continue }
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            fm.createFile(atPath: url.path, contents: nil)
            let out = try FileHandle(forWritingTo: url)
            try reader.readBody { try out.write(contentsOf: $0) }
            try out.close()
            let exec = e.mode & 0o100 != 0
            try? fm.setAttributes([.posixPermissions: exec ? 0o755 : 0o644], ofItemAtPath: url.path)
            files[rel] = exec
            if files.count % 250 == 0 { progress(files.count) }
        }
        let c = reader.globalComment?.trimmingCharacters(in: .whitespacesAndNewlines)
        let commit = c.flatMap { $0.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil ? $0 : nil }
        return Extracted(files: files, commit: commit)
    }
}
