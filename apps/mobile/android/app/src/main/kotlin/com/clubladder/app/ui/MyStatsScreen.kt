package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.clubladder.app.Services
import com.clubladder.app.data.MyStats
import com.clubladder.app.data.Viewer
import com.clubladder.app.data.fmtDelta
import com.clubladder.app.data.fmtElo
import com.clubladder.app.data.isApproved
import com.clubladder.app.data.loadMyStats
import com.clubladder.app.ui.theme.BarlowCondensed
import com.clubladder.app.ui.theme.JetBrainsMono
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Type
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MyStatsScreen(services: Services, viewer: Viewer) {
    val p = LocalPalette.current
    val scope = rememberCoroutineScope()
    val loader = rememberLoader(viewer.id) { loadMyStats(services.postgrest, viewer.id) }

    PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
        Column(
            Modifier
                .fillMaxSize()
                .background(p.background)
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            PageHeader(
                "My stats",
                sub = (loader.state as? LoadState.Ready)?.data?.seasonName,
                padding = PaddingValues(top = 20.dp, bottom = 6.dp),
            )

            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Avatar(viewer.fullName ?: "Member", viewer.id, AvatarSize.XL, ring = true)
                    Spacer(Modifier.width(16.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            viewer.fullName ?: "Member",
                            color = p.text,
                            fontFamily = BarlowCondensed,
                            fontWeight = FontWeight.Bold,
                            fontSize = 26.sp,
                            lineHeight = 28.sp,
                        )
                        viewer.handle?.takeIf { it.isNotEmpty() }?.let {
                            Text("@$it", color = p.muted, fontFamily = JetBrainsMono, fontSize = 12.sp)
                        }
                        viewer.memberCode?.takeIf { it.isNotEmpty() }?.let {
                            Text(
                                "Member $it".uppercase(),
                                color = p.muted,
                                fontFamily = JetBrainsMono,
                                fontSize = 12.sp,
                                letterSpacing = 0.06.em,
                                modifier = Modifier.padding(top = 2.dp),
                            )
                        }
                    }
                }
            }

            // Only a member who can be challenged: anyone else's QR would open a
            // form that clears itself.
            val siteUrl = services.siteUrl
            if (siteUrl != null && isApproved(viewer)) MemberQrCard(siteUrl, viewer.id)

            when (val state = loader.state) {
                LoadState.Loading -> Column(Modifier.fillMaxWidth().height(160.dp)) { Loading() }
                is LoadState.Error -> Column(Modifier.fillMaxWidth().height(200.dp)) {
                    ErrorState(state.message, loader.reload)
                }
                is LoadState.Ready -> StatsCards(state.data)
            }

            GhostButton("Sign out") { scope.launch { services.sessions.signOut() } }
        }
    }
}

@Composable
private fun StatsCards(stats: MyStats) {
    val p = LocalPalette.current
    Card {
        Label("Rating")
        Readouts {
            Readout("Ladder", stats.position?.let { "#$it" }, note = "Not on the ladder")
            Divider()
            Readout("Singles", fmtElo(stats.singlesElo))
            Divider()
            Readout("Doubles", fmtElo(stats.doublesElo))
        }
    }

    Card {
        Label(stats.seasonName ?: "This season")
        val record = stats.record
        when {
            record == null -> Body("No season is running.", muted = true)
            record.played == 0 -> Body("No settled matches this season yet.", muted = true)
            else -> Readouts {
                Readout("Record", "${record.wins}-${record.losses}")
                Divider()
                Readout("Singles", "${record.singles.wins}-${record.singles.losses}")
                Divider()
                Readout("Doubles", "${record.doubles.wins}-${record.doubles.losses}")
            }
        }
    }

    Card {
        Label("Recent matches")
        if (stats.recent.isEmpty()) {
            Body(stats.seasonName?.let { "No matches in $it yet." } ?: "No matches yet.", muted = true)
        } else {
            for (m in stats.recent) {
                HorizontalDivider(color = p.line)
                Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Outcome(m.outcome)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            (if (m.type == "singles") "Singles" else "Doubles") + (m.score?.let { "  $it" } ?: ""),
                            color = p.text,
                            style = Type.rowTitle,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(m.playedAt?.take(10) ?: "", color = p.muted, style = Type.rowSub)
                    }
                    val delta = fmtDelta(m.delta)
                    Text(
                        delta,
                        color = when {
                            delta.startsWith("+") -> p.win
                            delta.startsWith("-") -> p.danger
                            else -> p.muted
                        },
                        fontFamily = JetBrainsMono,
                        fontSize = 14.sp,
                    )
                }
            }
        }
    }
}

/** The web's result chip: a letter on a wash with a heavier bottom edge. */
@Composable
private fun Outcome(outcome: Boolean?) {
    val p = LocalPalette.current
    val (bg, fg, edge) = when (outcome) {
        true -> Triple(p.winWash, p.win, p.win)
        false -> Triple(p.highlight, p.text, p.accent)
        null -> Triple(p.surface2, p.dim, p.dim)
    }
    Box(
        Modifier
            .size(width = 24.dp, height = 28.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(bg)
            .drawBehind {
                val h = 2.dp.toPx()
                drawRect(edge, Offset(0f, size.height - h), Size(size.width, h))
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            when (outcome) {
                true -> "W"
                false -> "L"
                null -> "-"
            },
            color = fg,
            fontFamily = JetBrainsMono,
            fontWeight = FontWeight.Bold,
            fontSize = 13.sp,
        )
    }
}

@Composable
private fun Readouts(content: @Composable RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), content = content)
}

@Composable
private fun Divider() {
    Box(Modifier.fillMaxHeight().width(1.dp).background(LocalPalette.current.line))
}

@Composable
private fun RowScope.Readout(label: String, value: String?, note: String? = null) {
    val p = LocalPalette.current
    Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
        Text(label.uppercase(), color = p.muted, style = Type.statLabel)
        Spacer(Modifier.height(6.dp))
        if (value != null) {
            Text(value, color = p.text, style = Type.statValue, maxLines = 1)
        } else if (note != null) {
            Text(note, color = p.muted, fontFamily = JetBrainsMono, fontSize = 11.sp, lineHeight = 15.sp)
        }
    }
}
