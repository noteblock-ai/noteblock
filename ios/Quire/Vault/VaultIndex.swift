import Foundation
import SwiftUI

/// Page text for search and the row icons: each page's entry file read off the main thread,
/// tags stripped, cached by the entry's modification date so a refresh only re-reads what
/// changed.
@MainActor
final class VaultIndex: ObservableObject {
    struct Entry: Sendable {
        var mtime: Date
        /// The entry's visible text, tags and scripts removed, whitespace collapsed.
        var text: String
        /// The entry has a `<script>`: an app page.
        var hasScript: Bool
    }

    @Published private(set) var entries: [String: Entry] = [:]
    private var task: Task<Void, Never>?

    func update(pages: [VaultNode]) {
        let old = entries
        let work = pages.map { ($0.path, $0.dir.appendingPathComponent($0.entry), $0.isMarkdown) }
        task?.cancel()
        task = Task.detached(priority: .utility) { [weak self] in
            var next: [String: Entry] = [:]
            for (path, file, md) in work {
                if Task.isCancelled { return }
                guard let mtime = Self.mtime(file) else { continue }
                if let hit = old[path], hit.mtime == mtime { next[path] = hit; continue }
                guard let raw = try? String(contentsOf: file, encoding: .utf8) else { continue }
                next[path] = Entry(mtime: mtime, text: Self.plainText(raw, markdown: md), hasScript: raw.range(of: "<script", options: .caseInsensitive) != nil)
            }
            await MainActor.run { [next] in self?.entries = next }
        }
    }

    // MARK: - Search

    struct Hit: Identifiable {
        var page: VaultNode
        /// Text around the first match in the page body (nil when only the title matched).
        var snippet: AttributedString?
        var id: String { page.path }
    }

    /// Pages whose title or text contains `query`; title matches first.
    func search(_ query: String, in pages: [VaultNode]) -> [Hit] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        let opts: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        var titleHits: [Hit] = []
        var textHits: [Hit] = []
        for page in pages {
            let snippet = entries[page.path].flatMap { Self.snippet($0.text, query: q) }
            if page.title.range(of: q, options: opts) != nil {
                titleHits.append(Hit(page: page, snippet: snippet))
            } else if let snippet {
                textHits.append(Hit(page: page, snippet: snippet))
            }
        }
        return titleHits + textHits
    }

    nonisolated static func snippet(_ text: String, query: String) -> AttributedString? {
        let opts: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        guard let r = text.range(of: query, options: opts) else { return nil }
        let start = text.index(r.lowerBound, offsetBy: -40, limitedBy: text.startIndex) ?? text.startIndex
        let end = text.index(r.upperBound, offsetBy: 80, limitedBy: text.endIndex) ?? text.endIndex
        var s = String(text[start..<end]).trimmingCharacters(in: .whitespaces)
        if start > text.startIndex { s = "…" + s }
        if end < text.endIndex { s += "…" }
        var out = AttributedString(s)
        if let mr = out.range(of: query, options: opts) {
            out[mr].foregroundColor = Theme.ink
            out[mr].inlinePresentationIntent = .stronglyEmphasized
        }
        return out
    }

    // MARK: - Files

    nonisolated static func mtime(_ file: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date
    }

    /// The page's entry file's modification date.
    nonisolated static func edited(_ page: VaultNode) -> Date? {
        mtime(page.dir.appendingPathComponent(page.entry))
    }

    nonisolated static func plainText(_ raw: String, markdown: Bool) -> String {
        var s = raw
        if markdown {
            s = s.replacingOccurrences(of: "\\A---\\n[\\s\\S]*?\\n---\\n", with: "", options: .regularExpression)
            s = s.replacingOccurrences(of: "(?m)^#+\\s*|[*_`>]", with: "", options: .regularExpression)
        }
        s = s.replacingOccurrences(of: "(?is)<(script|style|head|template)\\b.*?</\\1\\s*>", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "(?s)<!--.*?-->", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "<[^>]*>", with: " ", options: .regularExpression)
        for (entity, char) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&amp;", "&")] {
            s = s.replacingOccurrences(of: entity, with: char)
        }
        return s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }
}

/// The last opened pages (newest first, up to 5), by vault path, in UserDefaults.
@MainActor
final class RecentPages: ObservableObject {
    static let shared = RecentPages()
    private static let key = "quire.recent"
    static let limit = 5

    @Published private(set) var paths: [String]

    private init() {
        paths = UserDefaults.standard.stringArray(forKey: Self.key) ?? []
    }

    func record(_ path: String) {
        var next = paths.filter { $0 != path }
        next.insert(path, at: 0)
        set(Array(next.prefix(Self.limit)))
    }

    func remove(_ path: String) {
        set(paths.filter { $0 != path && !$0.hasPrefix(path + "/") })
    }

    private func set(_ next: [String]) {
        guard next != paths else { return }
        paths = next
        UserDefaults.standard.set(next, forKey: Self.key)
    }
}

/// Settings › Editor. Read by the scheme handler's `editorPrefs` hook (any thread), so the
/// next page load gets it, like config.json "editor" on the Mac.
enum EditorPrefs {
    static let textSizeKey = "quire.editor.textSize"
    /// transform.mjs clamps to 13…22; the phone defaults one up from the Mac's 16.
    static let range = 13...22
    static let defaultTextSize = 17

    static var textSize: Int {
        get {
            let v = UserDefaults.standard.integer(forKey: textSizeKey)
            return v == 0 ? defaultTextSize : min(range.upperBound, max(range.lowerBound, v))
        }
        set { UserDefaults.standard.set(newValue, forKey: textSizeKey) }
    }

    /// The `editor` object passed to transformEntry.
    static func dict() -> [String: Any] { ["textSize": textSize] }
}

/// A page the vault screens want opened straight into edit mode (a page just created).
/// PageScreen consumes it once the controller exists:
///   `.onAppear { if PageOpenIntent.consumeEdit(page.path) { controller.setEditing(true) } }`
/// (setEditing before load is queued by PageController and sent once the page loads).
@MainActor
enum PageOpenIntent {
    private static var editOnOpen = Set<String>()

    static func requestEdit(_ path: String) { editOnOpen.insert(path) }

    static func consumeEdit(_ path: String) -> Bool { editOnOpen.remove(path) != nil }
}
