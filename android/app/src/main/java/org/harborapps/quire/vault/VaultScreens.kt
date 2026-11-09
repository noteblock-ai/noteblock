package org.harborapps.quire.vault

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.DesktopMac
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.harborapps.quire.app.Brand
import org.harborapps.quire.design.QuireColors
import org.harborapps.quire.sync.SyncEngine

/** What a vault screen can open; the nav host supplies these. */
class VaultNav(
    val openPage: (String) -> Unit,
    val openFolder: (String) -> Unit,
    val openSettings: () -> Unit,
    val openSyncSettings: () -> Unit,
    val back: () -> Unit,
)

// Home

/** The vault home: search over titles and text, Recent, then the vault tree. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VaultHomeScreen(nav: VaultNav, query: String, onQueryChange: (String) -> Unit) {
    val store by VaultModel.store.collectAsStateWithLifecycle()
    val tree by VaultModel.tree.collectAsStateWithLifecycle()
    val entries by VaultIndex.entries.collectAsStateWithLifecycle()
    val recentPaths by RecentPages.paths.collectAsStateWithLifecycle()
    val name = store?.name ?: Brand.name
    val pages = remember(tree) { tree.walked().filter { it.isPage } }
    val highlight = SpanStyle(color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.SemiBold)

    VaultList(
        folder = "",
        nav = nav,
        topBar = { scroll ->
            Column {
                TopAppBar(
                    title = { VaultTitle(name) },
                    actions = {
                        IconButton(onClick = nav.openSettings) {
                            Icon(Icons.Outlined.Settings, contentDescription = "Settings")
                        }
                    },
                    colors = vaultBarColors(),
                    scrollBehavior = scroll,
                )
                SearchField(query, onQueryChange)
            }
        },
    ) { actions ->
        if (query.isNotBlank()) {
            val hits = VaultIndex.search(query, pages, entries, highlight)
            if (hits.isEmpty()) {
                item(key = "no-results") {
                    EmptyState(Icons.Outlined.SearchOff, "No results for “${query.trim()}”", "Check the spelling or try another word.")
                }
            } else {
                item(key = "h-results") { SectionHeader("Results") }
                items(hits, key = { "r:" + it.page.path }) { hit ->
                    PageRow(
                        page = hit.page,
                        entry = entries[hit.page.path],
                        actions = actions,
                        subtitle = hit.page.parentPath.takeIf { it.isNotEmpty() },
                        snippet = hit.snippet,
                    )
                }
            }
        } else {
            val recents = recentPaths.mapNotNull { p -> pages.firstOrNull { it.path == p } }
            if (recents.isNotEmpty()) {
                item(key = "h-recent") { SectionHeader("Recent") }
                item(key = "recent") {
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier.padding(bottom = 8.dp),
                    ) {
                        items(recents, key = { it.path }) { page ->
                            RecentCard(page, entries[page.path]) { nav.openPage(page.path) }
                        }
                    }
                }
            }
            item(key = "h-pages") { SectionHeader("Pages") }
            treeRows(tree, entries, actions)
        }
    }
}

/** The vault's initial in an accent badge, then its name. */
@Composable
private fun VaultTitle(name: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = "Vault: $name" },
    ) {
        Box(
            Modifier
                .size(32.dp)
                .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(10.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                name.take(1).uppercase(),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onPrimary,
            )
        }
        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SearchField(query: String, onQueryChange: (String) -> Unit) {
    TextField(
        value = query,
        onValueChange = onQueryChange,
        placeholder = { Text("Search pages and text") },
        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
        trailingIcon = {
            if (query.isNotEmpty()) {
                IconButton(onClick = { onQueryChange("") }) {
                    Icon(Icons.Filled.Close, contentDescription = "Clear search")
                }
            }
        },
        singleLine = true,
        shape = CircleShape,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
            unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 12.dp)
            .semantics { contentDescription = "Search pages and text" },
    )
}

@Composable
private fun RecentCard(page: VaultNode, entry: VaultIndex.Entry?, onClick: () -> Unit) {
    OutlinedCard(
        onClick = onClick,
        modifier = Modifier
            .width(168.dp)
            .heightIn(min = 112.dp),
    ) {
        Column(
            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                page.title,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val excerpt = entry?.text?.removePrefix(page.title)?.trim().orEmpty()
            Text(
                excerpt,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                minLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                VaultIndex.recentLine(page, entry?.mtime),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// Folder

/** One subfolder of the vault, same rows as home. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VaultFolderScreen(path: String, nav: VaultNav) {
    val tree by VaultModel.tree.collectAsStateWithLifecycle()
    val entries by VaultIndex.entries.collectAsStateWithLifecycle()
    val node = remember(tree, path) { tree.walked().firstOrNull { it.kind == VaultNode.Kind.FOLDER && it.path == path } }
    VaultList(
        folder = path,
        nav = nav,
        topBar = { scroll ->
            TopAppBar(
                title = { Text(path.substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = nav.back) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = vaultBarColors(),
                scrollBehavior = scroll,
            )
        },
    ) { actions ->
        when {
            node == null -> item(key = "missing") {
                EmptyState(Icons.Outlined.Folder, "No folder: $path", null)
            }
            node.children.none { it.kind != VaultNode.Kind.FILE } -> item(key = "empty") {
                EmptyState(Icons.Outlined.Folder, "No pages here", "Tap New page to make one.")
            }
            else -> treeRows(node.children, entries, actions)
        }
    }
}

// The shared list: top bar, rows, sync footer + New page, delete, pull to refresh

private class RowActions(
    val open: (VaultNode) -> Unit,
    val delete: (VaultNode) -> Unit,
    val copyPath: (VaultNode) -> Unit,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun vaultBarColors() = TopAppBarDefaults.topAppBarColors(
    containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
    scrolledContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VaultList(
    folder: String,
    nav: VaultNav,
    topBar: @Composable (androidx.compose.material3.TopAppBarScrollBehavior) -> Unit,
    content: LazyListScope.(RowActions) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var pendingDelete by remember { mutableStateOf<VaultNode?>(null) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val scroll = TopAppBarDefaults.pinnedScrollBehavior()

    val actions = remember(nav) {
        RowActions(
            open = { n -> if (n.kind == VaultNode.Kind.FOLDER) nav.openFolder(n.path) else nav.openPage(n.path) },
            delete = { n -> pendingDelete = n },
            copyPath = { n ->
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Path", n.path))
            },
        )
    }

    fun createPage() {
        val store = VaultModel.store.value ?: return
        try {
            val page = store.createPage(untitledPath(store, folder))
            VaultModel.refresh()
            PageOpenIntent.requestEdit(page.path)
            nav.openPage(page.path)
        } catch (e: Exception) {
            errorText = e.message ?: e.toString()
        }
    }

    fun delete(node: VaultNode) {
        val store = VaultModel.store.value ?: return
        try {
            store.trash(node.path)
            RecentPages.remove(node.path)
            VaultModel.refresh()
            scope.launch { snackbar.showSnackbar("Moved to trash") }
        } catch (e: Exception) {
            errorText = e.message ?: e.toString()
        }
    }

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        topBar = { topBar(scroll) },
        bottomBar = { VaultFooter(onNew = ::createPage, onOpenSync = nav.openSyncSettings) },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    VaultModel.refresh()
                    SyncEngine.syncNow()
                    delay(300)
                    SyncEngine.status.first { !it.syncing }
                    VaultModel.refresh()
                    refreshing = false
                }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = padding,
            ) {
                content(actions)
            }
        }
    }

    pendingDelete?.let { node ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("Delete ${node.title}?") },
            text = {
                Text(
                    if (node.kind == VaultNode.Kind.FOLDER) "The folder and its pages move to the vault's .trash folder."
                    else "The page moves to the vault's .trash folder.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    delete(node)
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("Cancel") }
            },
        )
    }

    errorText?.let { msg ->
        AlertDialog(
            onDismissRequest = { errorText = null },
            title = { Text("Couldn't do that") },
            text = { Text(msg) },
            confirmButton = { TextButton(onClick = { errorText = null }) { Text("OK") } },
        )
    }
}

/** "Untitled", then "Untitled 2", "Untitled 3"… — the first free name in `folder`. */
private fun untitledPath(store: VaultStore, folder: String): String {
    fun at(name: String) = if (folder.isEmpty()) name else "$folder/$name"
    var name = "Untitled"
    var n = 2
    while (runCatching { store.pathDir(at(name)).exists() }.getOrDefault(false)) {
        name = "Untitled $n"
        n += 1
    }
    return at(name)
}

/** Sync status (tap for Sync settings) and New page, pinned under the list. */
@Composable
private fun VaultFooter(onNew: () -> Unit, onOpenSync: () -> Unit) {
    val status by SyncEngine.status.collectAsStateWithLifecycle()
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Row(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            TextButton(
                onClick = onOpenSync,
                modifier = Modifier
                    .weight(1f)
                    .semantics(mergeDescendants = true) { contentDescription = "Sync: ${status.text}" },
                contentPadding = PaddingValues(horizontal = 8.dp),
            ) {
                Box(
                    Modifier
                        .size(8.dp)
                        .background(
                            if (status.healthy) QuireColors.healthy else MaterialTheme.colorScheme.outline,
                            CircleShape,
                        ),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    status.text,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
            ExtendedFloatingActionButton(
                onClick = onNew,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("New page") },
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            )
        }
    }
}

@Composable
private fun EmptyState(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, message: String?) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 32.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(40.dp))
        Text(title, style = MaterialTheme.typography.titleMedium)
        if (message != null) {
            Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// Rows

/** Folders then pages of one tree level (plain files are left out, as on iOS). */
private fun LazyListScope.treeRows(
    nodes: List<VaultNode>,
    entries: Map<String, VaultIndex.Entry>,
    actions: RowActions,
) {
    items(nodes.filter { it.kind != VaultNode.Kind.FILE }, key = { "n:" + it.path }) { node ->
        if (node.kind == VaultNode.Kind.FOLDER) FolderRow(node, actions) else PageRow(node, entries[node.path], actions)
    }
}

@Composable
private fun FolderRow(folder: VaultNode, actions: RowActions) {
    val count = remember(folder) { folder.children.walked().count { it.isPage } }
    VaultRow(folder, actions) { modifier ->
        ListItem(
            headlineContent = { Text(folder.title, fontWeight = FontWeight.Medium) },
            leadingContent = { Icon(Icons.Outlined.Folder, contentDescription = null) },
            trailingContent = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "$count",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.clearAndSetSemantics { contentDescription = "$count pages" },
                    )
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.outline,
                    )
                }
            },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
            modifier = modifier,
        )
    }
}

@Composable
private fun PageRow(
    page: VaultNode,
    entry: VaultIndex.Entry?,
    actions: RowActions,
    subtitle: String? = null,
    snippet: AnnotatedString? = null,
) {
    val runsOnMac = page.hasBackend || page.isBuilt
    val isApp = page.isBuilt || entry?.hasScript == true
    val icon = when {
        page.hasBackend -> Icons.Outlined.DesktopMac
        page.isMarkdown -> Icons.Outlined.Description
        isApp -> Icons.Outlined.Apps
        else -> Icons.Outlined.Description
    }
    // The tree's own line ("App", "Edited yesterday") when the caller gave none.
    val line = subtitle ?: when {
        runsOnMac -> null
        isApp -> "App"
        entry != null -> "Edited ${VaultIndex.relative(entry.mtime)}"
        else -> null
    }
    VaultRow(page, actions) { modifier ->
        ListItem(
            headlineContent = { Text(page.title, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            supportingContent = if (line == null && snippet == null) null else {
                {
                    Column {
                        if (line != null) Text(line, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (snippet != null) Text(snippet, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            },
            leadingContent = { Icon(icon, contentDescription = null) },
            trailingContent = when {
                page.isLocked -> {
                    {
                        CircularProgressIndicator(
                            strokeWidth = 2.dp,
                            modifier = Modifier
                                .size(20.dp)
                                .semantics { contentDescription = "Being edited on your Mac" },
                        )
                    }
                }
                runsOnMac -> {
                    {
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                        ) {
                            Text(
                                "Runs on your Mac",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                            )
                        }
                    }
                }
                else -> null
            },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
            modifier = modifier,
        )
    }
}

/** Tap opens; long-press opens a menu with Copy path and Delete. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun VaultRow(node: VaultNode, actions: RowActions, row: @Composable (Modifier) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    Box {
        row(
            Modifier.combinedClickable(
                onClick = { actions.open(node) },
                onLongClickLabel = "More actions",
                onLongClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    menu = true
                },
            ),
        )
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text("Copy path") },
                leadingIcon = { Icon(Icons.Outlined.ContentCopy, contentDescription = null) },
                onClick = {
                    menu = false
                    actions.copyPath(node)
                },
            )
            DropdownMenuItem(
                text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                onClick = {
                    menu = false
                    actions.delete(node)
                },
            )
        }
    }
}
