package com.clubladder.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLDecoder

// Mirrors apps/player/src/lib/__tests__/home-schedule-query.test.ts and
// feed-tournament-query.test.ts, and pins the Feed's other reads to the selects
// in apps/player/src/app/feed/page.tsx.
class FeedQueryTest {
    private val season = "11111111-1111-4111-8111-111111111111"
    private val player = "22222222-2222-4222-8222-222222222222"
    private val verifiedTournaments = listOf("id", "name", "start_date", "end_date", "status", "suspended_at", "season_id")
    private val verifiedEvents = listOf("id", "tournament_id", "event_type", "status")

    private fun params(q: PostgrestQuery): List<Pair<String, String>> =
        q.pathAndQuery().substringAfter('?', "").split('&').filter { it.isNotEmpty() }.map {
            val (k, v) = it.split('=', limit = 2)
            URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
        }

    private fun get(q: PostgrestQuery, key: String) = params(q).filter { it.first == key }.map { it.second }
    private fun one(q: PostgrestQuery, key: String) = get(q, key).single()

    @Test
    fun `reads the club events by calendar columns, published or cancelled`() {
        val q = clubEventsQuery("2026-09-01T07:00:00.000Z")
        assertTrue(q.pathAndQuery().startsWith("/rest/v1/club_events?"))
        assertEquals("id,title,kind,location,starts_at,ends_at,status", one(q, "select"))
        assertEquals("in.(published,cancelled)", one(q, "status"))
        assertEquals("gte.2026-09-01T07:00:00.000Z", one(q, "starts_at"))
        assertEquals("starts_at.asc", one(q, "order"))
        assertEquals("200", one(q, "limit"))
    }

    @Test
    fun `reads calendar tournaments without drafts or free text`() {
        val q = calendarTournamentsQuery(season)
        val select = one(q, "select")
        assertEquals("in.(active,completed)", one(q, "status"))
        assertEquals("(season_id.eq.$season,season_id.is.null)", one(q, "or"))
        assertFalse(select.contains("*") || select.contains("notes") || select.contains("suspension_reason"))
        for (col in select.split(",")) assertTrue(col, col in verifiedTournaments)
    }

    @Test
    fun `selects exactly what the week strip needs`() {
        val q = calendarSessionsQuery(season, "competitive")
        assertEquals("id,name,date,start_time,status,season_id", one(q, "select"))
        assertEquals("(season_id.eq.$season,season_id.is.null)", one(q, "or"))
        assertEquals("in.(competitive,all)", one(q, "track"))
        assertTrue(get(q, "status").isEmpty())
    }

    @Test
    fun `reads every column of the open sessions, season-scoped and track-filtered`() {
        assertEquals(
            "/rest/v1/sessions?select=%2A&status=eq.open&or=%28season_id.eq.$season%2Cseason_id.is.null%29" +
                "&track=in.%28competitive%2Call%29&order=date.asc%2Cstart_time.asc.nullslast",
            openSessionsQuery(season, "competitive").pathAndQuery(),
        )
        assertTrue(get(openSessionsQuery(null, "competitive"), "or").isEmpty())
        assertEquals("in.(competitive,recreational,all)", one(openSessionsQuery(null, "pending_approval"), "track"))
    }

    @Test
    fun `reads only this member's sign-ups, attendance and RSVPs`() {
        assertEquals("/rest/v1/club_event_signups?select=event_id&player_id=eq.$player", mySignupsQuery(player).pathAndQuery())
        assertEquals("/rest/v1/session_attendance?select=session_id%2Cstatus&player_id=eq.$player", myAttendanceQuery(player).pathAndQuery())
        assertEquals("/rest/v1/session_rsvp?select=session_id%2Cintent&player_id=eq.$player", myRsvpQuery(player).pathAndQuery())
    }

    @Test
    fun `pages the going counts in session order`() {
        val q = goingQuery(listOf("a", "b"), 500)
        assertEquals(
            "/rest/v1/session_rsvp?select=session_id&session_id=in.%28a%2Cb%29&intent=eq.going&order=session_id.asc&offset=500&limit=500",
            q.pathAndQuery(),
        )
    }

    @Test
    fun `asks for checked-in counts through the aggregate RPC`() {
        val q = attendeeCountsRpc(listOf("a", "b"))
        assertEquals("POST", q.method)
        assertEquals("/rest/v1/rpc/get_session_attendee_counts", q.pathAndQuery())
        assertEquals("{\"p_session_ids\":[\"a\",\"b\"]}", q.body)
    }

    @Test
    fun `reads the settings rows by key`() {
        assertEquals("/rest/v1/platform_settings?select=value&key=eq.features", featureFlagsQuery().pathAndQuery())
        assertEquals("/rest/v1/platform_settings?select=value&key=eq.session_attendance", checkinSettingsQuery().pathAndQuery())
        assertEquals(
            "/rest/v1/seasons?select=id%2Cname%2Cstart_date%2Cend_date&active_flag=eq.true",
            activeSeasonRowQuery().pathAndQuery(),
        )
    }

    @Test
    fun `counts the streak through past sessions on the member's tracks`() {
        assertEquals(
            "/rest/v1/sessions?select=id%2Cdate&date=lt.2026-10-14&or=%28season_id.eq.$season%2Cseason_id.is.null%29" +
                "&track=in.%28recreational%2Call%29&order=date.desc&limit=20",
            streakSessionsQuery("2026-10-14", season, "recreational").pathAndQuery(),
        )
    }

    @Test
    fun `applies expiry and season as two separate or params`() {
        val q = announcementsQuery("2026-08-11T00:00:00.000Z", "season-1")
        assertEquals("id,title,body,created_at,target_audience,author:players(full_name)", one(q, "select"))
        assertEquals("eq.published", one(q, "status"))
        assertEquals(
            listOf("(expires_at.is.null,expires_at.gt.2026-08-11T00:00:00.000Z)", "(all_seasons.eq.true,season_id.eq.season-1)"),
            get(q, "or"),
        )
        assertEquals("pinned.desc,created_at.desc", one(q, "order"))
        assertEquals("3", one(q, "limit"))
        val noSeason = announcementsQuery("2026-08-11T00:00:00.000Z", null)
        assertEquals(1, get(noSeason, "or").size)
        assertFalse(noSeason.pathAndQuery().contains("all_seasons"))
    }

    @Test
    fun `reads the river with players' public columns only`() {
        val q = riverQuery(season)
        assertEquals(
            "id,played_at,match_type,format,score_summary,match_participants(team_side,win_flag,rating_delta,post_rating," +
                "player:players(id,full_name,handle,avatar_url))",
            one(q, "select"),
        )
        assertEquals("eq.confirmed", one(q, "result_status"))
        assertEquals("not.is.null", one(q, "played_at"))
        assertEquals("(season_id.eq.$season,season_id.is.null)", one(q, "or"))
        assertEquals("played_at.desc", one(q, "order"))
        assertEquals("15", one(q, "limit"))
        assertFalse(one(q, "select").contains("status"))
    }

    @Test
    fun `reads pending challenges with the creator by its named key`() {
        val q = pendingChallengesQuery(player)
        assertEquals(
            "id,challenge:challenges(id,type,format,created_at,creator:players!challenges_created_by_fkey(id,full_name,handle,avatar_url))",
            one(q, "select"),
        )
        assertEquals("eq.$player", one(q, "player_id"))
        assertEquals("eq.pending", one(q, "confirmation_status"))
        assertEquals("5", one(q, "limit"))
    }

    @Test
    fun `reads live tournaments by verified columns only`() {
        val q = liveTournamentsQuery(season)
        assertEquals("id,name,start_date,end_date,tournament_events(id,event_type,status)", one(q, "select"))
        assertEquals("eq.active", one(q, "status"))
        assertEquals("is.null", one(q, "suspended_at"))
        assertEquals("(season_id.eq.$season,season_id.is.null)", one(q, "or"))
        assertEquals("start_date.asc", one(q, "order"))
        val select = one(q, "select")
        for (col in select.substringBefore(",tournament_events").split(",")) assertTrue(col, col in verifiedTournaments)
        for (col in select.substringAfter("tournament_events(").removeSuffix(")").split(",")) assertTrue(col, col in verifiedEvents)
        assertTrue(get(liveTournamentsQuery(null), "or").isEmpty())
    }

    @Test
    fun `reads both entry tables for the running events`() {
        assertEquals(
            "/rest/v1/tournament_participants?select=event_id%2Cplayer_id%2Cstatus&event_id=in.%28ea%2Ceb%29",
            entryParticipantsQuery(listOf("ea", "eb")).pathAndQuery(),
        )
        assertEquals(
            "/rest/v1/tournament_pairs?select=event_id%2Cplayer1_id%2Cplayer2_id%2Cstatus&event_id=in.%28ea%2Ceb%29",
            entryPairsQuery(listOf("ea", "eb")).pathAndQuery(),
        )
    }

    @Test
    fun `reads the member's own rating row`() {
        assertEquals(
            "singles_elo,doubles_elo,singles_wins,singles_losses,doubles_wins,doubles_losses,singles_provisional,doubles_provisional",
            one(ownRatingQuery(player), "select"),
        )
        assertEquals("eq.$player", one(ownRatingQuery(player), "player_id"))
    }

    @Test
    fun `starts the club events window at the term's first club midnight`() {
        assertEquals("2026-09-01T07:00:00.000Z", clubEventsLowerBound(FeedSeasonRow("s", "Fall", "2026-09-01", null), "2026-10-14"))
        assertEquals("2026-11-01T07:00:00.000Z", clubEventsLowerBound(null, "2026-12-31"))
    }
}
