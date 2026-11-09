package org.harborapps.quire.vault

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The app's open vault: the store plus its tree, refreshed on demand. Port of
 * ios/Quire/Vault/VaultModel.swift, minus the scheme handler (the web layer owns that).
 */
object VaultModel {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _store = MutableStateFlow<VaultStore?>(null)
    private val _tree = MutableStateFlow<List<VaultNode>>(emptyList())
    private val _error = MutableStateFlow<String?>(null)

    val store: StateFlow<VaultStore?> = _store.asStateFlow()
    val tree: StateFlow<List<VaultNode>> = _tree.asStateFlow()
    val error: StateFlow<String?> = _error.asStateFlow()

    init {
        // Sync picked a new vault folder (first clone), or pulled changes into this one.
        scope.launch { VaultEvents.selected.collect { open() } }
        scope.launch { VaultEvents.changed.collect { refresh() } }
    }

    /** Every page, flattened in tree order. */
    val pages: List<VaultNode> get() = _tree.value.walked().filter { it.isPage }

    /** Given every vault-relative path a store writes (createPage, trash). */
    @Volatile var onWrite: ((String) -> Unit)? = null

    /** Open (or seed) the current vault and list it, synchronously. */
    fun open() {
        try {
            val s = VaultStore.openDefault()
            s.onWrite = { path -> onWrite?.invoke(path) }
            _store.value = s
            _error.value = null
            refreshNow()
        } catch (e: Exception) {
            _error.value = e.message ?: e.toString()
        }
    }

    /** Re-list the tree off the main thread. */
    fun refresh() {
        val s = _store.value ?: return
        scope.launch {
            val t = withContext(Dispatchers.IO) { s.listTree() }
            if (_store.value === s) _tree.value = t
        }
    }

    /** Re-list the tree on the calling thread. */
    fun refreshNow() {
        val s = _store.value ?: return
        _tree.value = s.listTree()
    }

    fun page(ref: String): VaultNode? = try {
        _store.value?.findPage(ref)
    } catch (_: Exception) {
        null
    }
}
