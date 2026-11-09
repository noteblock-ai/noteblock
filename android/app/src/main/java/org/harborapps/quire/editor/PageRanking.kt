package org.harborapps.quire.editor

import org.harborapps.quire.vault.VaultNode

/**
 * The desktop page picker's ranking (runtime.js `scoreText` / `scorePage`): a word at the
 * start of the title or path beats one at a word start, which beats any substring, which
 * beats letters in order; the title counts more than the folder path.
 * Port of ios/Quire/Editor/PageRanking.swift.
 */
object PageRanking {
    class Candidate(val node: VaultNode) {
        val title: String = node.title.ifEmpty { node.name }
        val folder: String = node.path.split("/").filter { it.isNotEmpty() }.dropLast(1).joinToString(" / ")
        internal val lowTitle: String = title.lowercase()
        internal val lowPath: String = node.path.lowercase()
    }

    fun candidates(pages: List<VaultNode>, excluding: String): List<Candidate> =
        pages.filter { it.path != excluding }.map(::Candidate).sortedWith { a, b -> a.lowTitle.compareTo(b.lowTitle) }

    fun rank(all: List<Candidate>, query: String, limit: Int): List<Candidate> {
        val words = words(query)
        if (words.isEmpty()) return all.take(limit)
        data class Hit(val c: Candidate, val score: Int, val index: Int)
        val hits = ArrayList<Hit>()
        all.forEachIndexed { i, c -> score(c, words)?.let { hits.add(Hit(c, it, i)) } }
        hits.sortWith { a, b -> if (a.score != b.score) b.score.compareTo(a.score) else a.index.compareTo(b.index) }
        return hits.take(limit).map { it.c }
    }

    private fun score(c: Candidate, words: List<String>): Int? {
        var total = 0
        for (w in words) {
            val t = scoreText(c.lowTitle, w)
            val p = scoreText(c.lowPath, w)
            val s = maxOf(if (t >= 0) t + 20 else -1, p)
            if (s < 0) return null
            total += s
        }
        return total
    }

    /** Higher is better; -1 is no match. */
    fun scoreText(hay: String, w: String): Int {
        if (w.isEmpty()) return 0
        val at = hay.indexOf(w)
        if (at >= 0) {
            if (at == 0) return 100
            val before = hay[at - 1]
            return if (before in " /_-." || before.isWhitespace()) 80 else 60 - minOf(at, 20)
        }
        var first = -1
        var j = 0
        for (i in hay.indices) {
            if (j >= w.length) break
            if (hay[i] == w[j]) {
                if (first < 0) first = i
                j += 1
                if (j == w.length) return maxOf(1, 30 - (i - first - w.length))
            }
        }
        return -1
    }

    /** The query's lowercased words, split on whitespace. */
    internal fun words(query: String): List<String> =
        query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
}
