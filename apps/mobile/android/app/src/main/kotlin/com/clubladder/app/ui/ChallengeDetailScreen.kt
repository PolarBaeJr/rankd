package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.clubladder.app.Services
import com.clubladder.app.data.ActionOutcome
import com.clubladder.app.data.AppResult
import com.clubladder.app.data.BuiltArgs
import com.clubladder.app.data.CHALLENGE_STATUS_TONE
import com.clubladder.app.data.ChallengeContext
import com.clubladder.app.data.ChallengeParticipant
import com.clubladder.app.data.ChallengeWithMatch
import com.clubladder.app.data.DISPUTE_CATEGORIES
import com.clubladder.app.data.DISPUTE_MIN
import com.clubladder.app.data.PARTICIPANT_CONFIRM_TONE
import com.clubladder.app.data.TagTone
import com.clubladder.app.data.Viewer
import com.clubladder.app.data.disputeArgs
import com.clubladder.app.data.formatRelativeTime
import com.clubladder.app.data.idArgs
import com.clubladder.app.data.loadChallenge
import com.clubladder.app.data.shapeLabel
import com.clubladder.app.data.submitResultArgs
import com.clubladder.app.data.walkoverArgs
import com.clubladder.app.shared.GameScore
import com.clubladder.app.shared.tallyGames
import com.clubladder.app.ui.theme.BarlowCondensed
import com.clubladder.app.ui.theme.JetBrainsMono
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Type
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

// apps/player/src/app/challenges/[id]/page.tsx and its actions.tsx. Which
// buttons show, and when, follows actions.tsx line for line; every button runs
// the website's own action through AppApi. A button stays busy from the tap
// until the reload lands, so a second tap never reaches a challenge that has
// already moved on.

private class DetailData(val found: ChallengeWithMatch?, val context: AppResult<ChallengeContext>?)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChallengeDetailScreen(services: Services, viewer: Viewer, challengeId: String, onChanged: () -> Unit) {
    val p = LocalPalette.current
    val loader = rememberLoader(challengeId) {
        coroutineScope {
            val found = async { loadChallenge(services.postgrest, challengeId, viewer.id) }
            val context = async { loadContext(services.appApi) }
            DetailData(found.await(), context.await())
        }
    }
    // No realtime here: the screen reads again whenever it comes back to the
    // front. The first resume is the first load, so it is skipped.
    var resumed by remember(challengeId) { mutableStateOf(false) }
    LifecycleResumeEffect(challengeId) {
        if (resumed) loader.reload() else resumed = true
        onPauseOrDispose { }
    }

    when (val state = loader.state) {
        LoadState.Loading -> Loading()
        is LoadState.Error -> ErrorState(state.message, loader.reload)
        is LoadState.Ready -> {
            val found = state.data.found
            if (found == null) {
                ErrorState("This challenge is not one of yours, or it no longer exists.")
                return
            }
            PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
                LazyColumn(
                    Modifier.fillMaxSize().background(p.background),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    item { ChallengeBody(found) }
                    item {
                        DetailActions(services, viewer, found, state.data.context, loader.refreshing) {
                            loader.reload()
                            onChanged()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChallengeBody(found: ChallengeWithMatch) {
    val p = LocalPalette.current
    val c = found.challenge
    Card(padding = 0.dp) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, top = 20.dp, end = 20.dp, bottom = 16.dp)) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 4.dp)) {
                    Box(Modifier.width(24.dp).height(2.dp).background(p.accent))
                    Spacer(Modifier.width(8.dp))
                    Text("CHALLENGE", color = p.accent, style = Type.pageEyebrow)
                }
                Text(
                    if (c.type == "singles") "Singles match" else "Doubles match",
                    color = p.text,
                    fontFamily = BarlowCondensed,
                    fontWeight = FontWeight.Bold,
                    fontSize = 28.sp,
                )
            }
            ToneTag(c.status.replace('_', ' '), CHALLENGE_STATUS_TONE[c.status] ?: TagTone.PLAIN)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            val info = listOf(
                "TYPE" to c.type.replaceFirstChar { it.uppercase() },
                "FORMAT" to shapeLabel(c.format, c.gamesPerMatch, c.pointsPerGame),
                "RATED" to if (c.ratedFlag) "Rated" else "Casual",
                "CREATED" to formatRelativeTime(c.createdAt),
            )
            for (pair in info.chunked(2)) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for ((label, value) in pair) InfoBox(label, value, Modifier.weight(1f))
                }
            }
            c.note?.takeIf { it.isNotBlank() }?.let { note ->
                Text(
                    note,
                    color = p.ink2,
                    fontSize = 13.sp,
                    lineHeight = 21.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(p.surface2, RoundedCornerShape(10.dp))
                        .border(1.dp, p.line, RoundedCornerShape(10.dp))
                        .padding(14.dp),
                )
            }
            TeamBox("TEAM A", c.participants.filter { it.teamSide == "a" })
            TeamBox("TEAM B", c.participants.filter { it.teamSide == "b" })
            found.match?.let { MatchResultBox(it) }
        }
    }
}

@Composable
private fun InfoBox(label: String, value: String, modifier: Modifier) {
    val p = LocalPalette.current
    Column(
        modifier
            .border(1.dp, p.line, RoundedCornerShape(10.dp))
            .padding(14.dp),
    ) {
        Text(label, color = p.muted, style = Type.statLabel, modifier = Modifier.padding(bottom = 6.dp))
        Text(value, color = p.text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun TeamBox(label: String, players: List<ChallengeParticipant>) {
    val p = LocalPalette.current
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, p.line, RoundedCornerShape(10.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(label, color = p.muted, style = Type.statLabel, modifier = Modifier.padding(bottom = 2.dp))
        if (players.isEmpty()) {
            Text("No players yet.", color = p.muted, fontSize = 12.sp)
        }
        for (cp in players) {
            val person = cp.person
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(person?.fullName ?: "?", person?.id ?: cp.id, AvatarSize.SM)
                Spacer(Modifier.width(10.dp))
                Text(
                    person?.fullName ?: "Unknown",
                    color = p.text,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                val status = cp.confirmationStatus ?: ""
                ToneTag(status, PARTICIPANT_CONFIRM_TONE[status] ?: TagTone.PLAIN)
            }
        }
    }
}

/** A delta as JavaScript prints a number: "+12", "-3.5", never "12.0". */
private fun signed(delta: Double): String {
    val text = if (delta == Math.floor(delta) && !delta.isInfinite()) delta.toLong().toString() else delta.toString()
    return if (delta >= 0) "+$text" else text
}

@Composable
private fun MatchResultBox(match: com.clubladder.app.data.ChallengeMatch) {
    val p = LocalPalette.current
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, p.line, RoundedCornerShape(12.dp))
            .padding(18.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 12.dp)) {
            Text("MATCH RESULT", color = p.muted, style = Type.statLabel, modifier = Modifier.weight(1f))
            val status = match.resultStatus ?: ""
            ToneTag(
                status,
                when (status) {
                    "confirmed" -> TagTone.WIN
                    "disputed" -> TagTone.RED
                    else -> TagTone.GOLD
                },
            )
        }
        Text(
            match.scoreSummary?.takeIf { it.isNotEmpty() } ?: "Pending",
            color = p.text,
            fontFamily = BarlowCondensed,
            fontWeight = FontWeight.Bold,
            fontSize = 32.sp,
        )
        if (match.games.isNotEmpty()) {
            FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (g in match.games.sortedBy { it.gameNumber }) {
                    Text(
                        "G${g.gameNumber} ${g.sideAScore}-${g.sideBScore}",
                        color = p.muted,
                        fontFamily = JetBrainsMono,
                        fontSize = 12.sp,
                    )
                }
            }
        }
        if (match.participants.isNotEmpty()) {
            Box(Modifier.padding(top = 14.dp).fillMaxWidth().height(1.dp).background(p.line))
            Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (mp in match.participants) {
                    val delta = mp.ratingDelta
                    Row {
                        Text(mp.person?.fullName ?: "Unknown", color = p.text, fontSize = 13.sp, modifier = Modifier.weight(1f))
                        Text(
                            delta?.let { signed(it) } ?: "pending",
                            color = when {
                                delta == null -> p.muted
                                delta >= 0 -> p.win
                                else -> p.danger
                            },
                            fontFamily = JetBrainsMono,
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 13.sp,
                        )
                    }
                }
            }
        }
    }
}

private enum class Dialog { NONE, CANCEL, SUBMIT, DISPUTE, WALKOVER }

@Composable
private fun DetailActions(
    services: Services,
    viewer: Viewer,
    found: ChallengeWithMatch,
    context: AppResult<ChallengeContext>?,
    refreshing: Boolean,
    onDone: () -> Unit,
) {
    val p = LocalPalette.current
    val c = found.challenge
    val match = found.match
    val appApi = services.appApi
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var flash by remember { mutableStateOf<String?>(null) }
    var dialog by remember { mutableStateOf(Dialog.NONE) }

    // The busy button clears only once the reload after a write has landed.
    LaunchedEffect(refreshing) { if (!refreshing) busy = "" }

    val reviewing = match?.resultStatus == "disputed" || c.status == "walkover_pending"
    val reviewTitle = if (match?.resultStatus == "disputed") "Result disputed" else "Walkover reported"

    val ctx = (context as? AppResult.Ok)?.value
    if (appApi == null || ctx == null) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (reviewing) {
                InfoCard(reviewTitle, "An exec is reviewing this and will settle it. Ratings stay unchanged until they do.")
            }
            Notice((context as? AppResult.Failed)?.message ?: READ_ONLY_NOTICE)
        }
        return
    }
    if (!ctx.standing.ok) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (reviewing) {
                InfoCard(reviewTitle, "An exec is reviewing this and will settle it. Ratings stay unchanged until they do.")
            }
            InfoCard("Actions paused", ctx.standing.detail)
        }
        return
    }

    val isCreator = c.createdBy == viewer.id
    val myStatus = c.participants.firstOrNull { it.playerId == viewer.id }?.confirmationStatus
    val isSubmitter = match?.submittedBy == viewer.id
    val open = c.status in setOf("proposed", "partially_confirmed")

    fun run(key: String, built: BuiltArgs, success: String, after: () -> Unit = {}) {
        when (built) {
            is BuiltArgs.Invalid -> error = built.message
            is BuiltArgs.Args -> {
                busy = key
                error = null
                flash = null
                scope.launch {
                    when (val outcome = runAction(appApi, built.name, built.args)) {
                        is ActionOutcome.Ok -> {
                            flash = success
                            after()
                            onDone()
                        }
                        is ActionOutcome.Refused -> {
                            error = outcome.message
                            busy = ""
                        }
                        is ActionOutcome.Failed -> {
                            error = outcome.message
                            busy = ""
                        }
                    }
                }
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        flash?.let { Pill(it, p.winWash, p.win) }
        if (dialog == Dialog.NONE) error?.let { Alert(it) }

        if (isCreator && open) {
            GhostButton(if (busy == "cancel") "Cancelling..." else "Cancel challenge", enabled = busy.isEmpty()) {
                dialog = Dialog.CANCEL
            }
        }
        if (myStatus == "pending" && open) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ToneButton("Accept", p.win, Color.Black, busy.isEmpty(), busy == "accept", Modifier.weight(1f)) {
                    run("accept", idArgs("acceptChallenge", c.id), "Challenge accepted!")
                }
                ToneButton("Reject", p.danger, Color.White, busy.isEmpty(), busy == "reject", Modifier.weight(1f)) {
                    run("reject", idArgs("rejectChallenge", c.id), "Challenge rejected")
                }
            }
        }
        if (c.status == "accepted" && match == null) {
            PrimaryButton("Submit result", enabled = busy.isEmpty()) { error = null; dialog = Dialog.SUBMIT }
            GhostButton("Report issue", enabled = busy.isEmpty()) { error = null; dialog = Dialog.WALKOVER }
        }
        if (match?.resultStatus == "pending_confirmation") {
            if (!isSubmitter) {
                ToneButton("Confirm result", p.win, Color.Black, busy.isEmpty(), busy == "confirm", Modifier.fillMaxWidth()) {
                    run("confirm", idArgs("confirmMatchResult", match.id), "Result confirmed! Elo updated.")
                }
            }
            ToneButton(
                if (isSubmitter) "Report an error" else "Dispute",
                p.danger,
                Color.White,
                busy.isEmpty(),
                false,
                Modifier.fillMaxWidth(),
            ) { error = null; dialog = Dialog.DISPUTE }
        }
        if (reviewing) {
            InfoCard(
                reviewTitle,
                "An exec is reviewing this and will settle it. Ratings stay unchanged until they do. " +
                    "There is nothing else to do here.",
            )
        }
    }

    when (dialog) {
        Dialog.NONE -> Unit
        Dialog.CANCEL -> AlertDialog(
            onDismissRequest = { dialog = Dialog.NONE },
            containerColor = p.surface,
            title = { Text("Cancel challenge?", color = p.text, style = Type.cardTitle) },
            text = { Text("Cancel this challenge? The opponent will be notified.", color = p.ink2, fontSize = 14.sp) },
            confirmButton = {
                TextButton(onClick = {
                    dialog = Dialog.NONE
                    run("cancel", idArgs("cancelChallenge", c.id), "Challenge cancelled")
                }) { Text("Cancel challenge", color = p.danger) }
            },
            dismissButton = { TextButton(onClick = { dialog = Dialog.NONE }) { Text("Keep it", color = p.ink2) } },
        )
        Dialog.SUBMIT -> SubmitDialog(
            c.format == "bo3_21",
            c.participants,
            viewer.id,
            busy == "submit",
            error,
            onDismiss = { if (busy.isEmpty()) dialog = Dialog.NONE },
        ) { games ->
            run("submit", submitResultArgs(c.id, games, c.format == "bo3_21"), "Result submitted! Waiting for confirmation.") {
                dialog = Dialog.NONE
            }
        }
        Dialog.DISPUTE -> DisputeDialog(
            isSubmitter,
            busy == "dispute",
            error,
            onDismiss = { if (busy.isEmpty()) dialog = Dialog.NONE },
        ) { reason, category ->
            if (match != null) {
                run("dispute", disputeArgs(match.id, reason, category), "Dispute opened") { dialog = Dialog.NONE }
            }
        }
        Dialog.WALKOVER -> AlertDialog(
            onDismissRequest = { if (busy.isEmpty()) dialog = Dialog.NONE },
            containerColor = p.surface,
            title = { Text("Report issue", color = p.text, style = Type.cardTitle) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("What happened?", color = p.muted, fontSize = 14.sp)
                    error?.let { Alert(it) }
                    ToneButton("Opponent no-show", p.danger, Color.White, busy.isEmpty(), busy == "walkover", Modifier.fillMaxWidth()) {
                        run(
                            "walkover",
                            walkoverArgs(c.id, "no_show", viewer.id, c.participants),
                            "Walkover reported. Admin will review.",
                        ) { dialog = Dialog.NONE }
                    }
                    GhostButton("I need to withdraw", enabled = busy.isEmpty()) {
                        run(
                            "walkover",
                            walkoverArgs(c.id, "withdrawal", viewer.id, c.participants),
                            "Walkover reported. Admin will review.",
                        ) { dialog = Dialog.NONE }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { dialog = Dialog.NONE }, enabled = busy.isEmpty()) { Text("Close", color = p.ink2) }
            },
        )
    }
}

@Composable
private fun InfoCard(title: String, sub: String) {
    val p = LocalPalette.current
    Card {
        Text(title, color = p.text, style = Type.cardTitle)
        Text(sub, color = p.muted, style = Type.cardSub, modifier = Modifier.padding(top = 4.dp))
    }
}

/** The web's success and danger buttons: a solid fill in the given colour. */
@Composable
private fun ToneButton(
    title: String,
    fill: Color,
    ink: Color,
    enabled: Boolean,
    loading: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(8.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = fill,
            contentColor = ink,
            disabledContainerColor = fill.copy(alpha = 0.55f),
            disabledContentColor = ink.copy(alpha = 0.55f),
        ),
        modifier = modifier.height(48.dp),
    ) {
        Text((if (loading) "Working..." else title).uppercase(), style = Type.button)
    }
}

private fun teamName(participants: List<ChallengeParticipant>, side: String): String =
    participants.filter { it.teamSide == side }
        .mapNotNull { it.person?.fullName?.takeIf { n -> n.isNotEmpty() } }
        .joinToString(" + ")
        .ifEmpty { "Unknown" }

@Composable
private fun SubmitDialog(
    bestOfThree: Boolean,
    participants: List<ChallengeParticipant>,
    viewerId: String,
    submitting: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSubmit: (List<GameScore>) -> Unit,
) {
    val p = LocalPalette.current
    val scores = remember { mutableStateListOf(*Array(if (bestOfThree) 6 else 2) { "" }) }
    val games = scores.chunked(2).map { GameScore(it[0], it[1]) }
    val tally = tallyGames(games)
    val nameA = teamName(participants, "a")
    val nameB = teamName(participants, "b")
    val mySide = participants.firstOrNull { it.playerId == viewerId }?.teamSide
    val labelA = if (mySide == "a") "Your team ($nameA)" else nameA
    val labelB = if (mySide == "b") "Your team ($nameB)" else nameB
    val compactA = if (nameA.length > 20) "Team A" else nameA
    val compactB = if (nameB.length > 20) "Team B" else nameB

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = p.surface,
        title = { Text("Submit match result", color = p.text, style = Type.cardTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .border(1.dp, p.line, RoundedCornerShape(10.dp))
                        .padding(12.dp),
                ) {
                    Text(
                        when (tally.winner) {
                            'a' -> "Winner: $labelA"
                            'b' -> "Winner: $labelB"
                            else -> "Winner: enter the game scores"
                        },
                        color = p.text,
                        style = Type.cardTitle,
                    )
                    Text(
                        "${tally.aGamesWon}-${tally.bGamesWon} in games" +
                            if (tally.winner == null) ". Tied or incomplete, so the result cannot be submitted yet." else "",
                        color = p.muted,
                        style = Type.cardSub,
                    )
                }
                for (g in 0 until scores.size / 2) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ScoreField("Game ${g + 1}: $compactA", scores[g * 2], Modifier.weight(1f)) { scores[g * 2] = it }
                        ScoreField("Game ${g + 1}: $compactB", scores[g * 2 + 1], Modifier.weight(1f)) { scores[g * 2 + 1] = it }
                    }
                }
                error?.let { Alert(it) }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSubmit(games) }, enabled = !submitting) {
                Text(if (submitting) "Submitting..." else "Submit", color = p.accent)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !submitting) { Text("Close", color = p.ink2) }
        },
    )
}

@Composable
private fun ScoreField(label: String, value: String, modifier: Modifier, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        // Digits only; empty is allowed so a field can be cleared and typed over.
        onValueChange = { onChange(it.filter { ch -> ch in '0'..'9' }.take(2)) },
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = modifier,
    )
}

@Composable
private fun DisputeDialog(
    isSubmitter: Boolean,
    sending: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSend: (String, String) -> Unit,
) {
    val p = LocalPalette.current
    var category by remember { mutableStateOf(DISPUTE_CATEGORIES.first().first) }
    var reason by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = p.surface,
        title = {
            Text(if (isSubmitter) "Report an error in your result" else "Dispute result", color = p.text, style = Type.cardTitle)
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Label("Reason")
                Column(Modifier.selectableGroup()) {
                    for ((value, label) in DISPUTE_CATEGORIES) {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 44.dp)
                                .selectable(selected = category == value, role = Role.RadioButton) { category = value },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = category == value,
                                onClick = null,
                                colors = RadioButtonDefaults.colors(selectedColor = p.accent),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(label, color = p.text, fontSize = 14.sp)
                        }
                    }
                }
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it.take(1000) },
                    label = { Text("Description") },
                    placeholder = { Text("Describe the issue...") },
                    supportingText = { Text("At least $DISPUTE_MIN characters.") },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Alert(it) }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSend(reason, category) }, enabled = !sending) {
                Text(if (sending) "Opening..." else "Open dispute", color = p.danger)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !sending) { Text("Close", color = p.ink2) }
        },
    )
}
