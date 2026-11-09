package org.harborapps.quire.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import org.harborapps.quire.design.QuireTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A recreate (rotation) keeps the options already acted on, so AppRoot doesn't apply them again.
        if (savedInstanceState == null) LaunchOptions.current = LaunchOptions.from(intent)
        enableEdgeToEdge()
        setContent {
            QuireTheme {
                AppRoot()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        LaunchOptions.current = LaunchOptions.from(intent)
    }
}
