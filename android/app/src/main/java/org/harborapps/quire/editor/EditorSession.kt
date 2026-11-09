package org.harborapps.quire.editor

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.inputmethod.InputMethodManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import org.harborapps.quire.BuildConfig
import org.harborapps.quire.web.PageController

/**
 * The native half of the editor: talks to `window.quire.editor` in the page
 * (app/runtime/runtime.js, "native editor commands") and hears back on the `quireEditor`
 * channel ([PageController.onEditorMessage]). Port of ios/Quire/Editor/EditorSession.swift;
 * the keyboard bar is [EditorToolbar], docked above the IME by the page screen. Main thread only.
 */
class EditorSession {
    /** What `quire.editor.state()` reports for the caret. */
    data class State(
        val editing: Boolean = false,
        val bold: Boolean = false,
        val italic: Boolean = false,
        /** "p", "h1"…"h3", "ol", "ul", "checklist", "quote", "code". */
        val block: String = "p",
        val canUndo: Boolean = false,
        val canRedo: Boolean = false,
        val saving: Boolean = false,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** The insert sheet is up (Compose state). */
    var showInsert by mutableStateOf(false)

    private var controller: PageController? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    /** Wire the page's editor messages into this session. Safe to call repeatedly. */
    fun attach(controller: PageController) {
        this.controller = controller
        controller.onEditorMessage = { receive(it) }
    }

    /** Stop talking to the controller (the screen is leaving). */
    fun detach() {
        mainHandler.removeCallbacksAndMessages(null)
        controller?.let { if (it.onEditorMessage != null) it.onEditorMessage = null }
        controller = null
    }

    /** Edit mode turned on or off: state resets on leaving; the caret goes in on entering. */
    fun modeChanged() {
        val c = controller ?: return
        mainHandler.removeCallbacksAndMessages(null)
        if (!c.mode.value.edit) {
            _state.value = State()
            showInsert = false
        } else {
            // The caret into the page once the runtime has applied the mode (a tap that started
            // editing has already put it under the finger; focus() keeps that), so the IME comes up.
            mainHandler.postDelayed({ focus() }, 300)
        }
    }

    // MARK: - Commands

    /**
     * `quire.editor.<call>` in the top page. [args] become local variables, bound from a JSON
     * literal (keys must be JS identifiers), so user text never lands in the source raw.
     */
    fun run(call: String, args: JsonObject = JsonObject(emptyMap())) {
        val c = controller ?: return
        val bindings = args.keys.filter { IDENT.matches(it) }.joinToString("") { "var $it=a[${JsonPrimitive(it)}];" }
        val js = "(function(){var e=window.quire&&window.quire.editor; if(!e) return null; " +
            "var a=$args; $bindings return e.$call;})()"
        c.evaluate(js) { result ->
            if (BuildConfig.DEBUG && result == null) Log.d(TAG, "editor.$call: no result")
        }
    }

    fun bold() = run("bold()")
    fun italic() = run("italic()")
    fun heading(level: Int) = run("heading(level)", buildJsonObject { put("level", level) })
    fun list(kind: String) = run("list(kind)", buildJsonObject { put("kind", kind) })
    fun checklist() = run("checklist()")
    fun indent() = run("indent()")
    fun outdent() = run("outdent()")
    fun undo() = run("undo()")
    fun redo() = run("redo()")
    fun insertBlock(kind: String) = run("insertBlock(kind)", buildJsonObject { put("kind", kind) })
    fun insertEmbed(path: String) = run("insertEmbed(path)", buildJsonObject { put("path", path) })
    fun insertImage(src: String, alt: String = "") =
        run("insertImage(src, alt)", buildJsonObject { put("src", src); put("alt", alt) })
    fun focus() = run("focus()")
    fun setTapToEdit(on: Boolean) = run("setTapToEdit(on)", buildJsonObject { put("on", on) })

    /** What the insert sheet picked. */
    fun insert(insertion: Insertion) {
        when (insertion) {
            is Insertion.Block -> insertBlock(insertion.kind)
            is Insertion.Embed -> insertEmbed(insertion.path)
            is Insertion.Image -> insertImage(insertion.src)
        }
    }

    /** Blur the page and put the IME away. */
    fun hideKeyboard() {
        run("blur()")
        val web = controller?.webView ?: return
        ViewCompat.getWindowInsetsController(web)?.hide(WindowInsetsCompat.Type.ime())
        val imm = web.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(web.windowToken, 0)
    }

    // MARK: - Messages from the page

    private fun receive(obj: JsonObject) {
        fun bool(k: String) = (obj[k] as? JsonPrimitive)?.booleanOrNull ?: false
        when ((obj["type"] as? JsonPrimitive)?.contentOrNull) {
            "state" -> {
                val s = State(
                    editing = bool("editing"),
                    bold = bool("bold"),
                    italic = bool("italic"),
                    block = (obj["block"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "p",
                    canUndo = bool("canUndo"),
                    canRedo = bool("canRedo"),
                    saving = bool("saving"),
                )
                if (s != _state.value) _state.value = s
            }
            "tap-edit" -> {
                // The runtime already turned the editor on inside the tap; catch the app's mode up.
                val c = controller ?: return
                if (!c.mode.value.edit && c.canEdit) c.setEditing(true)
            }
        }
    }

    private companion object {
        const val TAG = "QuireEditor"
        val IDENT = Regex("^[A-Za-z_$][A-Za-z0-9_$]*$")
    }
}
