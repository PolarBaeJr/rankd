package com.clubladder.app

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.clubladder.app.ui.AppRoot
import com.clubladder.app.ui.theme.AppTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Dark only, like the website: light bar icons over the app's own black.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        val container = (application as BadmintonApp).container
        // Only a fresh start: after a recreation the link was already taken.
        if (savedInstanceState == null) takeLink(intent)
        setContent {
            AppTheme {
                AppRoot(container)
            }
        }
    }

    // singleTop: a link tapped while the app is open arrives here.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeLink(intent)
    }

    /** An https link Android handed over (App Links), queued for the signed-in screens to route. */
    private fun takeLink(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val data = intent.data ?: return
        if (!data.scheme.equals("https", ignoreCase = true)) return
        (application as BadmintonApp).container.pendingLink.value = data.toString()
    }
}
