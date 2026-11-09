package org.harborapps.quire.vault

import android.text.format.DateFormat
import android.text.format.DateUtils
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import org.harborapps.quire.app.QuireApp
import java.io.File
import java.text.Normalizer
import java.util.Calendar
import java.util.Locale

/**
 * Page text for search and the row icons: each page's entry file read off the main thread,
 * tags stripped, cached by the entry's modification time so a refresh only re-reads what
 * changed. Port of ios/Quire/Vault/VaultIndex.swift.
 */
object VaultIndex {
    data class Entry(
        /** The entry file's modification time, epoch millis. */
        val mtime: Long,
        /** The entry's visible text, tags and scripts removed, whitespace collapsed. */
        val text: String,
        /** [text] case- and diacritic-folded char for char, so indexes line up with it. */
        val folded: String,
        /** The entry has a `<script>`: an app page. */
        val hasScript: Boolean,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private val _entries = MutableStateFlow<Map<String, Entry>>(emptyMap())
    val entries: StateFlow<Map<String, Entry>> = _entries.asStateFlow()

    /** Re-index `pages` in the background; unchanged entries are reused. */
    @Synchronized
    fun update(pages: List<VaultNode>) {
        val work = pages.map { Triple(it.path, File(it.dir, it.entry), it.isMarkdown) }
        job?.cancel()
        job = scope.launch {
            val old = _entries.value
            val next = HashMap<String, Entry>(work.size)
            for ((path, file, md) in work) {
                ensureActive()
                val mtime = mtime(file) ?: continue
                val hit = old[path]
                if (hit != null && hit.mtime == mtime) {
                    next[path] = hit
                    continue
                }
                val raw = runCatching { file.readText() }.getOrNull() ?: continue
                val text = plainText(raw, md)
                next[path] = Entry(mtime, text, fold(text), raw.contains("<script", ignoreCase = true))
            }
            ensureActive()
            _entries.value = next
        }
    }

    // Search

    data class Hit(
        val page: VaultNode,
        /** Text around the first match in the page body (null when only the title matched). */
        val snippet: AnnotatedString?,
    )

    /** Pages whose title or text contains `query`; title matches first. */
    fun search(
        query: String,
        pages: List<VaultNode>,
        entries: Map<String, Entry>,
        highlight: SpanStyle,
    ): List<Hit> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        val fq = fold(q)
        val titleHits = mutableListOf<Hit>()
        val textHits = mutableListOf<Hit>()
        for (page in pages) {
            val snippet = entries[page.path]?.let { snippet(it, fq, highlight) }
            if (fold(page.title).contains(fq)) {
                titleHits += Hit(page, snippet)
            } else if (snippet != null) {
                textHits += Hit(page, snippet)
            }
        }
        return titleHits + textHits
    }

    /** ~40 chars before and ~80 after the first match, the match styled with `highlight`. */
    fun snippet(entry: Entry, foldedQuery: String, highlight: SpanStyle): AnnotatedString? {
        val text = entry.text
        val at = entry.folded.indexOf(foldedQuery)
        if (at < 0) return null
        val end = at + foldedQuery.length
        val start = (at - 40).coerceAtLeast(0)
        val stop = (end + 80).coerceAtMost(text.length)
        val body = text.substring(start, stop)
        val lead = body.length - body.trimStart().length
        val trimmed = body.trim()
        val mStart = (at - start - lead).coerceIn(0, trimmed.length)
        val mEnd = (mStart + foldedQuery.length).coerceAtMost(trimmed.length)
        return buildAnnotatedString {
            if (start > 0) append("…")
            append(trimmed.substring(0, mStart))
            withStyle(highlight) { append(trimmed.substring(mStart, mEnd)) }
            append(trimmed.substring(mEnd))
            if (stop < text.length) append("…")
        }
    }

    /** Lower-case and strip diacritics one char at a time (so the result is index-aligned). */
    fun fold(s: String): String {
        val out = CharArray(s.length)
        for (i in s.indices) {
            val c = s[i]
            out[i] = if (c.code < 128) {
                c.lowercaseChar()
            } else {
                (Normalizer.normalize(c.toString(), Normalizer.Form.NFD).firstOrNull() ?: c).lowercaseChar()
            }
        }
        return String(out)
    }

    // Files

    fun mtime(file: File): Long? = file.lastModified().takeIf { it > 0L }

    /** The page's entry file's modification time (reads the disk; prefer [entries]' mtime). */
    fun edited(page: VaultNode): Long? = mtime(File(page.dir, page.entry))

    private val FRONT_MATTER = Regex("\\A---\\n[\\s\\S]*?\\n---\\n")
    private val MD_MARKS = Regex("(?m)^#+\\s*|[*_`>]")
    private val BLOCKS = Regex("(?is)<(script|style|head|template)\\b.*?</\\1\\s*>")
    private val COMMENTS = Regex("(?s)<!--.*?-->")
    private val TAGS = Regex("<[^>]*>")
    private val SPACE = Regex("\\s+")
    private val ENTITIES = listOf(
        "&nbsp;" to " ", "&lt;" to "<", "&gt;" to ">", "&quot;" to "\"", "&#39;" to "'", "&amp;" to "&",
    )

    fun plainText(raw: String, markdown: Boolean): String {
        var s = raw
        if (markdown) {
            s = s.replace(FRONT_MATTER, "")
            s = s.replace(MD_MARKS, "")
        }
        s = s.replace(BLOCKS, " ")
        s = s.replace(COMMENTS, " ")
        s = s.replace(TAGS, " ")
        for ((entity, char) in ENTITIES) s = s.replace(entity, char)
        return s.replace(SPACE, " ").trim()
    }

    /** "9:12" today, "yesterday", "Oct 19" this year, else a medium date. */
    fun relative(millis: Long): String {
        val ctx = QuireApp.context
        val now = Calendar.getInstance()
        val then = Calendar.getInstance().apply { timeInMillis = millis }
        val sameYear = now.get(Calendar.YEAR) == then.get(Calendar.YEAR)
        return when {
            DateUtils.isToday(millis) -> DateFormat.getTimeFormat(ctx).format(then.time)
            DateUtils.isToday(millis + DateUtils.DAY_IN_MILLIS) -> "yesterday"
            sameYear -> DateFormat.format(DateFormat.getBestDateTimePattern(Locale.getDefault(), "MMMd"), then).toString()
            else -> DateFormat.getMediumDateFormat(ctx).format(then.time)
        }
    }

    /** "Journal · edited 9:12" (capitalised when there is no folder: "Edited 9:12"). */
    fun recentLine(page: VaultNode, mtime: Long?): String {
        val folder = page.parentPath.split('/').lastOrNull()?.takeIf { it.isNotEmpty() }
        val edited = mtime?.let { "edited ${relative(it)}" }
        return listOfNotNull(folder, edited).joinToString(" · ")
            .replaceFirstChar { it.titlecase(Locale.getDefault()) }
    }
}

/** The last opened pages (newest first, up to 5), by vault path, in [QuireApp.prefs]. */
object RecentPages {
    private const val KEY = "quire.recent"
    const val LIMIT = 5

    private val _paths = MutableStateFlow(load())
    val paths: StateFlow<List<String>> = _paths.asStateFlow()

    private fun load(): List<String> = runCatching {
        QuireApp.prefs.getString(KEY, null)?.let { Json.decodeFromString<List<String>>(it) }
    }.getOrNull() ?: emptyList()

    @Synchronized
    fun record(path: String) {
        set((listOf(path) + _paths.value.filter { it != path }).take(LIMIT))
    }

    @Synchronized
    fun remove(path: String) {
        set(_paths.value.filter { it != path && !it.startsWith("$path/") })
    }

    private fun set(next: List<String>) {
        if (next == _paths.value) return
        _paths.value = next
        QuireApp.prefs.edit().putString(KEY, Json.encodeToString(next)).apply()
    }
}
