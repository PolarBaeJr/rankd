package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clubladder.app.R
import com.clubladder.app.Services
import com.clubladder.app.data.ActionOutcome
import com.clubladder.app.data.AppResult
import com.clubladder.app.data.BuiltArgs
import com.clubladder.app.data.ChallengeContext
import com.clubladder.app.data.NOTE_MAX
import com.clubladder.app.data.NewChallengeForm
import com.clubladder.app.data.Opponent
import com.clubladder.app.data.Viewer
import com.clubladder.app.data.createChallengeArgs
import com.clubladder.app.data.pointsHelper
import com.clubladder.app.data.pointsInvalid
import com.clubladder.app.links.LinkRoute
import com.clubladder.app.links.LinkRouter
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Type
import kotlinx.coroutines.launch

// apps/player/src/app/challenges/new/new-challenge-client.tsx. The form builds
// the same createChallenge input the web form builds and sends it through the
// website. v1 offers "1 game" and "Best of 3" only (a longer match cannot have
// its result submitted), leaves out the Elo preview, and has no date or time
// picker: the website accepts a challenge without one.

const val STALE_OPPONENT = "That player can't be challenged right now."

private enum class Slot(val title: String, val placeholder: String) {
    OPPONENT("Opponent", "Search for an opponent..."),
    PARTNER("Partner", "Search for a partner..."),
    OPPONENT_PARTNER("Their partner", "Search..."),
}

@Composable
fun NewChallengeScreen(services: Services, viewer: Viewer, initialOpponentId: String?, onSent: () -> Unit) {
    val loader = rememberLoader(viewer.id) { loadContext(services.appApi) }
    when (val state = loader.state) {
        LoadState.Loading -> Loading()
        is LoadState.Error -> ErrorState(state.message, loader.reload)
        is LoadState.Ready -> NewChallengeForm(services, viewer, state.data, initialOpponentId, onSent)
    }
}

@Composable
private fun NewChallengeForm(
    services: Services,
    viewer: Viewer,
    context: AppResult<ChallengeContext>?,
    initialOpponentId: String?,
    onSent: () -> Unit,
) {
    val p = LocalPalette.current
    val ctx = (context as? AppResult.Ok)?.value
    val opponents = ctx?.opponents ?: emptyList()
    val appApi = services.appApi
    val scope = rememberCoroutineScope()
    val androidContext = LocalContext.current

    var type by rememberSaveable { mutableStateOf("singles") }
    var games by rememberSaveable { mutableStateOf("3") }
    var points by rememberSaveable { mutableStateOf("21") }
    var rated by rememberSaveable { mutableStateOf(true) }
    var opponentId by rememberSaveable { mutableStateOf(initialOpponentId ?: "") }
    var partnerId by rememberSaveable { mutableStateOf("") }
    var opponentPartnerId by rememberSaveable { mutableStateOf("") }
    var note by rememberSaveable { mutableStateOf("") }
    var picking by remember { mutableStateOf<Slot?>(null) }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var staleChecked by rememberSaveable { mutableStateOf(false) }

    // A prefilled opponent the website will not let this member challenge
    // (out of range, themselves, gone) is cleared, and the form says why.
    // Only once the list is known: with no context there is nothing to judge by.
    LaunchedEffect(ctx) {
        if (ctx != null && !staleChecked) {
            staleChecked = true
            if (opponentId.isNotEmpty() && opponents.none { it.id == opponentId }) {
                opponentId = ""
                error = STALE_OPPONENT
            }
        }
    }

    fun byId(id: String) = opponents.firstOrNull { it.id == id }
    fun elo(o: Opponent) = eloText(if (type == "singles") o.singlesElo else o.doublesElo)
    fun available(current: String) =
        opponents.filter { it.id == current || it.id !in listOf(opponentId, partnerId, opponentPartnerId) }

    val canWrite = appApi != null && ctx != null && ctx.canIssue

    Column(
        Modifier
            .fillMaxSize()
            .background(p.background)
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        PageHeader("New challenge", eyebrow = "Create", padding = androidx.compose.foundation.layout.PaddingValues(top = 20.dp))

        when {
            ctx == null -> Notice((context as? AppResult.Failed)?.message ?: READ_ONLY_NOTICE)
            !ctx.featureOn -> Notice(ctx.featureMessage ?: "The club has switched challenges off for now.")
            !ctx.standing.ok -> Card {
                Text("New challenges paused", color = p.text, style = Type.cardTitle)
                Text(ctx.standing.detail, color = p.muted, style = Type.cardSub, modifier = Modifier.padding(top = 4.dp))
            }
            ctx.quota.full -> Notice(
                "You have ${ctx.quota.used} of ${ctx.quota.max} challenges open. Play or cancel one to issue another.",
            )
        }
        error?.let { Alert(it) }

        Card {
            Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Column {
                    Label("Match type")
                    Row(Modifier.selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (t in listOf("singles", "doubles")) {
                            Choice(t.replaceFirstChar { it.uppercase() }, type == t, p.accent, Modifier.weight(1f)) { type = t }
                        }
                    }
                }

                if (type == "doubles") {
                    Label("Your side")
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .border(1.dp, p.line, RoundedCornerShape(8.dp))
                            .padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(viewer.fullName ?: "You", color = p.ink2, fontSize = 14.sp)
                    }
                    SlotPicker(Slot.PARTNER, partnerId, ::byId, ::elo) { picking = Slot.PARTNER }
                    Label("Opponents")
                    SlotPicker(Slot.OPPONENT, opponentId, ::byId, ::elo) { picking = Slot.OPPONENT }
                    SlotPicker(Slot.OPPONENT_PARTNER, opponentPartnerId, ::byId, ::elo) { picking = Slot.OPPONENT_PARTNER }
                } else {
                    SlotPicker(Slot.OPPONENT, opponentId, ::byId, ::elo) { picking = Slot.OPPONENT }
                }
                GhostButton("Scan their QR", enabled = ctx != null, icon = R.drawable.ic_scan) {
                    scope.launch {
                        when (val outcome = scanQrCode(androidContext)) {
                            ScanOutcome.Cancelled -> Unit
                            ScanOutcome.Unavailable -> error = SCAN_UNAVAILABLE
                            is ScanOutcome.Scanned -> {
                                val route = LinkRouter.parse(outcome.text, services.siteUrl)
                                val scannedId = (route as? LinkRoute.NewChallenge)?.opponentId
                                error = when {
                                    route == LinkRoute.NotOurs -> SCAN_NOT_OURS
                                    scannedId == null -> "This is not a member's challenge QR."
                                    opponents.none { it.id == scannedId } -> STALE_OPPONENT
                                    else -> {
                                        if (partnerId == scannedId) partnerId = ""
                                        if (opponentPartnerId == scannedId) opponentPartnerId = ""
                                        opponentId = scannedId
                                        null
                                    }
                                }
                            }
                        }
                    }
                }

                Column {
                    Label("Best of (games)")
                    Row(Modifier.selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Choice("1 game", games == "1", p.accent, Modifier.weight(1f)) { games = "1" }
                        Choice("Best of 3", games == "3", p.accent, Modifier.weight(1f)) { games = "3" }
                    }
                }
                OutlinedTextField(
                    value = points,
                    onValueChange = { points = it.filter { ch -> ch in '0'..'9' }.take(2) },
                    label = { Text("Points per game") },
                    placeholder = { Text("21") },
                    singleLine = true,
                    isError = pointsInvalid(points),
                    supportingText = { Text(pointsHelper(points)) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )

                Column {
                    Label("Rating impact")
                    Choice(
                        if (rated) "Rated match" else "Casual (no Elo change)",
                        rated,
                        p.gold,
                        Modifier.fillMaxWidth(),
                    ) { rated = !rated }
                }

                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it.take(NOTE_MAX) },
                    label = { Text("Note (optional)") },
                    placeholder = { Text("Any message for your opponent...") },
                    supportingText = { Text("${note.length} / $NOTE_MAX") },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )

                PrimaryButton(
                    if (sending) "Sending..." else "Send challenge",
                    enabled = canWrite && !sending && !pointsInvalid(points),
                ) {
                    val built = createChallengeArgs(
                        NewChallengeForm(
                            type = type,
                            rated = rated,
                            games = games,
                            points = points,
                            opponentId = opponentId,
                            partnerId = partnerId,
                            opponentPartnerId = opponentPartnerId,
                            note = note,
                        ),
                    )
                    when (built) {
                        is BuiltArgs.Invalid -> error = built.message
                        is BuiltArgs.Args -> if (appApi != null) {
                            sending = true
                            error = null
                            scope.launch {
                                when (val outcome = runAction(appApi, built.name, built.args)) {
                                    is ActionOutcome.Ok -> onSent()
                                    is ActionOutcome.Refused -> {
                                        error = outcome.message
                                        sending = false
                                    }
                                    is ActionOutcome.Failed -> {
                                        error = outcome.message
                                        sending = false
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    picking?.let { slot ->
        val current = when (slot) {
            Slot.OPPONENT -> opponentId
            Slot.PARTNER -> partnerId
            Slot.OPPONENT_PARTNER -> opponentPartnerId
        }
        PlayerPickerDialog(
            title = slot.title,
            players = available(current),
            trailing = ::elo,
            allowClear = current.isNotEmpty(),
            onPick = { picked ->
                val id = picked?.id ?: ""
                when (slot) {
                    Slot.OPPONENT -> opponentId = id
                    Slot.PARTNER -> partnerId = id
                    Slot.OPPONENT_PARTNER -> opponentPartnerId = id
                }
                picking = null
            },
            onDismiss = { picking = null },
        )
    }
}

@Composable
private fun SlotPicker(
    slot: Slot,
    id: String,
    byId: (String) -> Opponent?,
    elo: (Opponent) -> String?,
    onClick: () -> Unit,
) {
    val selected = byId(id)
    PlayerSlot(slot.title, selected, selected?.let(elo), slot.placeholder, onClick)
}

/** The web's toggle buttons: tinted in [tint] when on, quiet when off. */
@Composable
private fun Choice(text: String, selected: Boolean, tint: Color, modifier: Modifier, onClick: () -> Unit) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier
            .heightIn(min = 48.dp)
            .background(if (selected) tint.copy(alpha = 0.12f) else p.surface2, shape)
            .border(1.dp, if (selected) tint.copy(alpha = 0.35f) else p.line, shape)
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            color = if (selected) tint else p.muted,
            fontWeight = FontWeight.Bold,
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
        )
    }
}
