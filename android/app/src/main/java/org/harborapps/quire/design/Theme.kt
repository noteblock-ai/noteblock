package org.harborapps.quire.design

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Ledger, the desktop's look (app/runtime/theme.css), as Material 3 roles. Same tokens as the
 * iOS Theme.swift.
 *
 * theme.css has no dark variant, so pages are always light, and the app stays light with them
 * (iOS pins itself the same way). No dynamic color either: the chrome has to match the page
 * under it. When theme.css grows a dark block, add a dark scheme here. (docs/decisions/android.md)
 *
 * Native chrome uses the system font (Roboto) with the M3 type scale; pages in the web view
 * still get Geist from theme.css.
 */
object QuireColors {
    val background = Color(0xFFFFFFFF)
    val sidebar = Color(0xFFF8F9FB)
    val line = Color(0xFFE4E6EA)
    val ink = Color(0xFF15171C)
    val muted = Color(0xFF5B6270)
    val grey = Color(0xFF9AA0AB)
    val accent = Color(0xFF3451D1)
    /** The Edit button and the insert button: accent at low strength. */
    val accentSoft = Color(0xFFEEF1FD)
    /** Text on accentSoft. */
    val onAccentSoft = Color(0xFF2A43B0)
    /** A pressed formatting button (the caret is in a numbered list…). */
    val pressed = Color(0xFFE8EBF3)
    val error = Color(0xFFC62828)
    val healthy = Color(0xFF2E9E5B)
}

private val LedgerLight = lightColorScheme(
    primary = QuireColors.accent,
    onPrimary = Color.White,
    primaryContainer = QuireColors.accentSoft,
    onPrimaryContainer = QuireColors.onAccentSoft,
    secondary = QuireColors.muted,
    onSecondary = Color.White,
    secondaryContainer = QuireColors.pressed,
    onSecondaryContainer = QuireColors.ink,
    tertiary = QuireColors.accent,
    onTertiary = Color.White,
    background = QuireColors.background,
    onBackground = QuireColors.ink,
    surface = QuireColors.background,
    onSurface = QuireColors.ink,
    surfaceVariant = QuireColors.sidebar,
    onSurfaceVariant = QuireColors.muted,
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = QuireColors.sidebar,
    surfaceContainer = QuireColors.sidebar,
    surfaceContainerHigh = Color(0xFFF1F3F6),
    surfaceContainerHighest = QuireColors.pressed,
    outline = QuireColors.grey,
    outlineVariant = QuireColors.line,
    error = QuireColors.error,
    onError = Color.White,
)

@Composable
fun QuireTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = LedgerLight, content = content)
}
