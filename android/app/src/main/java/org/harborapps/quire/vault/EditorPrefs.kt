package org.harborapps.quire.vault

import org.harborapps.quire.app.QuireApp

/** Settings › Editor: the page text size, passed to transformEntry as `editor.textSize`. */
object EditorPrefs {
    private const val TEXT_SIZE_KEY = "quire.editor.textSize"
    /** transform.mjs clamps to 13…22; the phone defaults one up from the Mac's 16. */
    val range = 13..22
    const val DEFAULT_TEXT_SIZE = 17

    var textSize: Int
        get() {
            val v = QuireApp.prefs.getInt(TEXT_SIZE_KEY, 0)
            return if (v == 0) DEFAULT_TEXT_SIZE else v.coerceIn(range)
        }
        set(value) { QuireApp.prefs.edit().putInt(TEXT_SIZE_KEY, value.coerceIn(range)).apply() }

    /** The `editor` object passed to transformEntry. */
    fun json(): String = "{\"textSize\":$textSize}"
}

/** A page the vault screens want opened straight into edit mode (a page just created). */
object PageOpenIntent {
    private val editOnOpen = mutableSetOf<String>()
    @Synchronized fun requestEdit(path: String) { editOnOpen.add(path) }
    @Synchronized fun consumeEdit(path: String): Boolean = editOnOpen.remove(path)
}
