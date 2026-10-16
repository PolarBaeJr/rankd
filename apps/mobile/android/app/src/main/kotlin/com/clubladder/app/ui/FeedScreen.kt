package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clubladder.app.R
import com.clubladder.app.Services
import com.clubladder.app.data.AgendaDay
import com.clubladder.app.data.Feed
import com.clubladder.app.data.FeedAgendaRow
import com.clubladder.app.data.FeedLink
import com.clubladder.app.data.LiveTournamentCard
import com.clubladder.app.data.RiverRow
import com.clubladder.app.data.Viewer
import com.clubladder.app.data.loadFeed
import com.clubladder.app.shared.WeekStripDay
import com.clubladder.app.ui.theme.BarlowCondensed
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Type
import com.clubladder.app.ui.theme.tone

// The web's /feed on one scrolling page, read only. Deferred from the web:
// the month calendar (desktop only there), realtime (pull to refresh instead),
// subscribe-to-calendar, RSVP buttons, add-to-calendar, check-in without a
// scan, and the passkey nudge. The one action is the door-code scan, which
// runs the existing check-in path.

/**
 * @param focusSession a session id from a /feed?s= or /sessions?s= link: the
 *   page scrolls to its card once, then [onFocusDone] clears it.
 * @param canBrowse the website's address is known, so web-only links open in
 *   the browser; without it those rows are not tappable.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedScreen(
    services: Services,
    viewer: Viewer,
    refreshKey: Int,
    focusSession: String?,
    onFocusDone: () -> Unit,
    onScan: (() -> Unit)?,
    canBrowse: Boolean,
    onLink: (FeedLink) -> Unit,
) {
    val p = LocalPalette.current
    val loader = rememberLoader(Triple(viewer.id, viewer.status, refreshKey)) { loadFeed(services.postgrest, viewer) }

    when (val state = loader.state) {
        LoadState.Loading -> Column(Modifier.fillMaxSize()) {
            PageHeader("Feed")
            Box(Modifier.weight(1f)) { Loading() }
        }
        is LoadState.Error -> Column(Modifier.fillMaxSize()) {
            PageHeader("Feed")
            Box(Modifier.weight(1f)) { ErrorState(state.message, loader.reload) }
        }
        is LoadState.Ready -> PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
            val feed = state.data
            val listState = rememberLazyListState()
            var showMore by rememberSaveable { mutableStateOf(false) }
            var target by remember { mutableStateOf<String?>(null) }

            fun tap(link: FeedLink): (() -> Unit)? = if (link is FeedLink.Web && !canBrowse) null else ({ onLink(link) })
            fun jumpTo(dateISO: String) {
                if (feed.agendaLater.any { it.dateISO == dateISO }) showMore = true
                target = "day:$dateISO"
            }

            // One flat list, so a key maps to the index the scroll needs.
            val keys = mutableListOf<String>()
            val contents = mutableListOf<@Composable () -> Unit>()
            fun add(key: String, content: @Composable () -> Unit) {
                keys += key
                contents += content
            }

            add("header") { FeedHeader(feed, viewer) }
            feed.standing?.let { s ->
                add("standing") {
                    SpineCard(p.accent) {
                        Text(s.title, color = p.text, style = Type.cardTitle)
                        Body(s.body, muted = true)
                    }
                }
            }
            feed.paymentAmount?.let { amount ->
                add("pay") {
                    SpineCard(p.gold) {
                        Body("You have $amount unpaid. Pay and upload your receipt.")
                        PrimaryButton("Pay now") { onLink(FeedLink.Membership) }
                    }
                }
            }
            if (onScan != null && feed.sessionsOn) {
                add("scan") { GhostButton("Scan the door code", icon = R.drawable.ic_scan, onClick = onScan) }
            }
            for (t in feed.liveTournaments) add("live:${t.id}") { LiveTournament(t, ::tap) }

            if (feed.scheduleOn) {
                add("week") { WeekStrip(feed.week, feed.agendaDates, ::jumpTo) }
                add("upnext") { SectionHead("Up next", feed.upNextSub) }
                if (feed.scheduleError) {
                    add("schedule-error") {
                        SpineCard(null) {
                            Text("We could not load the schedule", color = p.text, style = Type.cardTitle)
                            Body("Pull down to try again.", muted = true)
                        }
                    }
                }
                feed.empty?.let { e ->
                    add("empty") {
                        SpineCard(null) {
                            Text(e.title, color = p.text, style = Type.cardTitle)
                            Body(e.hint, muted = true)
                        }
                    }
                }
                val days = if (showMore) feed.agendaSoon + feed.agendaLater else feed.agendaSoon
                for (day in days) {
                    add("day:${day.dateISO}") { DayRail(day) }
                    for (row in day.rows) {
                        add("agenda:${row.key}") {
                            when (row) {
                                is FeedAgendaRow.Session -> SessionCard(row, onScan)
                                is FeedAgendaRow.ClubEvent -> ClubEventRow(row, tap(row.link))
                                is FeedAgendaRow.Tournament -> TournamentRow(row, tap(row.link))
                            }
                        }
                    }
                }
                if (!showMore && feed.agendaLater.isNotEmpty()) {
                    val n = feed.agendaLater.size
                    add("more") { TextLink("Show $n more ${if (n == 1) "date" else "dates"}") { showMore = true } }
                }
                if (feed.clubEventsError || feed.tournamentsError) {
                    add("notes") {
                        Column {
                            if (feed.clubEventsError) Body("Club events could not be loaded right now.", muted = true)
                            if (feed.tournamentsError) Body("Tournaments could not be loaded right now.", muted = true)
                        }
                    }
                }
            }

            add("activity") { Activity(feed, canBrowse, ::tap, onLink) }
            add("you") { You(feed, onLink) }

            LaunchedEffect(target, keys.size) {
                val t = target ?: return@LaunchedEffect
                val i = keys.indexOf(t)
                if (i >= 0) listState.animateScrollToItem(i)
                target = null
            }
            LaunchedEffect(focusSession, feed) {
                val id = focusSession ?: return@LaunchedEffect
                val key = "session:$id"
                fun holds(days: List<AgendaDay>) = days.any { d -> d.rows.any { it.key == key } }
                if (holds(feed.agendaLater)) showMore = true
                if (holds(feed.agendaSoon) || holds(feed.agendaLater)) target = "agenda:$key"
                onFocusDone()
            }

            LazyColumn(
                Modifier.fillMaxSize().background(p.background),
                state = listState,
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(keys.size, key = { keys[it] }) { contents[it]() }
            }
        }
    }
}

@Composable
private fun FeedHeader(feed: Feed, viewer: Viewer) {
    Row(verticalAlignment = Alignment.Bottom) {
        Box(Modifier.weight(1f)) {
            PageHeader("Feed", eyebrow = feed.eyebrow, padding = PaddingValues(top = 20.dp, bottom = 8.dp))
        }
        Box(Modifier.padding(bottom = 8.dp)) { Avatar(viewer.fullName ?: "?", viewer.id, AvatarSize.SM) }
    }
}

/** A card with an optional 3dp coloured spine down its left edge, as the web's session and banner cards. */
@Composable
private fun SpineCard(spine: Color?, onClick: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(p.surface)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .drawBehind { if (spine != null) drawRect(spine, size = Size(3.dp.toPx(), size.height)) }
            .border(1.dp, p.line, shape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

@Composable
private fun SectionHead(title: String, sub: String) {
    val p = LocalPalette.current
    Column(Modifier.padding(top = 8.dp)) {
        Text(title, color = p.text, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 22.sp)
        Text(sub, color = p.muted, style = Type.cardSub, modifier = Modifier.padding(top = 2.dp))
    }
}

@Composable
private fun LiveTournament(t: LiveTournamentCard, tap: (FeedLink) -> (() -> Unit)?) {
    val p = LocalPalette.current
    SpineCard(p.accent) {
        Text(t.eyebrow, color = p.accent, style = Type.label)
        Text(t.name, color = p.text, style = Type.cardTitle)
        if (t.meta.isNotEmpty()) Text(t.meta, color = p.muted, style = Type.rowSub)
        for (e in t.entries) {
            val onClick = tap(e.link)
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 40.dp)
                    .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(e.eventLabel, color = p.text, style = Type.rowTitle, modifier = Modifier.weight(1f))
                if (e.checkedIn) {
                    Pill("Checked in", p.winWash, p.win)
                } else {
                    Pill("Not checked in", p.surface3, p.muted)
                }
            }
        }
        t.notEntered?.let { text ->
            Body(text, muted = true)
            tap(t.follow)?.let { GhostButton("Follow the draw", onClick = it) }
        }
    }
}

@Composable
private fun WeekStrip(week: List<WeekStripDay>, agendaDates: Set<String>, onDay: (String) -> Unit) {
    val p = LocalPalette.current
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (d in week) {
            val linked = d.dateISO in agendaDates
            val shape = RoundedCornerShape(8.dp)
            Column(
                Modifier
                    .weight(1f)
                    .clip(shape)
                    .background(if (d.isToday) p.highlight else p.surface)
                    .border(1.dp, if (d.isToday) p.redBorder else p.line, shape)
                    .then(if (linked) Modifier.clickable(role = Role.Button) { onDay(d.dateISO) } else Modifier)
                    .clearAndSetSemantics { contentDescription = d.summary }
                    .padding(vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(d.weekday.uppercase(), color = if (d.isToday) p.accent else p.muted, style = Type.statLabel)
                Text(d.day.toString(), color = p.text, style = Type.sessTime)
                Row(Modifier.heightIn(min = 12.dp), horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
                    for (m in d.marks) Box(Modifier.size(6.dp).background(p.tone(m), CircleShape))
                    if (d.more > 0) Text("+${d.more}", color = p.muted, fontSize = 9.sp)
                }
            }
        }
    }
}

@Composable
private fun DayRail(day: AgendaDay) {
    val p = LocalPalette.current
    Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(day.label.uppercase(), color = if (day.isToday) p.accent else p.text, style = Type.sessDate)
        Text("  ${day.dateLabel.uppercase()}", color = p.muted, style = Type.sessDate)
    }
}

@Composable
private fun SessionCard(row: FeedAgendaRow.Session, onScan: (() -> Unit)?) {
    val p = LocalPalette.current
    SpineCard(if (row.isNext) p.accent else null) {
        if (row.isNext) Text("NEXT UP", color = p.accent, style = Type.label)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                row.name,
                color = p.text,
                fontFamily = BarlowCondensed,
                fontWeight = FontWeight.Bold,
                fontSize = 22.sp,
                modifier = Modifier.weight(1f, fill = false),
            )
            row.trackTag?.let { Tag(it, p.surface3, p.ink2) }
        }
        Text(row.timeLabel, color = p.text, style = Type.sessTime)
        val meta = listOfNotNull(
            row.location,
            "${row.goingCount} going",
            if (row.checkedInCount > 0) "${row.checkedInCount} checked in" else null,
        ).joinToString(" · ")
        Text(meta, color = p.muted, style = Type.sessMeta)
        row.notes?.let { Body(it, muted = true) }
        row.stateChip?.let { chip ->
            val present = chip == "Checked In" || chip == "Attended"
            Pill(chip, if (present) p.winWash else p.surface3, if (present) p.win else p.muted)
        }
        row.windowLabel?.let { Text(it, color = p.muted, style = Type.sessMeta) }
        if (row.canScan && onScan != null) {
            PrimaryButton("Scan to check in", icon = R.drawable.ic_scan, onClick = onScan)
        }
    }
}

@Composable
private fun ClubEventRow(row: FeedAgendaRow.ClubEvent, onClick: (() -> Unit)?) {
    val p = LocalPalette.current
    SpineCard(null, onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Tag(row.kindLabel.uppercase(), p.surface3, p.gold)
            if (row.cancelled) {
                Tag("CANCELLED", p.surface3, p.muted)
            } else if (row.going) {
                Pill("Going", p.winWash, p.win)
            }
        }
        Text(
            row.title,
            color = if (row.cancelled) p.muted else p.text,
            style = Type.rowTitle,
            textDecoration = if (row.cancelled) TextDecoration.LineThrough else null,
        )
        if (row.meta.isNotEmpty()) Text(row.meta, color = p.muted, style = Type.sessMeta)
    }
}

@Composable
private fun TournamentRow(row: FeedAgendaRow.Tournament, onClick: (() -> Unit)?) {
    val p = LocalPalette.current
    SpineCard(null, onClick) {
        Tag("TOURNAMENT", p.surface3, p.ink2)
        Text(row.name, color = p.text, style = Type.rowTitle)
        Text(row.whenLabel, color = p.muted, style = Type.sessMeta)
    }
}

@Composable
private fun Activity(feed: Feed, canBrowse: Boolean, tap: (FeedLink) -> (() -> Unit)?, onLink: (FeedLink) -> Unit) {
    val p = LocalPalette.current
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionHead("Club activity", "Results, challenges and club notices.")
        feed.notice?.let { n ->
            SpineCard(p.accent, tap(FeedLink.Web("/announcements"))) {
                Text("CLUB NOTICE", color = p.accent, style = Type.label)
                Text(n.title, color = p.text, style = Type.cardTitle)
                Body(n.body)
                Text(n.meta, color = p.muted, style = Type.rowSub)
            }
        }
        Card(padding = 16.dp) {
            if (feed.river.isEmpty()) {
                Text("Nothing has happened yet", color = p.text, style = Type.cardTitle)
                Body(
                    "Results and challenges land here as the club plays. Issue a challenge to put the first one on the board.",
                    muted = true,
                )
                if (feed.showChallengeCta) {
                    Box(Modifier.padding(top = 12.dp)) { PrimaryButton("Issue a challenge") { onLink(FeedLink.NewChallenge) } }
                }
            } else {
                for ((i, section) in feed.river.withIndex()) {
                    Text(
                        section.label.uppercase(),
                        color = p.muted,
                        style = Type.label,
                        modifier = Modifier.padding(top = if (i == 0) 0.dp else 12.dp, bottom = 4.dp),
                    )
                    for (row in section.items) RiverItem(row, tap(row.link))
                }
                HorizontalDivider(color = p.line, modifier = Modifier.padding(top = 8.dp))
                Text(feed.riverEnd.uppercase(), color = p.dim, style = Type.label, modifier = Modifier.padding(top = 8.dp))
            }
        }
        if (canBrowse) {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                TextLink("All notifications") { onLink(FeedLink.Web("/notifications")) }
                if (feed.announcementsOn) TextLink("Announcements") { onLink(FeedLink.Web("/announcements")) }
            }
        }
    }
}

@Composable
private fun RiverItem(row: RiverRow, onClick: (() -> Unit)?) {
    val p = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(row.face.name, row.face.id, AvatarSize.SM)
        Column(Modifier.weight(1f)) {
            Text(row.sentence, color = p.text, style = Type.rowTitle)
            Text(row.meta, color = p.muted, style = Type.rowSub)
        }
        if (row.isChallenge) {
            Tag("REPLY", p.highlight, p.accent)
        } else if (row.delta != null) {
            Column(horizontalAlignment = Alignment.End) {
                Text(row.delta, color = if (row.deltaUp) p.win else p.accent, style = Type.lrValue)
                row.rating?.let { Text(it, color = p.muted, style = Type.rowSub) }
            }
        }
    }
}

@Composable
private fun You(feed: Feed, onLink: (FeedLink) -> Unit) {
    val p = LocalPalette.current
    val you = feed.you
    Card(padding = 16.dp) {
        Label("You")
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            you.streak?.let { Figure("Streak", it.toString(), null) }
            for (f in you.figures) Figure(f.label, f.value, f.sub)
        }
        you.note?.let { Box(Modifier.padding(top = 8.dp)) { Body(it, muted = true) } }
        if (you.showMyStats) {
            Box(Modifier.padding(top = 12.dp)) { GhostButton("My stats") { onLink(FeedLink.MyStats) } }
        }
    }
}

@Composable
private fun Figure(label: String, value: String, sub: String?) {
    val p = LocalPalette.current
    Column {
        Text(label.uppercase(), color = p.muted, style = Type.statLabel)
        Text(value, color = p.text, style = Type.statValue.copy(fontSize = 24.sp, lineHeight = 24.sp))
        sub?.let { Text(it, color = p.muted, style = Type.rowSub, modifier = Modifier.padding(top = 2.dp)) }
    }
}
