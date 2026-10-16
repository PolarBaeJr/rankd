package com.clubladder.app.data

import com.clubladder.app.shared.SeasonMatchRow
import com.clubladder.app.shared.SeasonRecord
import com.clubladder.app.shared.settledOutcome
import com.clubladder.app.shared.summarizeSeason
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlin.math.roundToInt

// Port of the Expo app's src/lib/my-stats.ts and the formatters from its
// MyStatsScreen.tsx, which mirror the current-season branch of
// apps/player/src/app/my-stats/page.tsx. Keep in step with them. The app reads
// Elo and never computes it, so no rating engine is ported.

/** The match window the web reads: a season and a half of heavy play. */
const val MATCH_WINDOW = 200

/** How many of those get a row in the recent list. */
const val HISTORY_ROWS = 20

/** The web's select, verbatim, so both apps read the same rows. */
const val MY_MATCHES_SELECT =
    "id, season_id, played_at, match_type, format, rated_flag, completed_flag, result_status, score_summary, " +
        "participants:match_participants!inner(id, player_id, win_flag, rating_delta, post_rating, team_side, " +
        "points_scored, points_allowed)"

@Serializable
data class OwnParticipant(
    @SerialName("player_id") val playerId: String? = null,
    @SerialName("win_flag") val winFlag: Boolean? = null,
    @SerialName("rating_delta") val ratingDelta: Double? = null,
    @SerialName("points_scored") val pointsScored: Int? = null,
    @SerialName("points_allowed") val pointsAllowed: Int? = null,
)

@Serializable
data class MyMatchRow(
    val id: String,
    @SerialName("season_id") val seasonId: String? = null,
    @SerialName("played_at") val playedAt: String? = null,
    @SerialName("match_type") val matchType: String? = null,
    @SerialName("result_status") val resultStatus: String? = null,
    @SerialName("score_summary") val scoreSummary: String? = null,
    val participants: JsonElement? = null,
)

/**
 * The member's own participant row, matched on player_id rather than taken as
 * the first element: if the embed filter ever stops narrowing the array, the
 * first element is an OPPONENT and every figure is plausibly wrong.
 */
fun ownParticipant(match: MyMatchRow, playerId: String): OwnParticipant? {
    val rows: List<JsonElement> = when (val raw = match.participants) {
        null, JsonNull -> emptyList()
        is JsonArray -> raw
        is JsonObject -> listOf(raw)
        else -> emptyList()
    }
    return postgrestJson.decodeFromJsonElement(ListSerializer(OwnParticipant.serializer()), JsonArray(rows))
        .firstOrNull { it.playerId == playerId }
}

private fun seasonRowOf(match: MyMatchRow, own: OwnParticipant?) = SeasonMatchRow(
    matchType = match.matchType,
    resultStatus = match.resultStatus,
    winFlag = own?.winFlag,
    pointsScored = own?.pointsScored,
    pointsAllowed = own?.pointsAllowed,
    playedAt = match.playedAt,
)

/** This season's matches only, counted from match rows and never read off `ratings`. */
fun seasonRecordRows(matches: List<MyMatchRow>, activeSeasonId: String?, playerId: String): List<SeasonMatchRow> {
    if (activeSeasonId == null) return emptyList()
    return matches.filter { it.seasonId == activeSeasonId }.map { seasonRowOf(it, ownParticipant(it, playerId)) }
}

/** Math.round semantics: ties go up, so -2.5 is -2. Never kotlin.math.round, which rounds ties to even. */
fun fmtElo(elo: Double?): String = elo?.roundToInt()?.toString() ?: "-"

fun fmtDelta(delta: Double?): String {
    if (delta == null) return ""
    val rounded = delta.roundToInt()
    return if (rounded > 0) "+$rounded" else rounded.toString()
}

data class RecentMatch(
    val id: String,
    val playedAt: String?,
    val type: String?,
    val outcome: Boolean?,
    val delta: Double?,
    val score: String?,
)

data class MyStats(
    val singlesElo: Double?,
    val doublesElo: Double?,
    val position: Int?,
    val seasonName: String?,
    val record: SeasonRecord?,
    val recent: List<RecentMatch>,
)

@Serializable
internal data class RatingRow(
    @SerialName("singles_elo") val singlesElo: Double? = null,
    @SerialName("doubles_elo") val doublesElo: Double? = null,
)

fun myMatchesQuery(playerId: String): PostgrestQuery =
    PostgrestQuery.select("matches", MY_MATCHES_SELECT)
        .eq("participants.player_id", playerId)
        .notIsNull("played_at")
        .order("played_at", ascending = false)
        .limit(MATCH_WINDOW)

suspend fun loadMyStats(postgrest: Postgrest, playerId: String): MyStats = coroutineScope {
    // Explicit columns, and never the *_wins / *_losses counters: those are
    // lifetime figures that survive every season rollover.
    val ratingRead = async {
        postgrest.maybeSingle(
            PostgrestQuery.select("ratings", "singles_elo, doubles_elo").eq("player_id", playerId),
            RatingRow.serializer(),
            "your rating",
        )
    }
    val ladderRead = async { loadLadder(postgrest) }
    val seasonRead = async { loadActiveSeason(postgrest) }
    val matchesRead = async { postgrest.list(myMatchesQuery(playerId), MyMatchRow.serializer(), "your matches") }
    val rating = ratingRead.await()
    val ladder = ladderRead.await()
    val season = seasonRead.await()
    val matches = matchesRead.await()

    val singlesElo = rating?.singlesElo
    MyStats(
        singlesElo = singlesElo,
        doublesElo = rating?.doublesElo,
        position = ladderPosition(ladder, playerId, singlesElo),
        seasonName = season?.name,
        record = season?.let { summarizeSeason(seasonRecordRows(matches, it.id, playerId)) },
        // Same season rule as the website's My stats: a match from an earlier or
        // hidden season (the retired test season) never shows under this one.
        recent = matches.filter { season != null && it.seasonId == season.id }.take(HISTORY_ROWS).map { m ->
            val own = ownParticipant(m, playerId)
            RecentMatch(
                id = m.id,
                playedAt = m.playedAt,
                type = m.matchType,
                outcome = settledOutcome(seasonRowOf(m, own)),
                delta = own?.ratingDelta,
                score = m.scoreSummary,
            )
        },
    )
}
