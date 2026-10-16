package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clubladder.app.Services
import com.clubladder.app.data.ActionOutcome
import com.clubladder.app.data.AppApi
import com.clubladder.app.data.AppResult
import com.clubladder.app.data.CHALLENGE_STATUS_LABEL
import com.clubladder.app.data.CHALLENGE_STATUS_TONE
import com.clubladder.app.data.ChallengeContext
import com.clubladder.app.data.ChallengeListItem
import com.clubladder.app.data.ExpiryKind
import com.clubladder.app.data.Person
import com.clubladder.app.data.TagTone
import com.clubladder.app.data.Viewer
import com.clubladder.app.data.expiryState
import com.clubladder.app.data.formatLabel
import com.clubladder.app.data.formatRelativeTime
import com.clubladder.app.data.loadMyChallenges
import com.clubladder.app.data.partitionChallenges
import com.clubladder.app.data.sortArchived
import com.clubladder.app.ui.theme.JetBrainsMono
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Palette
import com.clubladder.app.ui.theme.Type
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonArray

// apps/player/src/app/challenges/page.tsx, drawn in Compose. Reads are the
// member's own PostgREST reads; the standing, the switch, the rules and the
// quota come from the website's context route. When that route cannot be
// reached (an older website, no network) the list still reads and every write
// control is withheld, with the reason on screen.

const val READ_ONLY_NOTICE = "This build has no club website set, so challenges are read-only here."

/** The web's .tag colours. */
fun tagColors(p: Palette, tone: TagTone): Pair<Color, Color> = when (tone) {
    TagTone.GOLD -> Color(0x1FEAB308) to p.gold
    TagTone.WIN -> p.winWash to p.win
    TagTone.RED -> p.highlight to p.danger
    TagTone.PLAIN -> p.surface2 to p.ink2
}

@Composable
fun ToneTag(text: String, tone: TagTone) {
    val (bg, fg) = tagColors(LocalPalette.current, tone)
    Tag(text, background = bg, color = fg)
}

/** The context route, with a thrown session error read as a failure like any other. */
suspend fun loadContext(appApi: AppApi?): AppResult<ChallengeContext>? {
    if (appApi == null) return null
    return try {
        appApi.context()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        AppResult.Failed(e.message ?: "Something went wrong.")
    }
}

/** One write through the website, with a thrown session error read as a failure. */
suspend fun runAction(appApi: AppApi, name: String, args: JsonArray): ActionOutcome = try {
    appApi.action(name, args)
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    ActionOutcome.Failed(e.message ?: "Something went wrong.")
}

class ChallengesData(val items: List<ChallengeListItem>, val context: AppResult<ChallengeContext>?)

private const val SUB =
    "Issue, accept, and track challenges. Whatever is waiting on you sits at the top. Answer it so the queue clears."

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChallengesScreen(
    services: Services,
    viewer: Viewer,
    refreshKey: Int,
    onOpen: (String) -> Unit,
    onNew: () -> Unit,
) {
    val p = LocalPalette.current
    val loader = rememberLoader(Triple(viewer.id, refreshKey, services.appApi != null)) {
        coroutineScope {
            val list = async { loadMyChallenges(services.postgrest, viewer.id) }
            val context = async { loadContext(services.appApi) }
            ChallengesData(list.await(), context.await())
        }
    }

    when (val state = loader.state) {
        LoadState.Loading -> Column(Modifier.fillMaxSize()) {
            PageHeader("Challenges", sub = SUB)
            Box(Modifier.weight(1f)) { Loading() }
        }
        is LoadState.Error -> Column(Modifier.fillMaxSize()) {
            PageHeader("Challenges", sub = SUB)
            Box(Modifier.weight(1f)) { ErrorState(state.message, loader.reload) }
        }
        is LoadState.Ready -> {
            val data = state.data
            val ctx = (data.context as? AppResult.Ok)?.value
            val contextProblem = when (val c = data.context) {
                null -> READ_ONLY_NOTICE
                is AppResult.Failed -> c.message
                is AppResult.Ok -> null
            }
            val parts = partitionChallenges(data.items, viewer.id)
            val now = System.currentTimeMillis()
            PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
                LazyColumn(
                    Modifier.fillMaxSize().background(p.background),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    item { PageHeader("Challenges", sub = SUB, padding = PaddingValues(top = 20.dp, bottom = 6.dp)) }

                    // The web sends a member away from /challenges while the
                    // switch is off; here the screen says so and shows nothing.
                    if (ctx != null && !ctx.featureOn) {
                        item { Notice(ctx.featureMessage ?: "The club has switched challenges off for now.") }
                        return@LazyColumn
                    }

                    item { IssueControl(ctx, contextProblem, onNew) }
                    if (ctx != null && ctx.standing.ok) item { StatStrip(ctx, parts.incoming.size) }

                    if (data.items.isEmpty()) {
                        item { EmptyChallenges(ctx, onNew) }
                    } else {
                        val sections = listOf(
                            "Awaiting your answer" to parts.incoming.map { it to true },
                            "Active" to parts.active.map { it to false },
                            "Your challenges" to parts.outgoing.map { it to false },
                            "Archived" to sortArchived(parts.archived).map { it to false },
                        )
                        for ((title, rows) in sections) {
                            if (rows.isEmpty()) continue
                            item(key = title) {
                                Card(padding = 16.dp) {
                                    Row(Modifier.padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Text(title, color = p.text, style = Type.cardTitle, modifier = Modifier.weight(1f))
                                        ToneTag(rows.size.toString(), TagTone.PLAIN)
                                    }
                                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                        for ((row, awaiting) in rows) {
                                            ChallengeCard(row, viewer.id, awaiting, now) { onOpen(row.challenge.id) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** The page header's action: the button, the quota sentence, or why challenges are paused. */
@Composable
private fun IssueControl(ctx: ChallengeContext?, contextProblem: String?, onNew: () -> Unit) {
    val p = LocalPalette.current
    when {
        ctx == null -> Notice(contextProblem ?: READ_ONLY_NOTICE)
        !ctx.standing.ok -> Notice(ctx.standing.detail)
        ctx.canIssue -> PrimaryButton("New challenge", onClick = onNew)
        else -> Text(
            quotaFullNote(ctx),
            color = p.muted,
            fontFamily = JetBrainsMono,
            fontSize = 12.sp,
        )
    }
}

private fun quotaFullNote(ctx: ChallengeContext) =
    "You have ${ctx.quota.used} of ${ctx.quota.max} challenges open. Play or cancel one to issue another."

@Composable
private fun StatStrip(ctx: ChallengeContext, awaiting: Int) {
    val p = LocalPalette.current
    Card(padding = 0.dp) {
        Row(Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f).padding(14.dp)) {
                Text("OPEN CHALLENGES", color = p.muted, style = Type.statLabel)
                Text(
                    buildAnnotatedString {
                        append(ctx.quota.used.toString())
                        withStyle(SpanStyle(color = p.muted, fontSize = 15.sp)) { append(" / ${ctx.quota.max}") }
                    },
                    color = p.text,
                    style = Type.statValue.copy(fontFamily = JetBrainsMono),
                    modifier = Modifier.padding(top = 6.dp),
                )
                CapacityBar(ctx.quota.ratio.toFloat(), ctx.quota.full)
            }
            StatCell("AWAITING YOU", awaiting.toString())
            StatCell("REPLY WINDOW", "${ctx.rules.expiryHours}h")
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.StatCell(label: String, value: String) {
    val p = LocalPalette.current
    Column(
        Modifier
            .weight(1f)
            .drawBehind { drawRect(p.line, size = Size(1.dp.toPx(), size.height)) }
            .padding(14.dp),
    ) {
        Text(label, color = p.muted, style = Type.statLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(value, color = p.text, style = Type.statValue.copy(fontFamily = JetBrainsMono), modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
private fun CapacityBar(ratio: Float, full: Boolean) {
    val p = LocalPalette.current
    val fill = when {
        full -> p.danger
        ratio >= 0.66f -> p.warning
        else -> p.win
    }
    Box(
        Modifier
            .padding(top = 8.dp)
            .fillMaxWidth()
            .height(4.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(p.surface3),
    ) {
        Box(Modifier.fillMaxWidth(ratio.coerceIn(0f, 1f)).height(4.dp).background(fill))
    }
}

@Composable
private fun EmptyChallenges(ctx: ChallengeContext?, onNew: () -> Unit) {
    val p = LocalPalette.current
    Card {
        Text("No challenges yet", color = p.text, style = Type.cardTitle)
        val hint = if (ctx == null) {
            "Pick someone from the ladder and send one."
        } else {
            "Pick someone from the ladder and send one. You can have ${ctx.quota.max} open at a time, and an " +
                "unanswered challenge stands for ${ctx.rules.expiryHours} hours." + reachSentence(ctx)
        }
        Text(hint, color = p.muted, style = Type.cardSub, modifier = Modifier.padding(top = 6.dp, bottom = 14.dp))
        if (ctx != null && ctx.canIssue) PrimaryButton("Issue your first challenge", onClick = onNew)
    }
}

/** The page's reach clause, as its own sentence. 9999 is the "no limit" sentinel and is never quoted. */
private fun reachSentence(ctx: ChallengeContext): String {
    val noLimit = 9999
    val reach = listOfNotNull(
        if (ctx.rules.ladderRange < noLimit) "${ctx.rules.ladderRange} ladder positions" else null,
        if (ctx.rules.eloRange < noLimit) "${ctx.rules.eloRange} Elo" else null,
    )
    return if (reach.isEmpty()) "" else " Opponents must be within ${reach.joinToString(" and ")}."
}

// Names only: with handles the card title wrapped to three lines on a phone.
private fun named(person: Person?, fallback: String = "Unknown"): String =
    person?.fullName?.trim()?.takeIf { it.isNotEmpty() } ?: fallback

@Composable
private fun ChallengeCard(item: ChallengeListItem, viewerId: String, awaitingYou: Boolean, now: Long, onClick: () -> Unit) {
    val p = LocalPalette.current
    val c = item.challenge
    val creator = c.creatorPerson
    val isMine = c.createdBy == viewerId
    val expiry = expiryState(c.expiresAt, c.status, now)
    val roster = c.participants.mapNotNull { cp -> cp.person?.let { cp to it } }
    val youSide = roster.firstOrNull { it.second.id == viewerId }?.first?.teamSide
    val opponents = roster.filter { it.first.teamSide != youSide }
    val teammates = roster.filter { it.first.teamSide == youSide && it.second.id != viewerId }
    val shape = RoundedCornerShape(12.dp)
    val accent = p.accent

    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(p.surface)
            .border(1.dp, p.line, shape)
            .drawBehind { if (awaitingYou) drawRect(accent, size = Size(3.dp.toPx(), size.height)) }
            .clickable(role = Role.Button, onClick = onClick)
            .padding(16.dp),
    ) {
        FlowRow(
            Modifier.fillMaxWidth().padding(bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ToneTag(c.type.uppercase(), TagTone.RED)
            ToneTag(formatLabel(c.format), TagTone.PLAIN)
            if (c.ratedFlag) ToneTag("RATED", TagTone.GOLD)
            expiry.label?.let {
                ToneTag(
                    it,
                    when (expiry.kind) {
                        ExpiryKind.OPEN -> TagTone.PLAIN
                        ExpiryKind.URGENT -> TagTone.GOLD
                        else -> TagTone.RED
                    },
                )
            }
            Text(formatRelativeTime(c.createdAt, now), color = p.muted, style = Type.rowSub, modifier = Modifier.padding(top = 3.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(creator?.fullName ?: "?", creator?.id ?: c.id, AvatarSize.MD)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    if (isMine) "You challenged" else "${named(creator)} challenged you",
                    color = p.text,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                )
                val vs = if (opponents.isNotEmpty()) {
                    "vs " + opponents.joinToString(" & ") { named(it.second) }
                } else {
                    "Awaiting roster"
                }
                val with = if (teammates.isNotEmpty()) " · with " + teammates.joinToString(", ") { named(it.second) } else ""
                Text(vs + with, color = p.muted, style = Type.rowSub, modifier = Modifier.padding(top = 2.dp))
                c.scheduledDate?.let { date ->
                    val time = c.scheduledTime?.take(5)?.let { " · $it" } ?: ""
                    Text(date + time, color = p.muted, style = Type.rowSub, modifier = Modifier.padding(top = 2.dp))
                }
            }
            Spacer(Modifier.width(8.dp))
            ToneTag(CHALLENGE_STATUS_LABEL[c.status] ?: c.status, CHALLENGE_STATUS_TONE[c.status] ?: TagTone.PLAIN)
        }
    }
}
