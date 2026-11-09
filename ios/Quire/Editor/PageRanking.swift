import Foundation

/// The desktop page picker's ranking (runtime.js `scoreText` / `scorePage`): a word at the
/// start of the title or path beats one at a word start, which beats any substring, which
/// beats letters in order; the title counts more than the folder path.
enum PageRanking {
    struct Candidate {
        let node: VaultNode
        let title: String
        let folder: String
        fileprivate let lowTitle: String
        fileprivate let lowPath: String

        init(_ node: VaultNode) {
            self.node = node
            title = node.title.isEmpty ? node.name : node.title
            folder = node.path.split(separator: "/").dropLast().joined(separator: " / ")
            lowTitle = title.lowercased()
            lowPath = node.path.lowercased()
        }
    }

    static func candidates(_ pages: [VaultNode], excluding path: String) -> [Candidate] {
        pages.filter { $0.path != path }.map(Candidate.init).sorted { $0.lowTitle < $1.lowTitle }
    }

    static func rank(_ all: [Candidate], query: String, limit: Int) -> [Candidate] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        if words.isEmpty { return Array(all.prefix(limit)) }
        var hits: [(Candidate, Int, Int)] = []
        for (i, c) in all.enumerated() {
            if let s = score(c, words) { hits.append((c, s, i)) }
        }
        hits.sort { $0.1 != $1.1 ? $0.1 > $1.1 : $0.2 < $1.2 }
        return hits.prefix(limit).map(\.0)
    }

    private static func score(_ c: Candidate, _ words: [String]) -> Int? {
        var total = 0
        for w in words {
            let t = scoreText(c.lowTitle, w)
            let p = scoreText(c.lowPath, w)
            let s = max(t >= 0 ? t + 20 : -1, p)
            if s < 0 { return nil }
            total += s
        }
        return total
    }

    /// Higher is better; -1 is no match.
    static func scoreText(_ hay: String, _ w: String) -> Int {
        let h = Array(hay), n = Array(w)
        guard !n.isEmpty else { return 0 }
        if let at = hay.range(of: w).map({ hay.distance(from: hay.startIndex, to: $0.lowerBound) }) {
            if at == 0 { return 100 }
            let before = h[at - 1]
            return " /_-.".contains(before) || before.isWhitespace ? 80 : 60 - min(at, 20)
        }
        var first = -1, j = 0
        for i in 0..<h.count where j < n.count {
            if h[i] == n[j] {
                if first < 0 { first = i }
                j += 1
                if j == n.count { return max(1, 30 - (i - first - n.count)) }
            }
        }
        return -1
    }
}
