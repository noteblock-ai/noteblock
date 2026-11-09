package org.harborapps.quire.sync

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.outlined.DesktopMac
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.harborapps.quire.app.Brand
import org.harborapps.quire.design.QuireColors
import org.harborapps.quire.vault.VaultStore

/** Settings › Sync (designs/canvas/project/AndroidSync.dc.html). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SyncSettingsScreen(onBack: () -> Unit) {
    val config by SyncEngine.config.collectAsStateWithLifecycle()
    val scroll = TopAppBarDefaults.pinnedScrollBehavior()
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text("Sync") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                scrollBehavior = scroll,
            )
        },
    ) { inner ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(inner)
                .imePadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                Modifier
                    .widthIn(max = 600.dp)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                val c = config
                if (c != null) ConnectedContent(c) else ConnectForm()
                Spacer(Modifier.heightIn(min = 16.dp))
            }
        }
    }
}

// Connected

@Composable
private fun ConnectedContent(c: SyncConfig) {
    val status by SyncEngine.status.collectAsStateWithLifecycle()
    val phase by SyncEngine.phase.collectAsStateWithLifecycle()
    val lastError by SyncEngine.lastError.collectAsStateWithLifecycle()
    val conflicts by SyncEngine.conflicts.collectAsStateWithLifecycle()

    var pageCount by remember { mutableStateOf<Int?>(null) }
    var backendCount by remember { mutableIntStateOf(0) }
    var showError by remember { mutableStateOf(false) }
    var confirmDisconnect by remember { mutableStateOf(false) }
    var comparing by remember { mutableStateOf<SyncConflict?>(null) }

    LaunchedEffect(c.folder, c.lastSyncAt) {
        val root = SyncEngine.vaultRoot ?: return@LaunchedEffect
        val (pages, backends) = withContext(Dispatchers.IO) {
            val all = try { VaultStore(root).allPages() } catch (_: Exception) { emptyList() }
            all.size to all.count { it.hasBackend }
        }
        pageCount = pages
        backendCount = backends
    }

    val failed = lastError != null && status.text != "Offline" && !status.syncing
    val dot = when {
        status.healthy -> QuireColors.healthy
        failed -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.outline
    }
    val line = if (status.syncing) (phase ?: status.text) else status.text
    val pagesText = pageCount?.let { " · $it ${if (it == 1) "page" else "pages"}" } ?: ""

    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                SelectionContainer {
                    Text(c.fullName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                }
                Text(
                    "${c.branch} · GitHub",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clip(MaterialTheme.shapes.small)
                    .clickable(enabled = lastError != null, role = Role.Button, onClickLabel = "Show details") {
                        showError = true
                    },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(dot),
                )
                Text(
                    line + pagesText,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                )
            }
            if (status.syncing) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            Button(
                onClick = { SyncEngine.syncNow() },
                enabled = !status.syncing,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
            ) { Text("Sync now") }
            Text(
                "Checks for changes when you open the app and every 5 min.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (conflicts.isNotEmpty() || backendCount > 0) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "Needs a look",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(top = 8.dp),
            )
            conflicts.forEach { conflict ->
                ConflictCard(
                    conflict = conflict,
                    onCompare = { comparing = conflict },
                    onKeepBoth = { SyncEngine.dismissConflict(conflict) },
                )
            }
            if (backendCount > 0) {
                ListItem(
                    headlineContent = {
                        Text("$backendCount ${if (backendCount == 1) "page runs" else "pages run"} on your Mac")
                    },
                    supportingContent = { Text("They have a backend. Read-only here.") },
                    leadingContent = {
                        Icon(
                            Icons.Outlined.DesktopMac,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                )
            }
        }
    }

    TextButton(
        onClick = { confirmDisconnect = true },
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
        modifier = Modifier.heightIn(min = 48.dp),
    ) { Text("Disconnect") }

    if (showError) {
        AlertDialog(
            onDismissRequest = { showError = false },
            title = { Text(if (status.text == "Offline") "Offline" else "Sync failed") },
            text = { Text(lastError ?: "") },
            confirmButton = {
                TextButton(onClick = {
                    showError = false
                    SyncEngine.syncNow()
                }) { Text("Try again") }
            },
            dismissButton = {
                TextButton(onClick = { showError = false }) { Text("OK") }
            },
        )
    }

    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            title = { Text("Disconnect from GitHub?") },
            text = { Text("The vault stays on this phone. It stops syncing until you connect again.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDisconnect = false
                        SyncEngine.disconnect()
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) { Text("Disconnect") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDisconnect = false }) { Text("Cancel") }
            },
        )
    }

    comparing?.let { conflict ->
        ConflictCompareDialog(
            conflict = conflict,
            onDismiss = { comparing = null },
            onKeepBoth = {
                comparing = null
                SyncEngine.dismissConflict(conflict)
            },
        )
    }
}

@Composable
private fun ConflictCard(conflict: SyncConflict, onCompare: () -> Unit, onKeepBoth: () -> Unit) {
    Card(
        onClick = onCompare,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "${conflictTitle(conflict.path)} was changed on both devices",
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                "This phone's version is kept as “${fileName(conflict.copy)}”.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onCompare, modifier = Modifier.heightIn(min = 48.dp)) { Text("Compare") }
                TextButton(onClick = onKeepBoth, modifier = Modifier.heightIn(min = 48.dp)) { Text("Keep both") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConflictCompareDialog(conflict: SyncConflict, onDismiss: () -> Unit, onKeepBoth: () -> Unit) {
    var texts by remember(conflict.id) { mutableStateOf<Pair<String, String>?>(null) }
    var side by rememberSaveable(conflict.id) { mutableIntStateOf(0) }
    LaunchedEffect(conflict.id) {
        texts = withContext(Dispatchers.IO) { SyncEngine.texts(conflict) }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .padding(vertical = 24.dp, horizontal = 16.dp),
            shape = MaterialTheme.shapes.extraLarge,
            color = MaterialTheme.colorScheme.surface,
        ) {
            Column(Modifier.fillMaxSize()) {
                TopAppBar(
                    title = { Text(conflictTitle(conflict.path)) },
                    navigationIcon = {
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Close")
                        }
                    },
                )
                SingleChoiceSegmentedButtonRow(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp),
                ) {
                    listOf("Other device", "This phone").forEachIndexed { i, label ->
                        SegmentedButton(
                            selected = side == i,
                            onClick = { side = i },
                            shape = SegmentedButtonDefaults.itemShape(index = i, count = 2),
                        ) { Text(label) }
                    }
                }
                Spacer(Modifier.size(12.dp))
                HorizontalDivider()
                Box(
                    Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                ) {
                    val t = texts
                    if (t == null) {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                    } else {
                        SelectionContainer {
                            Text(
                                if (side == 0) t.first else t.second,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                modifier = Modifier
                                    .fillMaxSize()
                                    .verticalScroll(rememberScrollState())
                                    .padding(16.dp),
                            )
                        }
                    }
                }
                HorizontalDivider()
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                ) {
                    TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Done") }
                    Button(onClick = onKeepBoth, modifier = Modifier.heightIn(min = 48.dp)) { Text("Keep both") }
                }
            }
        }
    }
}

private fun fileName(path: String): String = path.split("/").lastOrNull { it.isNotEmpty() } ?: path

/** "Journal/Oct 22/index.md" → "Oct 22"; "notes/todo.md" → "todo.md". */
private fun conflictTitle(path: String): String {
    val comps = path.split("/").filter { it.isNotEmpty() }
    val last = comps.lastOrNull() ?: return path
    if (last.startsWith("index.") && comps.size > 1) return comps[comps.size - 2]
    return last
}

// Not connected

@Composable
private fun ConnectForm() {
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val scope = rememberCoroutineScope()
    val status by SyncEngine.status.collectAsStateWithLifecycle()
    val phase by SyncEngine.phase.collectAsStateWithLifecycle()

    var repo by rememberSaveable { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var showToken by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val connecting = status.syncing

    val tokenUrl = remember {
        "https://github.com/settings/tokens/new?scopes=repo&description=" +
            URLEncoder.encode("${Brand.name} for Android", "UTF-8").replace("+", "%20")
    }

    fun connect() {
        if (connecting || repo.isBlank() || token.isBlank()) return
        focus.clearFocus()
        error = null
        scope.launch {
            try {
                SyncEngine.connect(repo, token)
                token = ""
            } catch (e: Exception) {
                error = e.message?.takeIf { it.isNotBlank() } ?: "Couldn't connect."
            }
        }
    }

    Text(
        "Connect a repo",
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(top = 8.dp),
    )

    OutlinedTextField(
        value = repo,
        onValueChange = { repo = it; error = null },
        label = { Text("Repo") },
        placeholder = { Text("owner/repo") },
        supportingText = { Text("owner/repo or a GitHub URL. A private repo is best.") },
        singleLine = true,
        enabled = !connecting,
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
        modifier = Modifier.fillMaxWidth(),
    )

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        OutlinedTextField(
            value = token,
            onValueChange = { token = it; error = null },
            label = { Text("GitHub token") },
            singleLine = true,
            enabled = !connecting,
            isError = error != null,
            visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                IconButton(onClick = { showToken = !showToken }) {
                    Icon(
                        if (showToken) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                        contentDescription = if (showToken) "Hide token" else "Show token",
                    )
                }
            },
            supportingText = {
                Text(
                    error ?: "A classic token with the repo scope. It's stored encrypted on this phone.",
                    color = if (error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { connect() }),
            modifier = Modifier.fillMaxWidth(),
        )
        TextButton(
            onClick = {
                try {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(tokenUrl)))
                } catch (_: ActivityNotFoundException) {
                    error = "No browser to open github.com."
                }
            },
            contentPadding = PaddingValues(horizontal = 12.dp),
            modifier = Modifier.heightIn(min = 48.dp),
        ) {
            Text("Create a token")
            Spacer(Modifier.size(8.dp))
            Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, modifier = Modifier.size(18.dp))
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
            onClick = { connect() },
            enabled = !connecting && repo.isNotBlank() && token.isNotBlank(),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
        ) { Text(if (connecting) "Connecting…" else "Connect") }
        if (connecting) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            Text(
                phase ?: "Connecting…",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
