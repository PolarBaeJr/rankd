package com.clubladder.app.shared

// Port of packages/shared/src/utils/season-record.ts. Keep in step with it.
// The record a member posted in one season, counted from that season's own
// match rows and never read off `ratings`, whose counters are lifetime figures.

val SETTLED_RESULT_STATUSES: List<String> = listOf("confirmed", "walkover")

/** One of the member's matches in a season, reduced to what the tallies read. */
data class SeasonMatchRow(
    val matchType: String?,
    val resultStatus: String?,
    val winFlag: Boolean?,
    val pointsScored: Int?,
    val pointsAllowed: Int?,
    val playedAt: String?,
)

/** True or false for a settled win or loss; null when there is no result to count. */
fun settledOutcome(row: SeasonMatchRow): Boolean? {
    val status = row.resultStatus ?: return null
    if (status !in SETTLED_RESULT_STATUSES) return null
    return row.winFlag
}

data class DisciplineRecord(
    val wins: Int = 0,
    val losses: Int = 0,
    val pointDiff: Int = 0,
    /** Positive is a run of wins, negative a run of losses, zero nothing yet. */
    val currentStreak: Int = 0,
    val bestWinStreak: Int = 0,
)

data class SeasonRecord(
    val singles: DisciplineRecord,
    val doubles: DisciplineRecord,
    val wins: Int,
    val losses: Int,
    /** Settled matches, not rows. */
    val played: Int,
    val pointDiff: Int,
    val bestWinStreak: Int,
)

private class Tally {
    var wins = 0
    var losses = 0
    var pointDiff = 0
    var currentStreak = 0
    var bestWinStreak = 0

    fun toRecord() = DisciplineRecord(wins, losses, pointDiff, currentStreak, bestWinStreak)
}

/**
 * The member's record for one season. Rows may arrive in any order; the streak
 * sorts by played_at itself, and an undated row counts toward the record but
 * not toward any streak.
 */
fun summarizeSeason(rows: List<SeasonMatchRow>): SeasonRecord {
    val singles = Tally()
    val doubles = Tally()
    var wins = 0
    var losses = 0
    var played = 0
    var pointDiff = 0
    var bestWinStreak = 0

    for (row in rows) {
        val won = settledOutcome(row) ?: continue
        played += 1
        if (won) wins += 1 else losses += 1
        val diff = (row.pointsScored ?: 0) - (row.pointsAllowed ?: 0)
        pointDiff += diff
        // Anything that is not singles counts as doubles, so the halves add up.
        val bucket = if (row.matchType == "singles") singles else doubles
        if (won) bucket.wins += 1 else bucket.losses += 1
        bucket.pointDiff += diff
    }

    var run = 0
    // ISO 8601 sorts as a plain string; sortedBy is stable, as Array.sort is.
    val dated = rows.filter { it.playedAt != null }.sortedBy { it.playedAt }
    for (row in dated) {
        val won = settledOutcome(row) ?: continue
        run = if (won) run + 1 else 0
        if (run > bestWinStreak) bestWinStreak = run

        val bucket = if (row.matchType == "singles") singles else doubles
        bucket.currentStreak = if (won) maxOf(bucket.currentStreak, 0) + 1 else minOf(bucket.currentStreak, 0) - 1
        if (bucket.currentStreak > bucket.bestWinStreak) bucket.bestWinStreak = bucket.currentStreak
    }

    return SeasonRecord(
        singles = singles.toRecord(),
        doubles = doubles.toRecord(),
        wins = wins,
        losses = losses,
        played = played,
        pointDiff = pointDiff,
        bestWinStreak = bestWinStreak,
    )
}
