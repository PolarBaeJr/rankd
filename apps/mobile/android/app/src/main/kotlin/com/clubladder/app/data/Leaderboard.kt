package com.clubladder.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Port of the Expo app's src/lib/leaderboard.ts, which mirrors the web's tab
// filter and Elo sort (apps/player/src/app/leaderboard/leaderboard-client.tsx).
// Keep in step with it. The tournament points tab and win-rate sort are not here.

enum class LeaderboardTab(val label: String) {
    OPEN_SINGLES("Open S."),
    OPEN_DOUBLES("Open D."),
    COMP_SINGLES("Comp S."),
    COMP_DOUBLES("Comp D."),
    ;

    val isDoubles: Boolean get() = this == OPEN_DOUBLES || this == COMP_DOUBLES
    val isCompetitive: Boolean get() = this == COMP_SINGLES || this == COMP_DOUBLES
}

/** One get_leaderboard() row, narrowed to what the list draws. */
@Serializable
data class LadderRow(
    val id: String,
    val name: String = "",
    val handle: String? = null,
    val status: String = "",
    @SerialName("singles_elo") val singlesElo: Double? = null,
    @SerialName("doubles_elo") val doublesElo: Double? = null,
)

data class RankedRow(val row: LadderRow, val rank: Int, val elo: Double)

/**
 * The tab's ladder, ordered and numbered by POSITION, as the web list is: tied
 * members get consecutive numbers in the order the stable sort leaves them.
 */
fun rankLadder(rows: List<LadderRow>, tab: LeaderboardTab): List<RankedRow> {
    fun eloOf(r: LadderRow) = (if (tab.isDoubles) r.doublesElo else r.singlesElo) ?: 0.0
    val filtered = if (tab.isCompetitive) rows.filter { it.status == "competitive" } else rows
    return filtered
        .sortedByDescending { eloOf(it) }
        .mapIndexed { i, row -> RankedRow(row, i + 1, eloOf(row)) }
}

/**
 * The member's place on the Open Singles ladder as the web's My stats counts
 * it: RANK(), 1 + the members strictly above. Null, never last place, when the
 * member is not in the RPC's rows at all or has no rating.
 */
fun ladderPosition(rows: List<LadderRow>, playerId: String, mySinglesElo: Double?): Int? {
    if (mySinglesElo == null) return null
    if (rows.none { it.id == playerId }) return null
    return 1 + rows.count { (it.singlesElo ?: 0.0) > mySinglesElo }
}

/** get_leaderboard() is the database's own filtered ladder: hidden, pending and suspended are left out. */
suspend fun loadLadder(postgrest: Postgrest): List<LadderRow> =
    postgrest.list(PostgrestQuery.rpc("get_leaderboard"), LadderRow.serializer(), "the ladder")
