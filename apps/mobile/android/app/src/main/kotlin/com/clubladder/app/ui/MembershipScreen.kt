package com.clubladder.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.clubladder.app.Services
import com.clubladder.app.data.Viewer
import com.clubladder.app.data.isApproved
import com.clubladder.app.data.loadStatement
import com.clubladder.app.data.statementHeadline
import com.clubladder.app.shared.BadgeTone
import com.clubladder.app.shared.FeeLine
import com.clubladder.app.shared.headlineBadge
import com.clubladder.app.shared.money
import com.clubladder.app.ui.theme.JetBrainsMono
import com.clubladder.app.ui.theme.LocalPalette
import com.clubladder.app.ui.theme.Type

@Composable
fun MembershipScreen(services: Services, viewer: Viewer) {
    if (!isApproved(viewer)) {
        Column(Modifier.fillMaxSize().background(LocalPalette.current.background).padding(horizontal = 16.dp)) {
            PageHeader("Membership", padding = PaddingValues(top = 20.dp, bottom = 20.dp))
            Card { Body("Your statement appears here once your membership is approved.", muted = true) }
        }
        return
    }
    Statement(services, viewer)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Statement(services: Services, viewer: Viewer) {
    val p = LocalPalette.current
    val loader = rememberLoader(viewer) { loadStatement(services.postgrest, viewer) }

    when (val state = loader.state) {
        LoadState.Loading -> Column(Modifier.fillMaxSize()) {
            PageHeader("Membership")
            Box(Modifier.weight(1f)) { Loading() }
        }
        is LoadState.Error -> Column(Modifier.fillMaxSize()) {
            PageHeader("Membership")
            Box(Modifier.weight(1f)) { ErrorState(state.message, loader.reload) }
        }
        is LoadState.Ready -> PullToRefreshBox(isRefreshing = loader.refreshing, onRefresh = loader.reload) {
            val summary = state.data.summary
            val season = state.data.season
            val headline = statementHeadline(summary)
            Column(
                Modifier
                    .fillMaxSize()
                    .background(p.background)
                    .verticalScroll(rememberScrollState())
                    .padding(start = 16.dp, end = 16.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                PageHeader("Membership", sub = season?.name, padding = PaddingValues(top = 20.dp, bottom = 6.dp))

                Card {
                    Label("Outstanding")
                    Row(
                        Modifier.padding(top = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(headline.amount, color = p.text, style = Type.figure)
                        val (bg, fg) = when (headlineBadge(summary).tone) {
                            BadgeTone.SUCCESS -> p.win.copy(alpha = 0.2f) to p.win
                            BadgeTone.WARNING -> p.warning.copy(alpha = 0.2f) to p.warning
                            BadgeTone.NEUTRAL -> p.line2 to p.muted
                        }
                        Pill(headline.label, background = bg, color = fg)
                    }
                    if (summary.unknownCount > 0) {
                        val noun = if (summary.unknownCount == 1) "entry" else "entries"
                        Text(
                            "Plus ${summary.unknownCount} $noun with no price recorded yet.",
                            color = p.muted,
                            fontSize = 13.sp,
                            lineHeight = 19.sp,
                            modifier = Modifier.padding(top = 14.dp),
                        )
                    }
                }

                if (summary.outstanding.isNotEmpty()) {
                    Card {
                        Label("To pay")
                        for (line in summary.outstanding) OwedRow(line)
                        Column(Modifier.padding(top = 8.dp)) {
                            Body("Send a payment receipt from the Membership page on the club website.", muted = true)
                        }
                    }
                }

                Card {
                    Label("Receipts")
                    if (summary.receipts.isEmpty()) {
                        Body("No payments recorded yet.", muted = true)
                    } else {
                        for (line in summary.receipts) ReceiptRow(line)
                    }
                }
            }
        }
    }
}

@Composable
private fun OwedRow(line: FeeLine) {
    val p = LocalPalette.current
    HorizontalDivider(color = p.line)
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(line.name, color = p.ink2, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Text(money(line.owedCents), color = p.text, fontFamily = JetBrainsMono, fontSize = 14.sp)
    }
}

@Composable
private fun ReceiptRow(line: FeeLine) {
    val p = LocalPalette.current
    HorizontalDivider(color = p.line)
    Row(
        Modifier.fillMaxWidth().padding(vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(line.name, color = p.text, fontSize = 15.sp)
            line.paidAt?.take(10)?.takeIf { it.isNotEmpty() }?.let {
                Text(
                    it.uppercase(),
                    color = p.muted,
                    fontFamily = JetBrainsMono,
                    fontSize = 10.sp,
                    letterSpacing = 0.1.em,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        Text(
            if (line.waived) "Waived" else money(line.recordedCents),
            color = p.text,
            fontFamily = JetBrainsMono,
            fontSize = 15.sp,
        )
    }
}
