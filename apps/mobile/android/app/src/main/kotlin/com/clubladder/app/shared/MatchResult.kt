package com.clubladder.app.shared

// Port of tallyGames in packages/shared/src/utils/match-result.ts. Keep in step
// with it. The winner is derived from the game scores, never asked for.

data class GameScore(val sideA: String, val sideB: String)

data class MatchTally(val aGamesWon: Int, val bGamesWon: Int, val winner: Char?)

private val LEADING_INT = Regex("^\\s*[+-]?\\d+")

/**
 * Games are counted, not points. A drawn game (equal scores, a blank 0-0
 * included) counts for neither side, so an unplayed third game in a best of
 * three simply does not contribute.
 */
fun tallyGames(games: List<GameScore>): MatchTally {
    var a = 0
    var b = 0
    for (g in games) {
        val sa = toScore(g.sideA)
        val sb = toScore(g.sideB)
        if (sa > sb) a++ else if (sb > sa) b++
    }
    val winner = if (a > b) 'a' else if (b > a) 'b' else null
    return MatchTally(a, b, winner)
}

// parseInt semantics: the leading digits count, anything unparseable is 0.
private fun toScore(value: String): Long = LEADING_INT.find(value)?.value?.trim()?.toLongOrNull() ?: 0L
