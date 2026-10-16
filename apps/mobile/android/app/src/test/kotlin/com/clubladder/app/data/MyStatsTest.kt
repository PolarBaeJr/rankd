package com.clubladder.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MyStatsTest {
    private fun match(json: String): MyMatchRow = postgrestJson.decodeFromString(MyMatchRow.serializer(), json)

    @Test
    fun `takes the member's own participant even when an opponent is listed first`() {
        val m = match(
            """{"id":"m1","participants":[
                {"player_id":"them","win_flag":true,"rating_delta":12.0},
                {"player_id":"me","win_flag":false,"rating_delta":-12.0}]}""",
        )
        val own = ownParticipant(m, "me")
        assertEquals("me", own?.playerId)
        assertEquals(false, own?.winFlag)
    }

    @Test
    fun `reads a single-object embed`() {
        val m = match("""{"id":"m1","participants":{"player_id":"me","win_flag":true}}""")
        assertEquals(true, ownParticipant(m, "me")?.winFlag)
    }

    @Test
    fun `has no season record without an active season`() {
        val m = match("""{"id":"m1","season_id":"s1","participants":[{"player_id":"me","win_flag":true}]}""")
        assertTrue(seasonRecordRows(listOf(m), null, "me").isEmpty())
    }

    @Test
    fun `counts only this season's matches`() {
        val rows = seasonRecordRows(
            listOf(
                match("""{"id":"a","season_id":"s1","result_status":"confirmed","participants":[{"player_id":"me","win_flag":true}]}"""),
                match("""{"id":"b","season_id":"s0","result_status":"confirmed","participants":[{"player_id":"me","win_flag":true}]}"""),
            ),
            "s1",
            "me",
        )
        assertEquals(1, rows.size)
        assertEquals(true, rows[0].winFlag)
    }

    // Math.round rounds a tie up; kotlin.math.round would give -2 and 2.
    @Test
    fun `rounds a rating change the way Math round does`() {
        assertEquals("+3", fmtDelta(2.5))
        assertEquals("-2", fmtDelta(-2.5))
        assertEquals("0", fmtDelta(0.4))
        assertEquals("0", fmtDelta(-0.4))
        assertEquals("", fmtDelta(null))
    }

    @Test
    fun `formats a rating, or a dash with none`() {
        assertEquals("1001", fmtElo(1000.5))
        assertEquals("-", fmtElo(null))
    }

    @Test
    fun `reads the web's match select without its whitespace`() {
        assertEquals(
            "select=id%2Cseason_id%2Cplayed_at%2Cmatch_type%2Cformat%2Crated_flag%2Ccompleted_flag%2Cresult_status%2C" +
                "score_summary%2Cparticipants%3Amatch_participants%21inner%28id%2Cplayer_id%2Cwin_flag%2Crating_delta%2C" +
                "post_rating%2Cteam_side%2Cpoints_scored%2Cpoints_allowed%29" +
                "&participants.player_id=eq.p1&played_at=not.is.null&order=played_at.desc&limit=200",
            myMatchesQuery("p1").pathAndQuery().substringAfter('?'),
        )
    }

    @Test
    fun `ignores the select's columns the app does not read`() {
        val m = match("""{"id":"m1","format":"x","rated_flag":true,"participants":[]}""")
        assertEquals("m1", m.id)
    }
}
