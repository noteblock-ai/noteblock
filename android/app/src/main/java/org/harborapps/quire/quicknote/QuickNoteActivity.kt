package org.harborapps.quire.quicknote

import android.content.Intent
import android.os.Bundle
import android.view.inputmethod.InputMethodManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.harborapps.quire.app.MainActivity
import org.harborapps.quire.bridge.RpcBridge
import org.harborapps.quire.design.QuireTheme
import org.harborapps.quire.editor.EditorSession
import org.harborapps.quire.editor.EditorToolbar
import org.harborapps.quire.vault.VaultModel
import org.harborapps.quire.vault.VaultNode
import org.harborapps.quire.web.PageController
import org.harborapps.quire.web.PageServer
import org.harborapps.quire.web.PageWebView

/**
 * The quick note (AndroidCapture.dc.html): the `Floating note` page in a sheet over the current
 * app, in edit mode with the keyboard up. Opened by the Quick Settings tile, the launcher
 * shortcut and the share sheet (ACTION_SEND text/plain appends the text first). The Android
 * stand-in for the desktop floating note (docs/decisions/android.md "Quick note").
 */
class QuickNoteActivity : ComponentActivity() {
    private var ui by mutableStateOf<Ui>(Ui.Loading)
    private var controller: PageController? = null
    private var session: EditorSession? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            QuireTheme {
                QuickNoteScreen(ui, onClose = ::close)
            }
        }
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onPause() {
        super.onPause()
        controller?.flushSave()
    }

    override fun onDestroy() {
        session?.detach()
        controller?.destroy()
        session = null
        controller = null
        super.onDestroy()
    }

    /** Save, put the keyboard away and leave. */
    private fun close() {
        session?.hideKeyboard()
        controller?.flushSave()
        currentFocus?.let { v ->
            (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(v.windowToken, 0)
        }
        finish()
    }

    private fun handle(intent: Intent?) {
        val shared = sharedText(intent)
        val existing = controller
        if (existing != null && shared == null) return // already open: the tile just shows it
        lifecycleScope.launch {
            if (existing != null) {
                // Let the runtime write what's typed before the file changes under it.
                existing.flushSave()
                delay(400)
            }
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val store = VaultModel.store.value
                        ?: throw IllegalStateException(VaultModel.error.value ?: "No vault is open")
                    if (shared != null) FloatingNote.append(store, shared) else FloatingNote.resolve(store)
                }
            }
            result.fold(
                onSuccess = { page -> show(page) },
                onFailure = { e -> ui = Ui.Failed(e.message ?: e.toString()) },
            )
        }
    }

    private fun show(page: VaultNode) {
        val store = VaultModel.store.value ?: run {
            ui = Ui.Failed("No vault is open")
            return
        }
        val existing = controller
        if (existing != null && existing.page.path == page.path && existing.store === store) {
            existing.reload()
            return
        }
        session?.detach()
        existing?.destroy()
        val bridge = RpcBridge(store)
        val c = PageController(this, page, store, bridge, PageServer.handlerFor(store))
        val s = EditorSession()
        s.attach(c)
        // A link in the note opens in the app.
        val openInApp: (String) -> Unit = { path ->
            startActivity(
                Intent(this, MainActivity::class.java)
                    .putExtra("openPage", path)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            close()
        }
        bridge.onNavigate = openInApp
        c.onOpenPage = { path -> openInApp(bridge.resolveNavigation(path) ?: path) }
        controller = c
        session = s
        ui = Ui.Ready(c, s)
    }

    private fun sharedText(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND) return null
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
        // The subject is its own paragraph, unless the text already starts with it.
        val full = if (subject.isNotEmpty() && !text.startsWith(subject)) "$subject\n$text" else text
        return full.trim().takeIf { it.isNotEmpty() }
    }
}

private sealed interface Ui {
    data object Loading : Ui
    class Ready(val controller: PageController, val session: EditorSession) : Ui
    class Failed(val message: String) : Ui
}

/** The scrim (a tap outside closes) and the bottom sheet. */
@Composable
private fun QuickNoteScreen(ui: Ui, onClose: () -> Unit) {
    BackHandler(onBack = onClose)
    Box(
        Modifier
            .fillMaxSize()
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClickLabel = "Close",
                onClick = onClose,
            ),
        contentAlignment = Alignment.BottomCenter,
    ) {
        // Surface consumes its own touches, so only the scrim closes.
        Surface(
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth().fillMaxHeight(0.7f),
        ) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
                DragHandle()
                when (ui) {
                    Ui.Loading -> {
                        Header(subtitle = null, onDone = onClose)
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                    is Ui.Failed -> Failed(ui.message, onClose)
                    is Ui.Ready -> key(ui.controller) { NoteEditor(ui.controller, ui.session, onClose) }
                }
            }
        }
    }
}

@Composable
private fun DragHandle() {
    Box(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(width = 32.dp, height = 4.dp)
                .background(MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(2.dp)),
        )
    }
}

@Composable
private fun Header(subtitle: String?, onDone: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 24.dp, end = 16.dp, top = 4.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(FloatingNote.DEFAULT, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
            if (subtitle != null) {
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Button(onClick = onDone) { Text("Done") }
    }
}

/** The page stack as PageScreen wires it, held in edit mode. */
@Composable
private fun ColumnScope.NoteEditor(controller: PageController, session: EditorSession, onDone: () -> Unit) {
    val mode by controller.mode.collectAsState()
    val isLoading by controller.isLoading.collectAsState()
    val loadError by controller.loadError.collectAsState()
    val state by session.state.collectAsState()
    val editing = mode.edit

    LaunchedEffect(editing) { session.modeChanged() }
    LaunchedEffect(isLoading) {
        if (isLoading) return@LaunchedEffect
        controller.evaluate("document.documentElement.classList.add('q-floating')")
        if (!controller.canEdit) return@LaunchedEffect
        if (!controller.mode.value.edit) {
            controller.setEditing(true) // modeChanged() then puts the caret in
        } else {
            delay(300) // a reload (shared text) keeps edit mode: put the caret back
            session.focus()
        }
        // The WebView needs view focus for the IME to come up in a fresh window.
        val web = controller.webView ?: return@LaunchedEffect
        web.requestFocus()
        delay(350)
        ViewCompat.getWindowInsetsController(web)?.show(WindowInsetsCompat.Type.ime())
    }

    val subtitle = when {
        !controller.canEdit -> "Read only"
        editing && state.saving -> "Saving…"
        else -> "Saved as you type"
    }
    Header(subtitle, onDone)
    Box(Modifier.weight(1f).fillMaxWidth()) {
        PageWebView(controller, Modifier.fillMaxSize())
        if (isLoading && loadError == null) {
            LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
        }
        loadError?.let { message ->
            Column(
                Modifier.fillMaxSize().padding(horizontal = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                TextButton(onClick = controller::reload) { Text("Try again") }
            }
        }
    }
    if (editing) EditorToolbar(session)
}

@Composable
private fun Failed(message: String, onClose: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Couldn't open the quick note", style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Button(onClick = onClose) { Text("Close") }
    }
}
