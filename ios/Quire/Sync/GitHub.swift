import Foundation

enum SyncError: LocalizedError, Equatable {
    case offline
    case badToken
    case notFound
    case rateLimited(remaining: String, reset: Date?)
    case refMoved
    case http(Int, String)
    case message(String)

    var errorDescription: String? {
        switch self {
        case .offline: return "You're offline."
        case .badToken: return "GitHub didn't accept the token. Make a new one with the repo scope."
        case .notFound: return "GitHub can't find that repo or branch. Check the name, and that the token has the repo scope."
        case .rateLimited(let left, let reset):
            let when = reset.map { " It resets at \($0.formatted(date: .omitted, time: .shortened))." } ?? ""
            return "GitHub's rate limit is used up (\(left) requests left).\(when)"
        case .refMoved: return "The repo changed while pushing."
        case .http(let code, let msg): return msg.isEmpty ? "GitHub answered \(code)." : "GitHub answered \(code): \(msg)"
        case .message(let m): return m
        }
    }
}

/// owner/repo from "owner/repo", "github.com/owner/repo", an https or ssh URL, with or without .git.
func parseRepoInput(_ raw: String) -> (owner: String, repo: String)? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    for prefix in ["https://", "http://", "git@", "ssh://git@"] where s.lowercased().hasPrefix(prefix) {
        s = String(s.dropFirst(prefix.count))
    }
    if s.lowercased().hasPrefix("www.") { s = String(s.dropFirst(4)) }
    if s.lowercased().hasPrefix("github.com") { s = String(s.dropFirst("github.com".count)) }
    s = s.trimmingCharacters(in: CharacterSet(charactersIn: ":/"))
    if s.hasSuffix(".git") { s = String(s.dropLast(4)) }
    let parts = s.split(separator: "/").map(String.init)
    guard parts.count >= 2 else { return nil }
    let ok = { (p: String) in p.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil }
    guard ok(parts[0]), ok(parts[1]) else { return nil }
    return (parts[0], parts[1])
}

struct CompareFile {
    var filename: String
    var status: String
    var sha: String?
    var previous: String?
}

/// The GitHub REST calls sync needs. Paths are relative to api.github.com.
struct GitHubClient: Sendable {
    let token: String
    let owner: String
    let repo: String

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 60
        c.timeoutIntervalForResource = 600
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    private var base: String { "/repos/\(owner)/\(repo)" }

    private static let pathChars: CharacterSet = {
        var c = CharacterSet.urlPathAllowed
        c.remove(charactersIn: "?#%;")
        return c
    }()

    /// Percent-encode a vault path segment by segment.
    static func encodePath(_ p: String) -> String {
        p.split(separator: "/", omittingEmptySubsequences: false)
            .map { String($0).addingPercentEncoding(withAllowedCharacters: pathChars) ?? String($0) }
            .joined(separator: "/")
    }

    private func request(_ method: String, _ path: String, query: [URLQueryItem] = [], accept: String = "application/vnd.github+json", json: Any? = nil) throws -> URLRequest {
        var comps = URLComponents()
        comps.scheme = "https"
        comps.host = "api.github.com"
        comps.percentEncodedPath = path
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { throw SyncError.message("Bad request path \(path)") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(accept, forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        req.setValue("Quire-iPhone", forHTTPHeaderField: "User-Agent")
        if let json {
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private static func mapTransport(_ error: Error) -> Error {
        guard let u = error as? URLError else { return error }
        switch u.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost,
             .timedOut, .dataNotAllowed, .internationalRoamingOff, .dnsLookupFailed:
            return SyncError.offline
        default:
            return error
        }
    }

    private static func check(_ data: Data, _ resp: URLResponse) throws -> HTTPURLResponse {
        guard let http = resp as? HTTPURLResponse else { throw SyncError.message("No response from GitHub.") }
        if (200..<300).contains(http.statusCode) { return http }
        let msg = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["message"] as? String ?? ""
        let remaining = http.value(forHTTPHeaderField: "X-RateLimit-Remaining")
        switch http.statusCode {
        case 401: throw SyncError.badToken
        case 403, 429:
            if remaining == "0" || http.statusCode == 429 || msg.lowercased().contains("rate limit") {
                let reset = http.value(forHTTPHeaderField: "X-RateLimit-Reset").flatMap(Double.init).map { Date(timeIntervalSince1970: $0) }
                throw SyncError.rateLimited(remaining: remaining ?? "0", reset: reset)
            }
            throw SyncError.http(http.statusCode, msg)
        case 404: throw SyncError.notFound
        default: throw SyncError.http(http.statusCode, msg)
        }
    }

    private func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await Self.session.data(for: req)
            return (data, try Self.check(data, resp))
        } catch {
            throw Self.mapTransport(error)
        }
    }

    private func object(_ req: URLRequest) async throws -> [String: Any] {
        let (data, _) = try await send(req)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SyncError.message("GitHub sent something unexpected.")
        }
        return obj
    }

    // MARK: - Endpoints

    /// GET /repos/:o/:r — the default branch and whether the token can push.
    func repoInfo() async throws -> (defaultBranch: String, canPush: Bool) {
        let o = try await object(request("GET", base))
        let branch = o["default_branch"] as? String ?? "main"
        let push = (o["permissions"] as? [String: Any])?["push"] as? Bool ?? true
        return (branch, push)
    }

    func user() async throws -> (login: String, id: Int) {
        let o = try await object(request("GET", "/user"))
        return (o["login"] as? String ?? "", (o["id"] as? NSNumber)?.intValue ?? 0)
    }

    /// The branch's head commit sha (Accept: vnd.github.sha returns the bare sha).
    func headSha(_ branch: String) async throws -> String {
        let (data, _) = try await send(request("GET", "\(base)/commits/\(Self.encodePath(branch))", accept: "application/vnd.github.sha"))
        let sha = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard sha.count == 40 else { throw SyncError.message("GitHub didn't return a commit for \(branch).") }
        return sha
    }

    func treeSha(ofCommit sha: String) async throws -> String {
        let o = try await object(request("GET", "\(base)/git/commits/\(sha)"))
        guard let t = (o["tree"] as? [String: Any])?["sha"] as? String else { throw SyncError.message("Commit \(sha) has no tree.") }
        return t
    }

    /// Changed files between two commits. Returns nil when GitHub caps the list (300 files),
    /// so the caller falls back to a tarball.
    func compare(_ from: String, _ to: String) async throws -> [CompareFile]? {
        var files: [CompareFile] = []
        var page = 1
        while true {
            let o = try await object(request("GET", "\(base)/compare/\(from)...\(to)",
                                             query: [URLQueryItem(name: "per_page", value: "100"), URLQueryItem(name: "page", value: String(page))]))
            let raw = o["files"] as? [[String: Any]] ?? []
            if raw.count >= 300 { return nil }
            for f in raw {
                guard let name = f["filename"] as? String, let status = f["status"] as? String else { continue }
                files.append(CompareFile(filename: name, status: status, sha: f["sha"] as? String, previous: f["previous_filename"] as? String))
            }
            // Files are paged alongside commits; keep going while a page of commits is full.
            let commits = (o["commits"] as? [Any])?.count ?? 0
            let total = (o["total_commits"] as? NSNumber)?.intValue ?? 0
            if commits < 100 || page * 100 >= total || raw.isEmpty { break }
            page += 1
            if page > 20 { return nil }
        }
        // A path can show up on several pages; the last mention wins.
        var seen = Set<String>()
        let deduped = files.reversed().filter { seen.insert($0.filename).inserted }.reversed()
        let result = Array(deduped)
        return result.count >= 300 ? nil : result
    }

    /// A file's bytes at `ref`, via the contents API's raw media type.
    func raw(_ path: String, ref: String) async throws -> Data {
        let (data, _) = try await send(request("GET", "\(base)/contents/\(Self.encodePath(path))",
                                              query: [URLQueryItem(name: "ref", value: ref)],
                                              accept: "application/vnd.github.raw"))
        return data
    }

    /// GET /tarball/:ref (redirects to codeload) into a temp file the caller removes.
    func downloadTarball(_ ref: String) async throws -> URL {
        let req = try request("GET", "\(base)/tarball/\(Self.encodePath(ref))")
        do {
            let (tmp, resp) = try await Self.session.download(for: req)
            let dest = FileManager.default.temporaryDirectory.appendingPathComponent("quire-\(UUID().uuidString).tar.gz")
            try FileManager.default.moveItem(at: tmp, to: dest)
            if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                let body = (try? Data(contentsOf: dest)) ?? Data()
                try? FileManager.default.removeItem(at: dest)
                _ = try Self.check(body, resp)
            }
            return dest
        } catch {
            throw Self.mapTransport(error)
        }
    }

    func createBlob(_ data: Data) async throws -> String {
        let o = try await object(request("POST", "\(base)/git/blobs", json: ["content": data.base64EncodedString(), "encoding": "base64"]))
        guard let sha = o["sha"] as? String else { throw SyncError.message("GitHub didn't make the blob.") }
        return sha
    }

    func createTree(base tree: String, entries: [[String: Any]]) async throws -> String {
        let o = try await object(request("POST", "\(base)/git/trees", json: ["base_tree": tree, "tree": entries]))
        guard let sha = o["sha"] as? String else { throw SyncError.message("GitHub didn't make the tree.") }
        return sha
    }

    func createCommit(message: String, tree: String, parent: String, author: [String: String]) async throws -> String {
        let o = try await object(request("POST", "\(base)/git/commits",
                                         json: ["message": message, "tree": tree, "parents": [parent], "author": author]))
        guard let sha = o["sha"] as? String else { throw SyncError.message("GitHub didn't make the commit.") }
        return sha
    }

    /// Fast-forward the branch. A 422 means someone pushed first: SyncError.refMoved.
    func updateRef(_ branch: String, to sha: String) async throws {
        do {
            _ = try await send(request("PATCH", "\(base)/git/refs/heads/\(Self.encodePath(branch))", json: ["sha": sha, "force": false]))
        } catch SyncError.http(422, _) {
            throw SyncError.refMoved
        }
    }
}
