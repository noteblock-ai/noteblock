package org.harborapps.quire.app

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import org.harborapps.quire.bridge.VaultChanges
import org.harborapps.quire.host.HostJs
import org.harborapps.quire.sync.SyncEngine
import org.harborapps.quire.vault.VaultModel

/** The process. Holds the app context for the singletons (vault, host JS, sync). */
class QuireApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        // Every file the phone writes goes in the change journal sync pushes.
        VaultModel.onWrite = { VaultChanges.markChanged(it) }
        // Open (and on first launch, seed) the vault before the first frame, so openPage can
        // push its page right away; start the JS sandbox the page server needs.
        VaultModel.open()
        HostJs.warmUp()
        // Auto-sync: on foreground and every 5 min while in the foreground, when set up.
        SyncEngine.start()
    }

    companion object {
        lateinit var instance: QuireApp
            private set

        val context: Context get() = instance.applicationContext

        /** The app's settings (current vault, recents, editor prefs, the change journal). */
        val prefs: SharedPreferences
            get() = instance.getSharedPreferences("quire", Context.MODE_PRIVATE)
    }
}
