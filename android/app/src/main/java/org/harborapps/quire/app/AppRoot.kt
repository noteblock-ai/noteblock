package org.harborapps.quire.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import kotlinx.serialization.Serializable
import org.harborapps.quire.vault.EditorSettingsScreen
import org.harborapps.quire.vault.PageOpenIntent
import org.harborapps.quire.vault.RecentPages
import org.harborapps.quire.vault.SettingsScreen
import org.harborapps.quire.vault.VaultFolderScreen
import org.harborapps.quire.vault.VaultHomeScreen
import org.harborapps.quire.vault.VaultIndex
import org.harborapps.quire.vault.VaultModel
import org.harborapps.quire.vault.VaultNav

// Routes (type-safe Navigation Compose).
@Serializable data object Home
@Serializable data class Folder(val path: String)
@Serializable data class Page(val path: String)
@Serializable data object Settings
@Serializable data object SyncSettings
@Serializable data object EditorSettings

/** The LaunchOptions instance already acted on (survives recomposition and rotation). */
private var consumedLaunch: LaunchOptions? = null

/** The navigation shell: vault home, folders, pages, settings. Port of ContentView.swift. */
@Composable
fun AppRoot() {
    val nav = rememberNavController()
    val error by VaultModel.error.collectAsStateWithLifecycle()
    val tree by VaultModel.tree.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }

    // Keep the search index in step with the tree.
    LaunchedEffect(tree) { VaultIndex.update(VaultModel.pages) }

    // Launch extras: once per launch, and again after MainActivity.onNewIntent (which runs
    // before onResume and replaces LaunchOptions.current).
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        val opts = LaunchOptions.current
        if (opts !== consumedLaunch) {
            consumedLaunch = opts
            applyLaunch(opts, nav) { query = it }
        }
    }

    val vaultNav = remember(nav) {
        VaultNav(
            openPage = { nav.navigate(Page(it)) },
            openFolder = { nav.navigate(Folder(it)) },
            openSettings = { nav.navigate(Settings) { launchSingleTop = true } },
            openSyncSettings = { nav.navigate(SyncSettings) { launchSingleTop = true } },
            back = { nav.popBackStack() },
        )
    }

    NavHost(navController = nav, startDestination = Home) {
        composable<Home> {
            val err = error
            if (err != null) VaultError(err) else VaultHomeScreen(vaultNav, query) { query = it }
        }
        composable<Folder> { entry ->
            VaultFolderScreen(entry.toRoute<Folder>().path, vaultNav)
        }
        composable<Page> { entry ->
            val path = entry.toRoute<Page>().path
            LaunchedEffect(path) {
                if (VaultModel.page(path) != null) RecentPages.record(path)
            }
            org.harborapps.quire.web.PageScreen(
                pagePath = path,
                onBack = { nav.popBackStack() },
                onOpenPage = { nav.navigate(Page(it)) },
            )
        }
        composable<Settings> {
            SettingsScreen(
                onBack = { nav.popBackStack() },
                onOpenSync = { nav.navigate(SyncSettings) { launchSingleTop = true } },
                onOpenEditor = { nav.navigate(EditorSettings) { launchSingleTop = true } },
            )
        }
        composable<SyncSettings> {
            org.harborapps.quire.sync.SyncSettingsScreen(onBack = { nav.popBackStack() })
        }
        composable<EditorSettings> {
            EditorSettingsScreen(onBack = { nav.popBackStack() })
        }
    }
}

/** openSettings, else openPage / editPage; search prefills home. */
private fun applyLaunch(opts: LaunchOptions, nav: NavHostController, setQuery: (String) -> Unit) {
    val acts = opts.openSettings || opts.openPage != null || opts.editPage != null || opts.search != null
    if (!acts) return
    nav.popBackStack(Home, inclusive = false)
    opts.search?.let(setQuery)
    if (opts.openSettings) {
        nav.navigate(Settings)
        return
    }
    val edit = opts.editPage
    val page = (opts.openPage ?: edit)?.let { VaultModel.page(it) } ?: return
    // Edit mode once, for this open (PageScreen consumes it), not every later visit to the page.
    if (edit != null && (opts.openPage == null || VaultModel.page(edit)?.path == page.path)) PageOpenIntent.requestEdit(page.path)
    nav.navigate(Page(page.path))
}

@Composable
private fun VaultError(message: String) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        ) {
            Icon(
                Icons.Outlined.ErrorOutline,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(48.dp),
            )
            Text("Couldn't open the vault", style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Text(
                message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}
