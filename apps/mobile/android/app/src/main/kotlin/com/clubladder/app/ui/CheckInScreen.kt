package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clubladder.app.Services
import com.clubladder.app.data.ActionOutcome
import com.clubladder.app.ui.theme.BarlowCondensed
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Type
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// apps/player/src/app/checkin/[token]/checkin-client.tsx: a door QR scanned
// in the app, or opened from the camera app, checks the member in through the
// website's checkInWithToken once they confirm, so a link opened by another
// app never checks anyone in by itself. The call is idempotent on the server; it runs
// until an answer is in hand, so a rotation mid-request asks again rather than
// leaving the screen spinning.

private const val CHECKED_IN = "checked_in"
private const val ALREADY = "already"
private const val ERROR = "error:"

@Composable
fun CheckInScreen(services: Services, token: String, onDone: () -> Unit) {
    val p = LocalPalette.current
    var confirmed by rememberSaveable(token) { mutableStateOf(false) }
    var result by rememberSaveable(token) { mutableStateOf<String?>(null) }

    LaunchedEffect(token, confirmed, result == null) {
        if (!confirmed || result != null) return@LaunchedEffect
        val appApi = services.appApi
        result = if (appApi == null) {
            ERROR + READ_ONLY_NOTICE
        } else {
            when (val outcome = runAction(appApi, "checkInWithToken", JsonArray(listOf(JsonPrimitive(token))))) {
                is ActionOutcome.Ok -> {
                    val already = ((outcome.data as? JsonObject)?.get("alreadyCheckedIn") as? JsonPrimitive)?.booleanOrNull
                    if (already == true) ALREADY else CHECKED_IN
                }
                is ActionOutcome.Refused -> ERROR + outcome.message
                is ActionOutcome.Failed -> ERROR + outcome.message
            }
        }
    }

    Box(Modifier.fillMaxSize().background(p.background).padding(16.dp), contentAlignment = Alignment.TopCenter) {
        Card(Modifier.padding(top = 40.dp), padding = 28.dp) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                val r = result
                when {
                    r == null && !confirmed -> {
                        Heading("Check in to this session?")
                        Text(
                            "This marks you as here at today's session.",
                            color = p.muted,
                            style = Type.pageSub,
                            textAlign = TextAlign.Center,
                        )
                        Box(Modifier.padding(top = 12.dp)) {
                            PrimaryButton("Check in") { confirmed = true }
                        }
                    }
                    r == null -> {
                        CircularProgressIndicator(color = p.muted, modifier = Modifier.size(28.dp))
                        Heading("Checking you in...")
                    }
                    r == CHECKED_IN -> {
                        Heading("You're checked in")
                        Text("Have a good session.", color = p.muted, style = Type.pageSub)
                    }
                    r == ALREADY -> {
                        Heading("Already checked in")
                        Text("No need to scan again.", color = p.muted, style = Type.pageSub)
                    }
                    else -> {
                        Heading("Couldn't check you in")
                        Alert(r.removePrefix(ERROR))
                    }
                }
                Box(Modifier.padding(top = if (confirmed) 12.dp else 0.dp)) {
                    GhostButton(if (confirmed) "Go to sessions" else "Not now", onClick = onDone)
                }
            }
        }
    }
}

@Composable
private fun Heading(text: String) {
    Text(
        text,
        color = LocalPalette.current.text,
        fontFamily = BarlowCondensed,
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        textAlign = TextAlign.Center,
    )
}
