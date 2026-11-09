package org.harborapps.quire.vault

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.outlined.FormatSize
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.harborapps.quire.BuildConfig
import kotlin.math.roundToInt

/** Settings: Sync, Editor, About › Version. Port of ios/Quire/Vault/SettingsView.swift. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit, onOpenSync: () -> Unit, onOpenEditor: () -> Unit) {
    val scroll = TopAppBarDefaults.pinnedScrollBehavior()
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = { SettingsTopBar("Settings", onBack, scroll) },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
            item(key = "sync") {
                ListItem(
                    headlineContent = { Text("Sync") },
                    leadingContent = { Icon(Icons.Outlined.Sync, contentDescription = null) },
                    trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                    modifier = Modifier.clickable(onClick = onOpenSync),
                )
            }
            item(key = "editor") {
                ListItem(
                    headlineContent = { Text("Editor") },
                    leadingContent = { Icon(Icons.Outlined.FormatSize, contentDescription = null) },
                    trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                    modifier = Modifier.clickable(onClick = onOpenEditor),
                )
            }
            item(key = "divider") { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            item(key = "about") { SectionHeader("About") }
            item(key = "version") {
                ListItem(
                    headlineContent = { Text("Version") },
                    trailingContent = {
                        Text(
                            "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                )
            }
        }
    }
}

/** Settings › Editor: page text size, applied to pages as they next open. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditorSettingsScreen(onBack: () -> Unit) {
    var textSize by remember { mutableIntStateOf(EditorPrefs.textSize) }
    fun set(v: Int) {
        val c = v.coerceIn(EditorPrefs.range)
        if (c == textSize) return
        textSize = c
        EditorPrefs.textSize = c
    }
    val range = EditorPrefs.range
    val scroll = TopAppBarDefaults.pinnedScrollBehavior()
    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = { SettingsTopBar("Editor", onBack, scroll) },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
            item(key = "size") {
                ListItem(
                    headlineContent = { Text("Text size") },
                    trailingContent = {
                        Text(
                            "$textSize pt",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                )
            }
            item(key = "slider") {
                Row(
                    Modifier.padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { set(textSize - 1) }, enabled = textSize > range.first) {
                        Icon(Icons.Filled.Remove, contentDescription = "Smaller text")
                    }
                    Slider(
                        value = textSize.toFloat(),
                        onValueChange = { set(it.roundToInt()) },
                        valueRange = range.first.toFloat()..range.last.toFloat(),
                        steps = range.last - range.first - 1,
                        modifier = Modifier
                            .weight(1f)
                            .semantics { contentDescription = "Text size" },
                    )
                    IconButton(onClick = { set(textSize + 1) }, enabled = textSize < range.last) {
                        Icon(Icons.Filled.Add, contentDescription = "Larger text")
                    }
                }
            }
            item(key = "preview") {
                Text(
                    "The quick brown fox jumps over the lazy dog.",
                    // A preview of the page's own text size, so a literal size is the point.
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = textSize.sp),
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }
            item(key = "footer") {
                Text(
                    "Pages pick this up the next time they open.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsTopBar(
    title: String,
    onBack: () -> Unit,
    scroll: androidx.compose.material3.TopAppBarScrollBehavior,
) {
    TopAppBar(
        title = { Text(title) },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
        },
        scrollBehavior = scroll,
    )
}

@Composable
internal fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp),
    )
}
