package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clubladder.app.ui.theme.BarlowCondensed
import com.clubladder.app.ui.theme.LocalPalette

/** Shown instead of the app when the build has no Supabase URL or key. */
@Composable
fun ConfigErrorScreen(missing: List<String>) {
    val p = LocalPalette.current
    Column(
        Modifier.fillMaxSize().background(p.background).safeDrawingPadding().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        BrandTile(size = 56.dp, corner = 12.dp, markSize = 28.dp)
        Text(
            "This build is not configured",
            color = p.text,
            fontFamily = BarlowCondensed,
            fontWeight = FontWeight.Bold,
            fontSize = 26.sp,
            modifier = Modifier.padding(top = 20.dp, bottom = 12.dp),
        )
        Text(
            "Missing or invalid: ${missing.joinToString(", ")}. Copy local.properties.example to " +
                "local.properties, fill in an https URL and the anon key, and rebuild.",
            color = p.muted,
            fontSize = 15.sp,
            lineHeight = 21.sp,
        )
    }
}
