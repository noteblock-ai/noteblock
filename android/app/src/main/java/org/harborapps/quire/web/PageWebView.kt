package org.harborapps.quire.web

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import org.harborapps.quire.design.QuireColors

/**
 * A page, full screen: hosts the controller's WebView (created on first use, then reused).
 * The WebView is never destroyed here; the owner calls [PageController.destroy] when the screen
 * leaves. It is detached from an old parent before it is added, and re-hosted when the controller
 * replaces it (its renderer died).
 */
@Composable
fun PageWebView(controller: PageController, modifier: Modifier = Modifier) {
    val generation by controller.webViewGeneration.collectAsState()
    AndroidView(
        factory = { ctx ->
            FrameLayout(ctx).apply { setBackgroundColor(QuireColors.background.toArgb()) }
        },
        modifier = modifier,
        update = { container ->
            @Suppress("UNUSED_EXPRESSION") generation
            host(container, controller)
        },
        onRelease = { container -> container.removeAllViews() },
    )
}

private fun host(container: FrameLayout, controller: PageController) {
    val web = controller.webView ?: controller.makeWebView()
    if (web.parent === container && container.childCount == 1) return
    (web.parent as? ViewGroup)?.removeView(web)
    container.removeAllViews()
    container.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
}
