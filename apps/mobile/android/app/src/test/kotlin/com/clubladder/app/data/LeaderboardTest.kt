package com.clubladder.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Mirrors the Expo app's src/__tests__/leaderboard.test.ts.
class LeaderboardTest {
    private fun row(id: String, status: String, singles: Double?, doubles: Double?) =
        LadderRow(id = id, name = id, handle = null, status = status, singlesElo = singles, doublesElo = doubles)

    private val rows = listOf(
        row("a", "recreational", 900.0, 1200.0),
        row("b", "competitive", 1100.0, 1000.0),
        row("c", "competitive", 1000.0, 1300.0),
        row("d", "pending_approval", 1200.0, 900.0),
    )

    @Test
    fun `has the four web tabs, without tournament points`() {
        assertEquals(listOf("Open S.", "Open D.", "Comp S.", "Comp D."), LeaderboardTab.entries.map { it.label })
    }

    @Test
    fun `open singles keeps everyone, highest singles Elo first`() {
        assertEquals(
            listOf(Triple("d", 1, 1200.0), Triple("b", 2, 1100.0), Triple("c", 3, 1000.0), Triple("a", 4, 900.0)),
            rankLadder(rows, LeaderboardTab.OPEN_SINGLES).map { Triple(it.row.id, it.rank, it.elo) },
        )
    }

    @Test
    fun `open doubles sorts by doubles Elo`() {
        assertEquals(listOf("c", "a", "b", "d"), rankLadder(rows, LeaderboardTab.OPEN_DOUBLES).map { it.row.id })
    }

    @Test
    fun `comp tabs keep only competitive members`() {
        assertEquals(listOf("b", "c"), rankLadder(rows, LeaderboardTab.COMP_SINGLES).map { it.row.id })
        assertEquals(
            listOf("c" to 1, "b" to 2),
            rankLadder(rows, LeaderboardTab.COMP_DOUBLES).map { it.row.id to it.rank },
        )
    }

    @Test
    fun `numbers tied members by position, in the order they arrived`() {
        val tied = listOf(
            row("x", "competitive", 400.0, 400.0),
            row("y", "competitive", 400.0, 400.0),
            row("z", "competitive", 500.0, 400.0),
        )
        assertEquals(
            listOf("z" to 1, "x" to 2, "y" to 3),
            rankLadder(tied, LeaderboardTab.OPEN_SINGLES).map { it.row.id to it.rank },
        )
    }

    @Test
    fun `reads a missing Elo as zero rather than throwing`() {
        val ranked = rankLadder(listOf(row("n", "competitive", null, null), row("m", "competitive", 1.0, 1.0)), LeaderboardTab.OPEN_SINGLES)
        assertEquals("n", ranked[1].row.id)
    }

    private val ladder = listOf(
        row("a", "competitive", 500.0, null),
        row("b", "competitive", 400.0, null),
        row("c", "competitive", 400.0, null),
        row("d", "competitive", 400.0, null),
        row("e", "competitive", 300.0, null),
    )

    @Test
    fun `tied members share a place`() {
        assertEquals(2, ladderPosition(ladder, "b", 400.0))
        assertEquals(2, ladderPosition(ladder, "d", 400.0))
    }

    @Test
    fun `the member below a tie skips the tied places`() {
        assertEquals(5, ladderPosition(ladder, "e", 300.0))
    }

    @Test
    fun `the leader is first`() {
        assertEquals(1, ladderPosition(ladder, "a", 500.0))
    }

    @Test
    fun `is null, not last place, for a member the RPC left out`() {
        assertNull(ladderPosition(ladder, "hidden", 450.0))
    }

    @Test
    fun `is null with no rating`() {
        assertNull(ladderPosition(ladder, "a", null))
    }

    @Test
    fun `decodes an explicit null into a field with a default`() {
        val row = postgrestJson.decodeFromString(
            LadderRow.serializer(),
            """{"id":"a","name":null,"handle":null,"status":"competitive","singles_elo":null,"doubles_elo":1000}""",
        )
        assertEquals("", row.name)
        assertNull(row.singlesElo)
    }
}
