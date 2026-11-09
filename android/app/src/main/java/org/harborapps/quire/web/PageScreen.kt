package org.harborapps.quire.web

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Redo
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.harborapps.quire.bridge.RpcBridge
import org.harborapps.quire.editor.EditorSession
import org.harborapps.quire.editor.EditorToolbar
import org.harborapps.quire.editor.InsertSheet
import org.harborapps.quire.editor.Insertion
import org.harborapps.quire.vault.PageOpenIntent
import org.harborapps.quire.vault.VaultModel
import org.harborapps.quire.vault.VaultNode
import org.harborapps.quire.vault.VaultStore
import java.io.File

/**
 * One page, full screen. Reading mode (AndroidPage.dc.html): back, the title, the page menu and
 * an Edit button; a tap on text also starts editing. Edit mode (AndroidEdit.dc.html): Undo/Redo,
 * the save status and Done, with [EditorToolbar] docked above the keyboard. Port of
 * ios/Quire/Web/PageScreen.swift.
 * @param pagePath vault-relative page path (a path inside a page opens that page)
 * @param onBack pop this screen
 * @param onOpenPage open another page (a link, the navigate rpc), by page path
 */
@Composable
fun PageScreen(pagePath: String, onBack: () -> Unit, onOpenPage: (String) -> Unit) {
    val store by VaultModel.store.collectAsState()
    val s = store
    val page = remember(pagePath, s) { s?.let { resolvePage(it, pagePath) } }
    if (s == null || page == null) {
        NoPage(pagePath, onBack)
        return
    }
    key(page.path) {
        PageContent(page, s, onBack, onOpenPage)
    }
}

/** The page itself, else the page that contains [path] (longest page prefix). */
private fun resolvePage(store: VaultStore, path: String): VaultNode? {
    VaultModel.page(path)?.let { return it }
    val p = runCatching { VaultStore.normPath(path) }.getOrNull() ?: path
    return runCatching { store.allPages() }.getOrNull()
        ?.filter { p.startsWith(it.path + "/") }
        ?.maxByOrNull { it.path.length }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PageContent(page: VaultNode, store: VaultStore, onBack: () -> Unit, onOpenPage: (String) -> Unit) {
    val context = LocalContext.current
    val openPage by rememberUpdatedState(onOpenPage)
    val bridge = remember { RpcBridge(store) }
    val controller = remember {
        PageController(context, page, store, bridge, PageServer.handlerFor(store))
    }
    val editor = remember { EditorSession() }

    val scope = rememberCoroutineScope()
    DisposableEffect(controller) {
        // Leaving destroys this WebView: while editing, let the runtime save what was typed
        // in the last moments (its debounced save) before the screen goes.
        fun go(target: String) {
            if (!controller.mode.value.edit) return openPage(target)
            controller.flushSave()
            scope.launch {
                delay(600)
                openPage(target)
            }
        }
        // The navigate rpc arrives already resolved; a clicked vault link is resolved here.
        bridge.onNavigate = { target -> go(target) }
        controller.onOpenPage = { path -> go(bridge.resolveNavigation(path) ?: path) }
        editor.attach(controller)
        onDispose {
            bridge.onNavigate = null
            editor.detach()
            controller.destroy()
        }
    }

    val mode by controller.mode.collectAsState()
    val isLoading by controller.isLoading.collectAsState()
    val loadError by controller.loadError.collectAsState()
    val editorState by editor.state.collectAsState()
    val editing = mode.edit

    var showSource by remember { mutableStateOf(false) }
    var pendingInsert by remember { mutableStateOf<Insertion?>(null) }

    // A page made with + opens ready to type (PageOpenIntent); `--es editPage` does the same.
    LaunchedEffect(Unit) {
        // `--es editPage` arrives through PageOpenIntent too (AppRoot.applyLaunch), so it applies once.
        val intentEdit = PageOpenIntent.consumeEdit(page.path)
        if (intentEdit && controller.canEdit && !controller.mode.value.edit) {
            controller.setEditing(true)
        }
    }
    LaunchedEffect(editing) { editor.modeChanged() }
    LaunchedEffect(isLoading) {
        if (!isLoading) editor.setTapToEdit(controller.canEdit)
    }
    // The insert sheet's pick runs once the sheet is gone, so the caret is back in the page.
    LaunchedEffect(editor.showInsert, pendingInsert) {
        val insertion = pendingInsert
        if (!editor.showInsert && insertion != null) {
            pendingInsert = null
            delay(100)
            editor.insert(insertion)
            editor.focus()
        }
    }

    fun leaveEdit() {
        editor.hideKeyboard()
        controller.flushSave()
        controller.setEditing(false)
    }

    BackHandler(enabled = editing) { leaveEdit() }

    Scaffold(
        topBar = {
            if (editing) {
                EditBar(
                    canUndo = editorState.canUndo,
                    canRedo = editorState.canRedo,
                    saving = editorState.saving,
                    onUndo = editor::undo,
                    onRedo = editor::redo,
                    onDone = ::leaveEdit,
                )
            } else {
                ReadingBar(
                    title = page.title,
                    canEdit = controller.canEdit,
                    onBack = onBack,
                    onEdit = { controller.setEditing(true) },
                    onShowSource = { showSource = true },
                    onCopyPath = { copyText(context, page.path) },
                )
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { innerPadding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .consumeWindowInsets(innerPadding)
                .imePadding(),
        ) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                PageWebView(controller, Modifier.fillMaxSize())
                if (isLoading && loadError == null) {
                    LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
                }
                loadError?.let { message ->
                    LoadError(message, onRetry = controller::reload)
                }
            }
            if (editing) EditorToolbar(editor)
        }
    }

    if (editor.showInsert) {
        val pages = remember { runCatching { store.allPages() }.getOrDefault(emptyList()) }
        InsertSheet(
            page,
            pages,
            onDismiss = { editor.showInsert = false },
            onInsert = { insertion ->
                pendingInsert = insertion
                editor.showInsert = false
            },
        )
    }

    if (showSource) {
        SourceSheet(page, onDismiss = { showSource = false })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReadingBar(
    title: String,
    canEdit: Boolean,
    onBack: () -> Unit,
    onEdit: () -> Unit,
    onShowSource: () -> Unit,
    onCopyPath: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    TopAppBar(
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
        },
        actions = {
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "Page menu", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("Show source") },
                        leadingIcon = { Icon(Icons.Filled.Code, contentDescription = null) },
                        onClick = { menuOpen = false; onShowSource() },
                    )
                    DropdownMenuItem(
                        text = { Text("Copy path") },
                        leadingIcon = { Icon(Icons.Filled.ContentCopy, contentDescription = null) },
                        onClick = { menuOpen = false; onCopyPath() },
                    )
                }
            }
            if (canEdit) {
                FilledTonalButton(
                    onClick = onEdit,
                    colors = ButtonDefaults.filledTonalButtonColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        contentColor = MaterialTheme.colorScheme.primary,
                    ),
                    modifier = Modifier.padding(end = 8.dp),
                ) { Text("Edit") }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditBar(
    canUndo: Boolean,
    canRedo: Boolean,
    saving: Boolean,
    onUndo: () -> Unit,
    onRedo: () -> Unit,
    onDone: () -> Unit,
) {
    CenterAlignedTopAppBar(
        title = {
            Text(
                if (saving) "Saving…" else "Saved",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        navigationIcon = {
            Row {
                IconButton(onClick = onUndo, enabled = canUndo) {
                    Icon(Icons.AutoMirrored.Filled.Undo, contentDescription = "Undo")
                }
                IconButton(onClick = onRedo, enabled = canRedo) {
                    Icon(Icons.AutoMirrored.Filled.Redo, contentDescription = "Redo")
                }
            }
        },
        actions = {
            Button(onClick = onDone, modifier = Modifier.padding(end = 8.dp)) { Text("Done") }
        },
        colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = MaterialTheme.colorScheme.background),
    )
}

@Composable
private fun LoadError(message: String, onRetry: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Outlined.ErrorOutline,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(48.dp),
        )
        Text("Couldn't open this page", style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Button(onClick = onRetry) { Text("Try again") }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NoPage(path: String, onBack: () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { innerPadding ->
        Box(
            Modifier.fillMaxSize().padding(innerPadding).padding(16.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "No page: $path",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** "Show source": the page's entry file, read only. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SourceSheet(page: VaultNode, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(page.path) {
        text = withContext(Dispatchers.IO) {
            runCatching { File(page.dir, page.entry).readText() }.getOrNull() ?: "Couldn't read ${page.entry}."
        }
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Text(
                page.entry,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            SelectionContainer {
                Text(
                    text ?: "",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurface,
                    softWrap = false,
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .horizontalScroll(rememberScrollState())
                        .padding(16.dp),
                )
            }
        }
    }
}

private fun copyText(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    cm.setPrimaryClip(ClipData.newPlainText("Page path", text))
}
