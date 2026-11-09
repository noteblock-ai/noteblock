import Foundation
import Security

/// The connected repo, kept in Application Support (never in the vault, so it isn't synced).
struct SyncConfig: Codable, Equatable {
    var owner: String
    var repo: String
    var branch: String
    /// The vault folder in Documents this repo syncs into.
    var folder: String
    var login: String?
    var userId: Int?
    var lastSyncAt: Date?
    var conflicts: [SyncConflict] = []

    var fullName: String { "\(owner)/\(repo)" }
}

/// A file changed on both sides. The remote version sits at `path`; this iPhone's version was
/// written beside it as `copy`.
struct SyncConflict: Codable, Identifiable, Hashable {
    var path: String
    var copy: String
    var at: Date
    var id: String { copy }
}

/// Size, mtime and exec bit let a scan skip re-hashing files that didn't change.
struct ManifestEntry: Codable, Equatable {
    /// git blob sha
    var s: String
    var z: Int
    var m: Double
    var x: Bool?
}

/// The last synced commit and, for every tracked file, the blob sha it had at that commit.
/// A local file whose sha differs from its entry was changed on this iPhone since.
struct SyncState: Codable {
    var sha: String
    var files: [String: ManifestEntry]
}

enum SyncStore {
    static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Sync", isDirectory: true)
    }

    private static var configURL: URL { dir.appendingPathComponent("config.json") }
    private static var stateURL: URL { dir.appendingPathComponent("state.json") }

    private static func write<T: Encodable>(_ value: T, to url: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        try enc.encode(value).write(to: url, options: .atomic)
    }

    private static func read<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return try? dec.decode(type, from: data)
    }

    static func loadConfig() -> SyncConfig? { read(SyncConfig.self, from: configURL) }
    static func saveConfig(_ c: SyncConfig) throws { try write(c, to: configURL) }
    static func loadState() -> SyncState? { read(SyncState.self, from: stateURL) }
    static func saveState(_ s: SyncState) throws { try write(s, to: stateURL) }

    static func clear() {
        try? FileManager.default.removeItem(at: configURL)
        try? FileManager.default.removeItem(at: stateURL)
        Keychain.deleteToken()
    }
}

/// The GitHub token, as a generic password in the Keychain.
enum Keychain {
    private static let service = "org.harborapps.quire.github"
    private static let account = "token"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func token() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func setToken(_ token: String) throws {
        deleteToken()
        var q = query
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        if status != errSecSuccess { throw SyncError.message("Couldn't save the token to the Keychain (\(status)).") }
    }

    static func deleteToken() {
        SecItemDelete(query as CFDictionary)
    }
}

/// Which vault folder in Documents is open. VaultStore.openDefault() already reads this same
/// UserDefaults key ("quire.vault"); VaultModel listens for `.quireVaultSelected` and reopens.
enum VaultSelection {
    static let key = "quire.vault"

    static var current: String? { UserDefaults.standard.string(forKey: key) }

    static func select(_ folder: String) {
        UserDefaults.standard.set(folder, forKey: key)
        NotificationCenter.default.post(name: .quireVaultSelected, object: folder)
    }
}

extension Notification.Name {
    /// Sync wrote files into the vault (pulled changes or conflict copies). VaultModel refreshes.
    static let quireVaultChanged = Notification.Name("quireVaultChanged")
    /// A different vault folder became current (after a first connect). VaultModel reopens.
    static let quireVaultSelected = Notification.Name("quireVaultSelected")
}
