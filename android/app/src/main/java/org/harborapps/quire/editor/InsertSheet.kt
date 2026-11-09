package org.harborapps.quire.editor

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.FormatListBulleted
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.FormatListNumbered
import androidx.compose.material.icons.outlined.FormatQuote
import androidx.compose.material.icons.outlined.HorizontalRule
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material.icons.outlined.Widgets
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.harborapps.quire.vault.VaultNode

/** What the insert sheet asks the editor to insert. */
sealed interface Insertion {
    /** "heading", "subheading", "checklist", "ul", "ol", "quote", "code", "rule", "table". */
    data class Block(val kind: String) : Insertion
    /** Embed another page, by path. */
    data class Embed(val path: String) : Insertion
    /** An image saved into the page folder; `src` is relative to the page. */
    data class Image(val src: String) : Insertion
}

/** A tile in the Blocks grid. [icon] null draws the "H" glyph (heading/subheading, per the design). */
private class BlockItem(val id: String, val label: String, val keys: String, val icon: ImageVector?)

private const val PHOTO = "photo"

// iOS's "Build with AI" tile is a disabled "Coming soon" placeholder there; left out here.
private val blocks = listOf(
    BlockItem("heading", "Heading", "heading title h2", null),
    BlockItem("subheading", "Subheading", "subheading subtitle h3", null),
    BlockItem("checklist", "Checklist", "checklist todo task check", Icons.Outlined.Checklist),
    BlockItem("ul", "Bulleted list", "bulleted list bullet unordered ul", Icons.AutoMirrored.Outlined.FormatListBulleted),
    BlockItem("ol", "Numbered list", "numbered list ordered ol", Icons.Outlined.FormatListNumbered),
    BlockItem("quote", "Quote", "quote blockquote callout", Icons.Outlined.FormatQuote),
    BlockItem("code", "Code", "code pre snippet monospace", Icons.Outlined.Code),
    BlockItem("rule", "Divider", "divider rule line separator hr", Icons.Outlined.HorizontalRule),
    BlockItem("table", "Table", "table grid rows columns", Icons.Outlined.TableChart),
    BlockItem(PHOTO, "Photo", "photo image picture camera", Icons.Outlined.Image),
)

private const val COLUMNS = 4

private fun matches(item: BlockItem, query: String): Boolean {
    val hay = (item.label + " " + item.keys).lowercase()
    return PageRanking.words(query).all { it in hay }
}

/**
 * The insert sheet (AndroidInsert.dc.html): one search field over pages to embed and blocks.
 * Port of ios/Quire/Editor/InsertSheet.swift. [onInsert] runs after the sheet has hidden and
 * [onDismiss] has been called, so the caret is back in the page when the insertion lands.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InsertSheet(page: VaultNode, pages: List<VaultNode>, onDismiss: () -> Unit, onInsert: (Insertion) -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var query by rememberSaveable { mutableStateOf("") }
    var photoError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var finishing by remember { mutableStateOf(false) }
    val candidates = remember(pages, page.path) { PageRanking.candidates(pages, excluding = page.path) }
    val ranked = remember(candidates, query) {
        PageRanking.rank(candidates, query, limit = if (query.isEmpty()) 5 else 20)
    }
    val shown = remember(query) { blocks.filter { matches(it, query) } }

    fun finish(insertion: Insertion) {
        if (finishing) return
        finishing = true
        scope.launch { sheetState.hide() }.invokeOnCompletion {
            onDismiss()
            onInsert(insertion)
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        saving = true
        photoError = null
        scope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { PageImages.save(context, uri, page) } }
            saving = false
            result
                .onSuccess { finish(Insertion.Image(it)) }
                .onFailure { photoError = "Couldn't add the photo. ${it.message ?: "That photo couldn't be read."}" }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            item(key = "title") {
                Text(
                    "Insert",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 24.dp).semantics { heading() },
                )
            }
            item(key = "search") {
                TextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("Search pages and blocks") },
                    leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                    trailingIcon = {
                        if (query.isNotEmpty()) {
                            IconButton(onClick = { query = "" }) {
                                Icon(Icons.Outlined.Close, contentDescription = "Clear search")
                            }
                        }
                    },
                    singleLine = true,
                    shape = RoundedCornerShape(28.dp),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                        unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    ),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Search,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 8.dp),
                )
            }
            photoError?.let { message ->
                item(key = "error") {
                    Text(
                        message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
                    )
                }
            }
            if (ranked.isNotEmpty()) {
                item(key = "pages-title") { SectionTitle("Pages") }
                items(ranked, key = { "page:" + it.node.path }) { c ->
                    val top = c === ranked.first() && query.isNotEmpty()
                    PageRow(c, highlighted = top) { finish(Insertion.Embed(c.node.path)) }
                }
            }
            if (shown.isNotEmpty()) {
                item(key = "blocks-title") { SectionTitle("Blocks") }
                items(shown.chunked(COLUMNS), key = { row -> "blocks:" + row.joinToString(",") { it.id } }) { row ->
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    ) {
                        row.forEach { item ->
                            val isPhoto = item.id == PHOTO
                            BlockTile(
                                item,
                                enabled = !(isPhoto && saving),
                                modifier = Modifier.weight(1f),
                            ) {
                                if (isPhoto) {
                                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                } else {
                                    finish(Insertion.Block(item.id))
                                }
                            }
                        }
                        repeat(COLUMNS - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
            if (ranked.isEmpty() && shown.isEmpty()) {
                item(key = "empty") {
                    Text(
                        "Nothing matches “$query”",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 24.dp),
                    )
                }
            }
            item(key = "bottom") { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onPrimaryContainer,
        modifier = Modifier
            .padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 4.dp)
            .semantics { heading() },
    )
}

@Composable
private fun PageRow(c: PageRanking.Candidate, highlighted: Boolean, onClick: () -> Unit) {
    val app = c.node.hasBackend || c.node.isBuilt
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(12.dp),
        color = if (highlighted) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
    ) {
        ListItem(
            headlineContent = { Text(c.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            supportingContent = if (c.folder.isNotEmpty()) {
                { Text(c.folder, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            } else null,
            leadingContent = {
                Icon(
                    if (app) Icons.Outlined.Widgets else Icons.Outlined.Description,
                    contentDescription = null,
                    tint = if (highlighted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
        )
    }
}

@Composable
private fun BlockTile(item: BlockItem, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        contentColor = MaterialTheme.colorScheme.onSurface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = modifier.heightIn(min = 80.dp),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 12.dp),
        ) {
            Box(Modifier.height(24.dp), contentAlignment = Alignment.Center) {
                if (item.icon != null) {
                    Icon(item.icon, contentDescription = null)
                } else {
                    val big = item.id == "heading"
                    Text(
                        "H",
                        style = if (big) MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleSmall,
                        fontWeight = if (big) FontWeight.Bold else FontWeight.SemiBold,
                    )
                }
            }
            Text(
                item.label,
                style = MaterialTheme.typography.labelMedium,
                textAlign = TextAlign.Center,
                maxLines = 2,
            )
        }
    }
}
