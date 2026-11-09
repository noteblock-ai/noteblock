package org.harborapps.quire.app

import android.content.Intent

/**
 * Intent extras for screenshots and checks from the shell, like the iOS launch arguments:
 *   adb shell am start -n org.harborapps.quire.mobile/org.harborapps.quire.app.MainActivity \
 *       --es openPage "Welcome" [--es editPage "Welcome"] [--ez openSettings true] [--es search kyoto]
 */
data class LaunchOptions(
    /** A page path or id to open at launch. */
    val openPage: String? = null,
    /** A page path or id to open in edit mode. */
    val editPage: String? = null,
    /** Open Settings at launch. */
    val openSettings: Boolean = false,
    /** Prefill the home screen's search. */
    val search: String? = null,
    /** DEBUG: a JavaScript expression evaluated in the opened page 1.5 s after it loads. */
    val debugEval: String? = null,
) {
    companion object {
        fun from(intent: Intent?): LaunchOptions {
            if (intent == null) return LaunchOptions()
            fun s(k: String) = intent.getStringExtra(k)?.takeIf { it.isNotEmpty() }
            return LaunchOptions(
                openPage = s("openPage"),
                editPage = s("editPage"),
                openSettings = intent.getBooleanExtra("openSettings", false),
                search = s("search"),
                debugEval = s("debugEval"),
            )
        }

        /** The options the app was launched with (MainActivity sets it). */
        @Volatile var current: LaunchOptions = LaunchOptions()
    }
}
