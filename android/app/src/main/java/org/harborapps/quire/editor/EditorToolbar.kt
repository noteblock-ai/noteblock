package org.harborapps.quire.editor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.FormatIndentIncrease
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.FormatListNumbered
import androidx.compose.material.icons.filled.KeyboardHide
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * The bar above the keyboard in edit mode (AndroidEdit.dc.html): insert, text style, bold,
 * italic, numbered list, checklist, indent, and hide keyboard. Port of
 * ios/Quire/Editor/EditorKeyboardBar.swift. The page screen docks it under the web view,
 * above the IME.
 */
@Composable
fun EditorToolbar(session: EditorSession, modifier: Modifier = Modifier) {
    val state by session.state.collectAsState()
    val colors = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth().background(colors.surfaceContainer)) {
        HorizontalDivider(color = colors.outlineVariant)
        Row(
            Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            IconButton(
                onClick = { session.showInsert = true },
                shape = RoundedCornerShape(12.dp),
                colors = IconButtonDefaults.iconButtonColors(
                    containerColor = colors.primaryContainer,
                    contentColor = colors.primary,
                ),
            ) {
                Icon(Icons.Filled.Add, contentDescription = "Insert")
            }

            TextStyleButton(state.block, onPick = session::heading)

            ToggleButton("Bold", state.bold, session::bold) {
                Text("B", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            }
            ToggleButton("Italic", state.italic, session::italic) {
                Text("I", style = MaterialTheme.typography.titleMedium, fontStyle = FontStyle.Italic)
            }
            ToggleButton("Numbered list", state.block == "ol", { session.list("ol") }) {
                Icon(Icons.Filled.FormatListNumbered, contentDescription = null)
            }
            ToggleButton("Checklist", state.block == "checklist", session::checklist) {
                Icon(Icons.Filled.Checklist, contentDescription = null)
            }
            IconButton(onClick = session::indent) {
                Icon(Icons.AutoMirrored.Filled.FormatIndentIncrease, contentDescription = "Indent")
            }

            Spacer(Modifier.weight(1f))

            IconButton(onClick = session::hideKeyboard) {
                Icon(
                    Icons.Filled.KeyboardHide,
                    contentDescription = "Hide keyboard",
                    tint = colors.onSurfaceVariant,
                )
            }
        }
    }
}

/** "Aa": Title / Heading / Subheading / Body, with a check on the caret's block. */
@Composable
private fun TextStyleButton(block: String, onPick: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = "Text style" }) {
            Text("Aa", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            listOf(
                Triple("Title", 1, "h1"),
                Triple("Heading", 2, "h2"),
                Triple("Subheading", 3, "h3"),
                Triple("Body", 0, "p"),
            ).forEach { (title, level, tag) ->
                val current = block == tag
                DropdownMenuItem(
                    text = { Text(title) },
                    onClick = {
                        open = false
                        onPick(level)
                    },
                    trailingIcon = if (current) {
                        { Icon(Icons.Filled.Check, contentDescription = "Current") }
                    } else null,
                )
            }
        }
    }
}

/** A formatting button that shows whether the caret already has it (secondaryContainer when on). */
@Composable
private fun ToggleButton(label: String, pressed: Boolean, onClick: () -> Unit, content: @Composable () -> Unit) {
    IconToggleButton(
        checked = pressed,
        onCheckedChange = { onClick() },
        shape = RoundedCornerShape(8.dp),
        colors = IconButtonDefaults.iconToggleButtonColors(
            checkedContainerColor = MaterialTheme.colorScheme.secondaryContainer,
            checkedContentColor = MaterialTheme.colorScheme.onSecondaryContainer,
            contentColor = MaterialTheme.colorScheme.onSurface,
        ),
        modifier = Modifier.semantics {
            contentDescription = label
            stateDescription = if (pressed) "On" else "Off"
        },
    ) {
        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { content() }
    }
}
