package com.clubladder.app.data

import com.clubladder.app.shared.FeeKind
import com.clubladder.app.shared.FeeLine
import com.clubladder.app.shared.OutstandingSummary
import com.clubladder.app.shared.PayableFeeLine
import com.clubladder.app.shared.headlineAmount
import com.clubladder.app.shared.headlineBadge
import com.clubladder.app.shared.settlementOf
import com.clubladder.app.shared.summariseFees
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.text.Collator
import java.util.Locale

// Port of the Expo app's src/lib/statement.ts, built the way /membership builds
// it (apps/player/src/app/membership/member-section.tsx) from the same rows and
// the same ledger rules, so the phone and the website print one figure. Keep in
// step with both.

/** The member's own fee rows, as apps/player/src/lib/member-fees.ts reads them. */
const val OWN_FEE_COLUMNS =
    "id, fee_type, season_id, tournament_id, club_event_id, amount_cents, paid_at, method, reference, created_at, " +
        "fee_submissions(id, status, reference, reject_reason, submitted_at)"

@Serializable
data class OwnFeeRow(
    val id: String,
    @SerialName("fee_type") val feeType: String,
    @SerialName("season_id") val seasonId: String? = null,
    @SerialName("tournament_id") val tournamentId: String? = null,
    @SerialName("club_event_id") val clubEventId: String? = null,
    @SerialName("amount_cents") val amountCents: Long? = null,
    @SerialName("paid_at") val paidAt: String? = null,
    val method: String? = null,
    val reference: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("fee_submissions") val feeSubmissions: List<OwnFeeSubmission>? = null,
)

@Serializable
data class OwnFeeSubmission(
    val id: String = "",
    val status: String = "",
    @SerialName("submitted_at") val submittedAt: String = "",
)

/** The most recent receipt sent for a fee, or null. */
fun latestSubmission(row: OwnFeeRow?): OwnFeeSubmission? =
    row?.feeSubmissions.orEmpty().sortedWith { a, b -> b.submittedAt.compareTo(a.submittedAt) }.firstOrNull()

/**
 * Port of toPayableLines in apps/player/src/lib/member-fees.ts: the rows as
 * payable lines, dues from other seasons left out, plus this season's dues at
 * the member's price when there is no dues row yet.
 */
fun toPayableLines(rows: List<OwnFeeRow>, season: StatementSeason?, status: String?): List<PayableFeeLine> {
    val lines = rows
        .filter { it.feeType != "dues" || (season != null && it.seasonId == season.id) }
        .map { PayableFeeLine(it.feeType, it.paidAt, it.amountCents, latestSubmission(it)?.status == "submitted") }
        .toMutableList()
    if (season != null && rows.none { it.feeType == "dues" && it.seasonId == season.id }) {
        lines += PayableFeeLine("dues", null, seasonFeeFor(status, season), pending = false)
    }
    return lines
}

@Serializable
data class StatementSeason(
    val id: String,
    val name: String,
    @SerialName("end_date") val endDate: String? = null,
    @SerialName("competitive_fee_cents") val competitiveFeeCents: Long,
    @SerialName("recreational_fee_cents") val recreationalFeeCents: Long,
)

data class StatementPlayer(val status: String?, val isExec: Boolean?, val feeExempt: Boolean?)

/** Competitive pays the competitive price, everybody else the recreational one. */
fun seasonFeeFor(status: String?, season: StatementSeason): Long =
    if (status == "competitive") season.competitiveFeeCents else season.recreationalFeeCents

fun isExempt(player: StatementPlayer): Boolean = player.isExec == true || player.feeExempt == true

data class StatementLines(val lines: List<FeeLine>, val seasonLine: FeeLine?)

/** localeCompare's order: "alpha" before "Beta", which a plain compareTo gets wrong. */
private val nameOrder: Comparator<FeeLine> = compareBy(Collator.getInstance(Locale.ENGLISH)) { it.name }

/**
 * Every line of the statement, in the web's order: this season's dues, then
 * tournament entries and club events by name, then reinstatements. A member
 * with no dues row still owes the season's price, keyed on the season; an
 * exempt member gets no dues line at all.
 */
fun buildStatementLines(
    player: StatementPlayer,
    season: StatementSeason?,
    feeRows: List<OwnFeeRow>,
    tournamentNames: Map<String, String>,
    eventNames: Map<String, String>,
): StatementLines {
    val lines = mutableListOf<FeeLine>()
    var seasonLine: FeeLine? = null

    if (season != null && !isExempt(player)) {
        val clubFee = feeRows.firstOrNull { it.feeType == "dues" && it.seasonId == season.id }
        val settlement = settlementOf(clubFee?.paidAt, clubFee?.method)
        seasonLine = FeeLine(
            key = clubFee?.id ?: "season-${season.id}",
            kind = FeeKind.SEASON,
            name = "${season.name} membership",
            owedCents = if (clubFee?.paidAt != null) clubFee.amountCents else clubFee?.amountCents ?: seasonFeeFor(player.status, season),
            recordedCents = clubFee?.amountCents,
            paid = settlement.paid,
            waived = settlement.waived,
            paidAt = clubFee?.paidAt,
            method = clubFee?.method,
            reference = clubFee?.reference,
        )
        lines.add(seasonLine)
    }

    fun fromRow(fee: OwnFeeRow, kind: FeeKind, name: String): FeeLine {
        val settlement = settlementOf(fee.paidAt, fee.method)
        return FeeLine(
            key = fee.id,
            kind = kind,
            name = name,
            owedCents = fee.amountCents,
            recordedCents = fee.amountCents,
            paid = settlement.paid,
            waived = settlement.waived,
            paidAt = fee.paidAt,
            method = fee.method,
            reference = fee.reference,
        )
    }

    lines += feeRows
        .filter { it.feeType == "tournament" && !it.tournamentId.isNullOrEmpty() }
        .map { fromRow(it, FeeKind.TOURNAMENT, tournamentNames[it.tournamentId.orEmpty()] ?: "Tournament entry") }
        .sortedWith(nameOrder)
    lines += feeRows
        .filter { it.feeType == "event" && !it.clubEventId.isNullOrEmpty() }
        .map { fromRow(it, FeeKind.EVENT, eventNames[it.clubEventId.orEmpty()] ?: "Club event") }
        .sortedWith(nameOrder)
    lines += feeRows
        .filter { it.feeType == "reinstatement" }
        .map { fromRow(it, FeeKind.REINSTATEMENT, "Reinstatement fee") }

    return StatementLines(lines, seasonLine)
}

data class Headline(val amount: String, val label: String)

/** The figure and the word beside it: the web's headlineAmount and headlineBadge. */
fun statementHeadline(s: OutstandingSummary): Headline = Headline(headlineAmount(s), headlineBadge(s).label)

data class Statement(val season: StatementSeason?, val summary: OutstandingSummary)

@Serializable
internal data class TournamentName(val id: String, val name: String = "")

@Serializable
internal data class EventTitle(val id: String, val title: String = "")

suspend fun loadStatement(postgrest: Postgrest, viewer: Viewer): Statement = coroutineScope {
    // RLS says "yours only" on club_fees as well as the explicit filter.
    val feesRead = async {
        postgrest.list(
            PostgrestQuery.select("club_fees", OWN_FEE_COLUMNS)
                .eq("player_id", viewer.id)
                .order("created_at", ascending = false),
            OwnFeeRow.serializer(),
            "your fees",
        )
    }
    val activeRead = async { loadActiveSeason(postgrest) }
    val feeRows = feesRead.await()
    val activeId = activeRead.await()?.id

    // get_active_season() has no end_date, which the statement's season needs.
    val season = activeId?.let {
        postgrest.maybeSingle(
            PostgrestQuery.select("seasons", "id, name, end_date, competitive_fee_cents, recreational_fee_cents")
                .eq("id", it),
            StatementSeason.serializer(),
            "the season",
        )
    }

    val tournamentIds = feeRows.filter { it.feeType == "tournament" }.mapNotNull { it.tournamentId }.distinct()
    val eventIds = feeRows.filter { it.feeType == "event" }.mapNotNull { it.clubEventId }.distinct()
    val tournamentsRead = async {
        if (tournamentIds.isEmpty()) {
            emptyList()
        } else {
            postgrest.list(
                PostgrestQuery.select("tournaments", "id, name").isIn("id", tournamentIds),
                TournamentName.serializer(),
                "tournament names",
            )
        }
    }
    val eventsRead = async {
        if (eventIds.isEmpty()) {
            emptyList()
        } else {
            postgrest.list(
                PostgrestQuery.select("club_events", "id, title").isIn("id", eventIds),
                EventTitle.serializer(),
                "event names",
            )
        }
    }

    val player = StatementPlayer(viewer.status, viewer.isExec, viewer.feeExempt)
    val (lines) = buildStatementLines(
        player = player,
        season = season,
        feeRows = feeRows,
        tournamentNames = tournamentsRead.await().associate { it.id to it.name },
        eventNames = eventsRead.await().associate { it.id to it.title },
    )
    Statement(season, summariseFees(lines, isExempt(player)))
}
