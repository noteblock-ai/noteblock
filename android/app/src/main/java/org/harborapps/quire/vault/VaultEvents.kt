package org.harborapps.quire.vault

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/** App-wide vault notifications (iOS: .quireVaultChanged / .quireVaultSelected). */
object VaultEvents {
    private val _changed = MutableSharedFlow<Unit>(extraBufferCapacity = 16)
    private val _selected = MutableSharedFlow<Unit>(extraBufferCapacity = 4)

    /** Files in the open vault changed outside the vault screens (sync pulled, a page was created). */
    val changed: SharedFlow<Unit> = _changed
    /** A different vault folder became current (after a first sync connect). */
    val selected: SharedFlow<Unit> = _selected

    fun postChanged() { _changed.tryEmit(Unit) }
    fun postSelected() { _selected.tryEmit(Unit) }
}
