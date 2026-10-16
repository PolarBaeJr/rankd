package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors apps/player/src/lib/__tests__/feed-tournament.test.ts and the
// countEnteredPlayers cases of tournament-index.test.ts, same inputs and outputs.
class FeedTournamentTest {
    private fun ev(status: String, type: String = "open_singles") = FeedEvent("e-$status-$type", type, status)

    private fun tournament(
        startDate: String = "2026-08-17",
        endDate: String? = "2026-08-17",
        events: List<FeedEvent>? = listOf(ev("live")),
    ) = FeedTournament("t1", "Autumn Open", startDate, endDate, events)

    private val all = listOf("registration", "checkin", "pool_generated", "pool_live", "bracket_generated", "live", "completed")

    @Test
    fun `excludes exactly the two ends of the lifecycle`() {
        assertEquals(listOf("checkin", "pool_generated", "pool_live", "bracket_generated", "live"), all.filter { isRunningEvent(ev(it)) })
        assertFalse(isRunningEvent(ev("registration")))
    }

    @Test
    fun `separates drawn-or-playing from open for check-in`() {
        assertEquals(listOf("pool_generated", "pool_live", "bracket_generated", "live"), all.filter { isPlayingEvent(ev(it)) })
    }

    @Test
    fun `takes the last day from end_date, else start_date, trimmed`() {
        assertEquals("2026-08-17", lastDayOf("2026-08-15", "2026-08-17"))
        assertEquals("2026-08-15", lastDayOf("2026-08-15", null))
        assertEquals("2026-08-17", lastDayOf("2026-08-15", "2026-08-17T00:00:00Z"))
    }

    @Test
    fun `refuses a live event on a tournament that ended last month`() {
        val stale = tournament("2026-07-24", "2026-07-24", listOf(ev("completed", "mens_singles"), ev("completed"), ev("live", "womens_singles")))
        assertTrue(stale.tournamentEvents!!.any(::isRunningEvent))
        assertFalse(isUnderWay(stale, "2026-08-17"))
    }

    @Test
    fun `is under way on the day and through the final day inclusive`() {
        assertTrue(isUnderWay(tournament(), "2026-08-17"))
        val multi = tournament("2026-08-15", "2026-08-17")
        assertTrue(isUnderWay(multi, "2026-08-17"))
        assertFalse(isUnderWay(multi, "2026-08-18"))
        assertTrue(isUnderWay(tournament("2026-08-15", "2026-08-19"), "2026-08-17"))
        val undated = tournament(endDate = null)
        assertTrue(isUnderWay(undated, "2026-08-17"))
        assertFalse(isUnderWay(undated, "2026-08-18"))
    }

    @Test
    fun `needs at least one running event`() {
        assertFalse(isUnderWay(tournament(events = listOf(ev("registration"))), "2026-08-17"))
        assertFalse(isUnderWay(tournament(events = listOf(ev("completed"))), "2026-08-17"))
        assertTrue(isUnderWay(tournament(events = listOf(ev("completed", "mens_singles"), ev("checkin", "mixed_doubles"))), "2026-08-17"))
        assertFalse(isUnderWay(tournament(events = emptyList()), "2026-08-17"))
        assertFalse(isUnderWay(tournament(events = null), "2026-08-17"))
    }

    @Test
    fun `compares day keys as strings across the cutover`() {
        val t = tournament("2026-11-02", "2026-11-02")
        assertTrue(isUnderWay(t, "2026-11-02"))
        assertFalse(isUnderWay(t, "2026-11-03"))
    }

    @Test
    fun `keeps the query order of running events`() {
        val t = tournament(events = listOf(ev("completed", "mens_singles"), ev("live", "womens_singles"), ev("registration"), ev("checkin", "mixed_doubles")))
        assertEquals(listOf("womens_singles", "mixed_doubles"), runningEvents(t).map { it.eventType })
    }

    @Test
    fun `picks the eyebrow by whether anything is drawn`() {
        assertEquals("UNDER WAY", underWayEyebrow(listOf(ev("checkin"), ev("live"))))
        assertEquals("UNDER WAY", underWayEyebrow(listOf(ev("bracket_generated"))))
        assertEquals("UNDER WAY", underWayEyebrow(listOf(ev("pool_live"))))
        assertEquals("CHECK-IN OPEN", underWayEyebrow(listOf(ev("checkin"))))
    }

    @Test
    fun `counts people, not rows`() {
        assertEquals(3, countEnteredPlayers(listOf(EntrantRow("a", "registered")), listOf(EntrantPairRow("b", "c", "registered"))))
        assertEquals(2, countEnteredPlayers(listOf(EntrantRow("a", "registered")), listOf(EntrantPairRow("a", "b", "registered"))))
        assertEquals(
            2,
            countEnteredPlayers(
                listOf(EntrantRow("a", "registered"), EntrantRow("b", "withdrawn"), EntrantRow("c", "disqualified"), EntrantRow("d", "checked_in")),
                listOf(EntrantPairRow("e", "f", "withdrawn")),
            ),
        )
    }
}
