package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.clubladder.app.R
import com.clubladder.app.Services
import com.clubladder.app.data.LeaderboardTab
import com.clubladder.app.data.RankedRow
import com.clubladder.app.data.Viewer
import com.clubladder.app.data.fmtElo
import com.clubladder.app.data.loadLadder
import com.clubladder.app.data.rankLadder
import com.clubladder.app.ui.theme.BarlowCondensed
import com.clubladder.app.ui.theme.JetBrainsMono
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Palette
import com.clubladder.app.ui.theme.Type

// The chips spell the ladders out, as the web's do; `label` stays the short
// form the data layer and its tests use.
private val LeaderboardTab.title: String
    get() = when (this) {
        LeaderboardTab.OPEN_SINGLES -> "Open Singles"
        LeaderboardTab.OPEN_DOUBLES -> "Open Doubles"
        LeaderboardTab.COMP_SINGLES -> "Comp Singles"
        LeaderboardTab.COMP_DOUBLES -> "Comp Doubles"
    }

private fun medal(p: Palette, rank: Int): Color? = when (rank) {
    1 -> p.gold
    2 -> p.silver
    3 -> p.bronze
    else -> null
}

@Composable
private fun RanksHeader() {
    PageHeader("Ranks", eyebrow = "Ladder", sub = "Where you sit against everyone.")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LeaderboardScreen(services: Services, viewer: Viewer, onChallenge: ((String) -> Unit)? = null) {
    var tab by rememberSaveable { mutableStateOf(LeaderboardTab.OPEN_SINGLES) }
    // get_leaderboard() is the database's own filtered ladder. Nothing else
    // here reads another member's rating.
    val loader = rememberLoader(viewer.id) { loadLadder(services.postgrest) }

    when (val state = loader.state) {
        LoadState.Loading -> Column(Modifier.fillMaxSize()) {
            RanksHeader()
            Box(Modifier.weight(1f)) { Loading() }
        }
        is LoadState.Error -> Column(Modifier.fillMaxSize()) {
            RanksHeader()
            Box(Modifier.weight(1f)) { ErrorState(state.message, loader.reload) }
        }
        is LoadState.Ready -> {
            val ranked = remember(state.data, tab) { rankLadder(state.data, tab) }
            PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 20.dp)) {
                    item { RanksHeader() }
                    item {
                        Chips(tab) { tab = it }
                        Spacer(Modifier.height(20.dp))
                    }
                    if (ranked.isEmpty()) {
                        item { Box(Modifier.fillParentMaxWidth().height(240.dp)) { EmptyState("No ranked players yet.") } }
                    } else {
                        item {
                            Podium(ranked.take(3), tab, viewer.id, onChallenge)
                            Spacer(Modifier.height(14.dp))
                        }
                        item { LadderHead(tab) }
                        itemsIndexed(ranked, key = { _, it -> it.row.id }) { i, item ->
                            LadderRow(item, me = item.row.id == viewer.id, first = i == 0, last = i == ranked.lastIndex, onChallenge)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Chips(tab: LeaderboardTab, onSelect: (LeaderboardTab) -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (t in LeaderboardTab.entries) {
            val selected = tab == t
            val shape = RoundedCornerShape(999.dp)
            Text(
                t.title,
                color = if (selected) Color.White else p.ink2,
                style = Type.chip,
                modifier = Modifier
                    .clip(shape)
                    .background(if (selected) p.accent else p.surface)
                    .border(1.dp, if (selected) p.accent else p.line, shape)
                    .selectable(selected = selected, role = Role.Tab) { onSelect(t) }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun Podium(top: List<RankedRow>, tab: LeaderboardTab, viewerId: String, onChallenge: ((String) -> Unit)?) {
    val p = LocalPalette.current
    Card(Modifier.padding(horizontal = 16.dp), padding = 0.dp) {
        Row(
            Modifier.padding(start = 20.dp, top = 20.dp, end = 20.dp, bottom = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Top 3", color = p.text, style = Type.cardTitle)
                Text("The players to beat", color = p.muted, style = Type.cardSub)
            }
            Tag("PODIUM", background = Color(0x1FEAB308), color = p.gold)
        }
        HorizontalDivider(color = p.line)
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            top.forEachIndexed { i, item ->
                val shape = RoundedCornerShape(8.dp)
                Row(
                    Modifier
                        .fillMaxWidth()
                        // highlight is a translucent red wash, so it is laid over
                        // the opaque surface rather than replacing it.
                        .background(p.surface, shape)
                        .background(if (i == 0) p.highlight else Color.Transparent, shape)
                        .border(1.dp, p.line, shape)
                        .padding(horizontal = 12.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        item.rank.toString(),
                        color = medal(p, item.rank) ?: p.dim,
                        fontFamily = BarlowCondensed,
                        fontWeight = FontWeight.Bold,
                        fontSize = 30.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.width(36.dp),
                    )
                    Spacer(Modifier.width(10.dp))
                    Avatar(item.row.name, item.row.id, AvatarSize.MD, ring = i == 0)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            item.row.name + if (item.row.id == viewerId) "  (you)" else "",
                            color = p.text,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            item.row.handle?.takeIf { it.isNotEmpty() }?.let { "@$it" }
                                ?: if (tab.isDoubles) "Doubles" else "Singles",
                            color = p.muted,
                            style = Type.rowSub,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        fmtElo(item.elo),
                        color = p.text,
                        fontFamily = JetBrainsMono,
                        fontWeight = FontWeight.Bold,
                        fontSize = 18.sp,
                    )
                    if (onChallenge != null && item.row.id != viewerId) ChallengeButton(item.row.name) { onChallenge(item.row.id) }
                }
            }
        }
    }
}

private val keyStyle = TextStyle(fontFamily = JetBrainsMono, fontSize = 10.sp, letterSpacing = 0.1.em)

@Composable
private fun LadderHead(tab: LeaderboardTab) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp)
    Column(
        Modifier
            .padding(horizontal = 16.dp)
            .fillMaxWidth()
            .background(p.surface, shape)
            .border(1.dp, p.line, shape),
    ) {
        Text(
            "${tab.title} · Full ladder",
            color = p.text,
            style = Type.cardTitle,
            modifier = Modifier.padding(start = 20.dp, top = 20.dp, end = 20.dp, bottom = 14.dp),
        )
        HorizontalDivider(color = p.line)
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
            Text("#  PLAYER", color = p.dim, style = keyStyle, modifier = Modifier.weight(1f))
            Text("ELO", color = p.dim, style = keyStyle)
        }
    }
}

/**
 * One ladder row, drawn as a slice of the card the head opens: side edges on
 * every row, a divider above each after the first, rounded corners on the last.
 */
@Composable
private fun LadderRow(item: RankedRow, me: Boolean, first: Boolean, last: Boolean, onChallenge: ((String) -> Unit)?) {
    val p = LocalPalette.current
    val shape = if (last) RoundedCornerShape(bottomStart = 12.dp, bottomEnd = 12.dp) else RoundedCornerShape(0.dp)
    val line = p.line
    Row(
        Modifier
            .padding(horizontal = 16.dp)
            .fillMaxWidth()
            .background(p.surface, shape)
            .background(if (me) p.highlight else Color.Transparent, shape)
            .then(
                if (last) {
                    Modifier.border(1.dp, line, shape)
                } else {
                    Modifier.drawBehind {
                        val w = 1.dp.toPx()
                        // The head's bottom edge already runs above the first row.
                        val top = if (first) 0f else w
                        if (!first) drawRect(line, Offset.Zero, Size(size.width, w))
                        drawRect(line, Offset(0f, top), Size(w, size.height - top))
                        drawRect(line, Offset(size.width - w, top), Size(w, size.height - top))
                    }
                },
            )
            .padding(start = 12.dp, top = 12.dp, end = 14.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            item.rank.toString(),
            color = medal(p, item.rank) ?: p.dim,
            style = Type.lrRank,
            textAlign = TextAlign.End,
            modifier = Modifier.width(34.dp),
        )
        Spacer(Modifier.width(10.dp))
        Avatar(item.row.name, item.row.id, AvatarSize.SM, ring = me)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                item.row.name + if (me) "  (you)" else "",
                color = p.text,
                style = Type.rowTitle,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            item.row.handle?.takeIf { it.isNotEmpty() }?.let {
                Text("@$it", color = p.muted, style = Type.rowSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(fmtElo(item.elo), color = p.text, style = Type.lrValue)
        if (onChallenge != null && !me) ChallengeButton(item.row.name) { onChallenge(item.row.id) }
    }
}

/** The web's crosshair: opens the new-challenge form with this member picked. */
@Composable
private fun ChallengeButton(name: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(48.dp)) {
        Icon(
            painterResource(R.drawable.ic_tab_challenges),
            contentDescription = "Challenge $name",
            tint = LocalPalette.current.muted,
            modifier = Modifier.size(18.dp),
        )
    }
}
