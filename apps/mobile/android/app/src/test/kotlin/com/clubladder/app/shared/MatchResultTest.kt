package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The cases of packages/shared/src/utils/__tests__/match-result.test.ts.
class MatchResultTest {
    private fun g(a: Any, b: Any) = GameScore(a.toString(), b.toString())

    @Test
    fun `counts games won, not points`() {
        assertEquals(MatchTally(2, 1, 'a'), tallyGames(listOf(g(21, 19), g(15, 21), g(21, 10))))
    }

    @Test
    fun `gives the match to the side that took more games even after a blowout loss`() {
        assertEquals('a', tallyGames(listOf(g(21, 19), g(0, 21), g(21, 19))).winner)
    }

    @Test
    fun `ignores unplayed trailing games in a best of three`() {
        assertEquals(MatchTally(2, 0, 'a'), tallyGames(listOf(g(21, 15), g(21, 12), g("", ""))))
    }

    @Test
    fun `returns no winner when nothing has been entered`() {
        assertNull(tallyGames(listOf(g("", ""), g("", ""))).winner)
        assertNull(tallyGames(emptyList()).winner)
    }

    @Test
    fun `returns no winner while the games are level`() {
        assertNull(tallyGames(listOf(g(21, 15), g(18, 21))).winner)
    }

    @Test
    fun `treats a drawn game as won by neither side`() {
        assertEquals(MatchTally(0, 0, null), tallyGames(listOf(g(21, 21))))
    }

    @Test
    fun `accepts string scores from form inputs`() {
        assertEquals('a', tallyGames(listOf(g("21", "15"))).winner)
        assertEquals('b', tallyGames(listOf(g("15", "21"))).winner)
    }

    @Test
    fun `treats junk and blanks as zero`() {
        assertEquals('b', tallyGames(listOf(g("abc", "21"))).winner)
        assertEquals('a', tallyGames(listOf(g(21, ""))).winner)
    }

    @Test
    fun `reads leading digits the way parseInt does`() {
        assertEquals('a', tallyGames(listOf(g("21x", "3"))).winner)
    }
}
