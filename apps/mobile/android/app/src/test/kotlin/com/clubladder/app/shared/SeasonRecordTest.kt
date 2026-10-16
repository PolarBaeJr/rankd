package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Mirrors the settledOutcome and summarizeSeason blocks of
// apps/player/src/lib/__tests__/season-history.test.ts.
class SeasonRecordTest {
    private fun match(
        matchType: String? = "singles",
        resultStatus: String? = "confirmed",
        winFlag: Boolean? = true,
        pointsScored: Int? = 21,
        pointsAllowed: Int? = 17,
        playedAt: String? = "2026-09-10T02:00:00Z",
    ) = SeasonMatchRow(matchType, resultStatus, winFlag, pointsScored, pointsAllowed, playedAt)

    @Test
    fun `counts a confirmed win`() {
        assertEquals(true, settledOutcome(match()))
    }

    @Test
    fun `counts a walkover, which somebody really was awarded`() {
        assertEquals(false, settledOutcome(match(resultStatus = "walkover", winFlag = false)))
    }

    @Test
    fun `refuses a voided match even though its win_flag survived the voiding`() {
        assertNull(settledOutcome(match(resultStatus = "voided", winFlag = true)))
    }

    @Test
    fun `refuses a disputed match`() {
        assertNull(settledOutcome(match(resultStatus = "disputed")))
    }

    @Test
    fun `refuses a confirmed row whose winner was never stamped`() {
        assertNull(settledOutcome(match(winFlag = null)))
    }

    @Test
    fun `splits the record by discipline and adds up to the total`() {
        val r = summarizeSeason(
            listOf(
                match(playedAt = "2026-09-10T02:00:00Z", winFlag = true, matchType = "singles"),
                match(playedAt = "2026-09-11T02:00:00Z", winFlag = false, matchType = "singles"),
                match(playedAt = "2026-09-12T02:00:00Z", winFlag = true, matchType = "doubles"),
            ),
        )
        assertEquals(DisciplineRecord(1, 1, 8, -1, 1), r.singles)
        assertEquals(DisciplineRecord(1, 0, 4, 1, 1), r.doubles)
        assertEquals(2, r.wins)
        assertEquals(1, r.losses)
        assertEquals(r.wins, r.singles.wins + r.doubles.wins)
        assertEquals(3, r.played)
    }

    @Test
    fun `leaves unsettled rows out of played, not just out of the win column`() {
        val r = summarizeSeason(
            listOf(
                match(resultStatus = "confirmed"),
                match(resultStatus = "disputed"),
                match(resultStatus = "pending_confirmation", winFlag = null),
            ),
        )
        assertEquals(1, r.played)
        assertEquals(1, r.wins)
        assertEquals(0, r.losses)
    }

    @Test
    fun `nets the point differential over settled matches only`() {
        val r = summarizeSeason(
            listOf(
                match(pointsScored = 42, pointsAllowed = 30),
                match(pointsScored = 20, pointsAllowed = 42, winFlag = false),
                match(pointsScored = 99, pointsAllowed = 0, resultStatus = "voided"),
            ),
        )
        assertEquals(12 - 22, r.pointDiff)
    }

    @Test
    fun `finds the best win streak in date order, whatever order the rows arrive in`() {
        val r = summarizeSeason(
            listOf(
                match(playedAt = "2026-10-01T02:00:00Z", winFlag = true),
                match(playedAt = "2026-09-01T02:00:00Z", winFlag = true),
                match(playedAt = "2026-09-15T02:00:00Z", winFlag = false),
                match(playedAt = "2026-10-08T02:00:00Z", winFlag = true),
                match(playedAt = "2026-10-15T02:00:00Z", winFlag = true),
            ),
        )
        assertEquals(3, r.bestWinStreak)
    }

    @Test
    fun `does not let a voided match join two win streaks together`() {
        val r = summarizeSeason(
            listOf(
                match(playedAt = "2026-09-01T02:00:00Z", winFlag = true),
                match(playedAt = "2026-09-08T02:00:00Z", winFlag = false, resultStatus = "voided"),
                match(playedAt = "2026-09-15T02:00:00Z", winFlag = true),
            ),
        )
        assertEquals(2, r.bestWinStreak)
    }

    @Test
    fun `counts an undated match toward the record but not toward the streak`() {
        val r = summarizeSeason(listOf(match(playedAt = null, winFlag = true)))
        assertEquals(1, r.played)
        assertEquals(0, r.bestWinStreak)
    }

    @Test
    fun `keeps each discipline its own streak`() {
        val r = summarizeSeason(
            listOf(
                match(playedAt = "2026-09-01T02:00:00Z", matchType = "singles", winFlag = true),
                match(playedAt = "2026-09-08T02:00:00Z", matchType = "doubles", winFlag = false),
                match(playedAt = "2026-09-15T02:00:00Z", matchType = "singles", winFlag = true),
            ),
        )
        assertEquals(1, r.bestWinStreak)
        assertEquals(2, r.singles.bestWinStreak)
        assertEquals(2, r.singles.currentStreak)
        assertEquals(-1, r.doubles.currentStreak)
        assertEquals(0, r.doubles.bestWinStreak)
    }

    @Test
    fun `starts a discipline streak over rather than counting from zero after a loss`() {
        val r = summarizeSeason(
            listOf(
                match(playedAt = "2026-09-01T02:00:00Z", matchType = "singles", winFlag = false),
                match(playedAt = "2026-09-08T02:00:00Z", matchType = "singles", winFlag = true),
            ),
        )
        assertEquals(1, r.singles.currentStreak)
    }

    @Test
    fun `returns an empty record rather than throwing on no rows`() {
        val empty = DisciplineRecord()
        assertEquals(SeasonRecord(empty, empty, 0, 0, 0, 0, 0), summarizeSeason(emptyList()))
    }
}
