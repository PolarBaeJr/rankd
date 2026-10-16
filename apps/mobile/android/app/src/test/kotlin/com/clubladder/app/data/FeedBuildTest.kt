package com.clubladder.app.data

import com.clubladder.app.auth.GoTrueApi
import com.clubladder.app.auth.MemorySessionStore
import com.clubladder.app.auth.SessionManager
import com.clubladder.app.auth.StoredSession
import com.clubladder.app.config.SupabaseConfig
import com.clubladder.app.net.FakeTransport
import com.clubladder.app.net.HttpRequest
import com.clubladder.app.net.HttpResponse
import com.clubladder.app.net.ok
import com.clubladder.app.net.status
import com.clubladder.app.shared.CalendarClubEventRow
import com.clubladder.app.shared.CalendarTournamentRow
import com.clubladder.app.shared.CheckinSettings
import com.clubladder.app.shared.DEFAULT_FEATURE_FLAGS
import com.clubladder.app.shared.FeedEvent
import com.clubladder.app.shared.FeedTournament
import com.clubladder.app.shared.PaymentPrompt
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

// The Feed's derivations, pinned against apps/player/src/app/feed/page.tsx.
@OptIn(ExperimentalCoroutinesApi::class)
class FeedBuildTest {
    // 12:00 club time on Wednesday 14 October 2026.
    private val now = Instant.parse("2026-10-14T19:00:00Z")
    private val viewer = Viewer("me", "Rowan Tessaly", "recreational", false, false, null, null, null, null, eligibilityFlag = false)
    private val season = FeedSeasonRow("s1", "Fall 2026", "2026-09-07", "2026-12-10")

    private fun inputs(
        season: FeedSeasonRow? = this.season,
        flags: Map<String, Boolean> = DEFAULT_FEATURE_FLAGS,
        openSessions: List<OpenSessionRow>? = emptyList(),
        clubEvents: List<CalendarClubEventRow>? = emptyList(),
        tournaments: List<CalendarTournamentRow>? = emptyList(),
        attendance: Map<String, String?> = emptyMap(),
        intents: Map<String, String?> = emptyMap(),
        announcements: List<FeedAnnouncementRow> = emptyList(),
        river: List<RiverMatchRow> = emptyList(),
        live: List<FeedTournament> = emptyList(),
        participants: List<EntryParticipantRow> = emptyList(),
        pairs: List<EntryPairRow> = emptyList(),
        prompt: PaymentPrompt = PaymentPrompt.None,
        going: Map<String, Int> = emptyMap(),
    ) = FeedInputs(
        season, flags, CheckinSettings(60.0, 30.0), openSessions, emptyList(), clubEvents, tournaments,
        attendance, intents, emptySet(), emptyList(), announcements, river, emptyList(), live, participants, pairs,
        emptyMap(), going, null, prompt,
    )

    private fun session(id: String, date: String, start: String? = "18:00:00", end: String? = "20:00:00", track: String = "all") =
        OpenSessionRow(id, "Ladder Night", date, start, end, "open", null, null, "West Gym", null, track)

    private fun feed(i: FeedInputs = inputs(), v: Viewer = viewer) = buildFeed(i, v, now)

    @Test
    fun `heads the page with the season and its week`() {
        assertEquals("FALL 2026 \u00B7 WEEK 6", feed().eyebrow)
        assertEquals("THE CLUB", feed(inputs(season = null)).eyebrow)
    }

    @Test
    fun `says which of the three empty schedules it is`() {
        assertEquals("No sessions yet", feed().empty?.title)
        assertTrue(feed().empty!!.hint.startsWith("Nothing has been posted for Fall 2026 yet."))
        assertEquals("No season is running", feed(inputs(season = null)).empty?.title)
        val off = DEFAULT_FEATURE_FLAGS + ("sessions" to false)
        assertEquals("Nothing coming up", feed(inputs(flags = off)).empty?.title)
        assertEquals("Nothing on the calendar.", feed().upNextSub)
    }

    @Test
    fun `reports a failed sessions read instead of an empty schedule`() {
        val f = feed(inputs(openSessions = null))
        assertTrue(f.scheduleError)
        assertNull(f.empty)
    }

    @Test
    fun `folds after two weeks but always shows three dates`() {
        val spread = listOf("2026-10-15", "2026-10-20", "2026-10-27", "2026-10-29", "2026-11-05").mapIndexed { i, d -> session("s$i", d) }
        val f = feed(inputs(openSessions = spread))
        assertEquals(listOf("2026-10-15", "2026-10-20", "2026-10-27"), f.agendaSoon.map { it.dateISO })
        assertEquals(listOf("2026-10-29", "2026-11-05"), f.agendaLater.map { it.dateISO })

        val sparse = listOf("2026-10-15", "2026-11-20", "2026-12-01", "2026-12-08").mapIndexed { i, d -> session("s$i", d) }
        val g = feed(inputs(openSessions = sparse))
        assertEquals(3, g.agendaSoon.size)
        assertEquals(1, g.agendaLater.size)
    }

    @Test
    fun `counts what is coming up, singular and plural`() {
        val one = feed(inputs(openSessions = listOf(session("a", "2026-10-15")), intents = mapOf("a" to "going")))
        assertEquals("1 session coming up \u00B7 you're in for 1.", one.upNextSub)
        val event = CalendarClubEventRow("e1", "Board Game Night", "social", "Lounge", "2026-10-16T02:00:00Z", null, "published")
        val two = feed(inputs(openSessions = listOf(session("a", "2026-10-15"), session("b", "2026-10-16")), clubEvents = listOf(event, event.copy(id = "e2"))))
        assertEquals("2 sessions coming up \u00B7 2 club events.", two.upNextSub)
    }

    @Test
    fun `labels the check-in window of a night still ahead`() {
        val f = feed(inputs(openSessions = listOf(session("a", "2026-10-14"), session("b", "2026-10-14", start = "10:00:00", end = "11:00:00"))))
        val rows = f.agendaSoon.single().rows.filterIsInstance<FeedAgendaRow.Session>()
        assertEquals(listOf("a"), rows.map { it.id })
        assertEquals("Opens at 5:30 PM", rows.single().windowLabel)
        assertEquals("6:00 PM to 8:00 PM", rows.single().timeLabel)
        assertTrue(rows.single().isNext)
        assertFalse(rows.single().canScan)
    }

    @Test
    fun `offers the scan inside the window and hides the label`() {
        val atDoor = Instant.parse("2026-10-15T01:10:00Z")
        val f = buildFeed(inputs(openSessions = listOf(session("a", "2026-10-14"))), viewer, atDoor)
        val row = f.agendaSoon.single().rows.single() as FeedAgendaRow.Session
        assertTrue(row.canScan)
        assertNull(row.windowLabel)
        val pending = buildFeed(inputs(openSessions = listOf(session("a", "2026-10-14"))), viewer.copy(status = "pending_approval"), atDoor)
        assertFalse((pending.agendaSoon.single().rows.single() as FeedAgendaRow.Session).canScan)
        val checkedIn = buildFeed(inputs(openSessions = listOf(session("a", "2026-10-14")), attendance = mapOf("a" to "checked_in")), viewer, atDoor)
        val done = checkedIn.agendaSoon.single().rows.single() as FeedAgendaRow.Session
        assertFalse(done.canScan)
        assertEquals("Checked In", done.stateChip)
    }

    @Test
    fun `writes a time range, a start alone, or Time TBC`() {
        fun time(start: String?, end: String?) =
            (feed(inputs(openSessions = listOf(session("a", "2026-10-15", start = start, end = end)))).agendaSoon.single().rows.single() as FeedAgendaRow.Session).timeLabel
        assertEquals("6:00 PM to 8:30 PM", time("18:00:00", "20:30:00"))
        assertEquals("6:00 PM", time("18:00:00", null))
        assertEquals("Time TBC", time(null, null))
    }

    @Test
    fun `says Time TBC and tags another track`() {
        val f = feed(inputs(openSessions = listOf(session("a", "2026-10-15", start = null, end = null, track = "recreational"))))
        val row = f.agendaSoon.single().rows.single() as FeedAgendaRow.Session
        assertEquals("Time TBC", row.timeLabel)
        assertEquals("RECREATIONAL", row.trackTag)
    }

    private fun person(id: String, name: String) =
        """{"id":"$id","full_name":"$name","handle":null,"avatar_url":null}"""

    private fun match(id: String, winner: String, loser: String, delta: Int, rating: Int): RiverMatchRow {
        val json = """{"id":"$id","played_at":"2026-10-14T03:00:00Z","match_type":"singles","format":"bo3_21","score_summary":null,
            "match_participants":[
              {"team_side":"a","win_flag":true,"rating_delta":$delta,"post_rating":$rating,"player":${person(winner, winner.uppercase())}},
              {"team_side":"b","win_flag":false,"rating_delta":${-delta},"post_rating":${rating - 30},"player":[${person(loser, loser.uppercase())}]}]}"""
        return postgrestJson.decodeFromString(RiverMatchRow.serializer(), json)
    }

    @Test
    fun `shows rating figures on the reader's own rows only`() {
        val f = feed(inputs(river = listOf(match("m1", "me", "x", 14, 1017), match("m2", "y", "x", 9, 1100))))
        val rows = f.river.flatMap { it.items }
        val mine = rows.single { it.key == "match-m1" }
        assertEquals("You beat X", mine.sentence)
        assertEquals("+14", mine.delta)
        assertEquals("1017", mine.rating)
        assertEquals(FeedLink.MyStats, mine.link)
        assertEquals("Singles \u00B7 Best of 3 to 21 \u00B7 16h ago", mine.meta)
        val theirs = rows.single { it.key == "match-m2" }
        assertEquals("Y beat X", theirs.sentence)
        assertNull(theirs.delta)
        assertNull(theirs.rating)
        assertEquals(FeedLink.Web("/leaderboard/y"), theirs.link)
        assertEquals("End of week 6", f.riverEnd)
    }

    private val tournament = FeedTournament("t1", "Autumn Open", "2026-10-14", "2026-10-14", listOf(FeedEvent("e1", "open_singles", "live"), FeedEvent("e2", "mixed_doubles", "checkin")))

    @Test
    fun `tells a member who is not entered that the draws are open to watch`() {
        val card = feed(inputs(live = listOf(tournament), participants = listOf(EntryParticipantRow("e1", "x", "registered")))).liveTournaments.single()
        assertEquals("UNDER WAY", card.eyebrow)
        assertEquals("TODAY \u00B7 1 PLAYER", card.meta)
        assertEquals("2 events are on now. You are not entered. The draws are open to watch.", card.notEntered)
        assertTrue(card.entries.isEmpty())
    }

    @Test
    fun `lists the member's own events with their check-in`() {
        val card = feed(
            inputs(
                live = listOf(tournament),
                participants = listOf(EntryParticipantRow("e1", "me", "checked_in")),
                pairs = listOf(EntryPairRow("e2", "x", "me", "registered")),
            ),
        ).liveTournaments.single()
        assertNull(card.notEntered)
        assertEquals(listOf("Open Singles" to true, "Mixed Doubles" to false), card.entries.map { it.eventLabel to it.checkedIn })
        assertEquals("TODAY \u00B7 2 PLAYERS", card.meta)
        assertEquals(FeedLink.Web("/tournaments/t1/events/e1"), card.entries[0].link)
    }

    @Test
    fun `picks the first notice addressed to the member`() {
        val rows = listOf(
            FeedAnnouncementRow("a1", "For competitive", "x", "2026-10-14T18:00:00Z", "competitive"),
            FeedAnnouncementRow("a2", "Courts moved", "**Courts** moved to *West*", "2026-10-14T17:00:00Z", "all", postgrestJson.parseToJsonElement("""{"full_name":"Idris Varga"}""")),
        )
        val notice = feed(inputs(announcements = rows)).notice!!
        assertEquals("Courts moved", notice.title)
        assertEquals("Courts moved to West", notice.body)
        assertEquals("Posted by Idris Varga \u00B7 2h ago", notice.meta)
        assertNull(feed(inputs(announcements = rows, flags = DEFAULT_FEATURE_FLAGS + ("announcements" to false))).notice)
    }

    @Test
    fun `explains a pending account and shows the banner only when approved`() {
        val owing = PaymentPrompt.Owing(4000, 0, 1)
        val pending = feed(inputs(prompt = owing), viewer.copy(status = "pending_approval"))
        assertEquals("Waiting on approval", pending.standing?.title)
        assertNull(pending.paymentAmount)
        assertEquals("$40.00", feed(inputs(prompt = owing)).paymentAmount)
        assertEquals("fees", feed(inputs(prompt = PaymentPrompt.Owing(0, 1, 1))).paymentAmount)
        assertEquals("Account suspended", feed(v = viewer.copy(status = "suspended")).standing?.title)
    }

    @Test
    fun `writes no em or en dash anywhere`() {
        val all = feed(
            inputs(
                openSessions = listOf(session("a", "2026-10-15")),
                river = listOf(match("m1", "me", "x", 14, 1017)),
                live = listOf(tournament),
            ),
            viewer.copy(status = "pending_approval"),
        ).toString() + feed(inputs(live = listOf(tournament.copy(tournamentEvents = listOf(FeedEvent("e1", "open_singles", "live")))))).toString()
        assertFalse(all.contains('\u2014'))
        assertFalse(all.contains('\u2013'))
    }

    // ---- the loader --------------------------------------------------------

    private val config = SupabaseConfig.Ok(FakeTransport.BASE_URL, "anon")
    private val clock = 1_800_000_000L

    private suspend fun TestScope.postgrest(respond: suspend (HttpRequest) -> HttpResponse): Pair<Postgrest, FakeTransport> {
        val transport = FakeTransport(respond)
        val sessions = SessionManager(
            GoTrueApi(config, transport) { clock },
            MemorySessionStore(StoredSession("access-1", "refresh-1", clock + 3600, "u1", null)),
            { clock },
            StandardTestDispatcher(testScheduler),
        )
        sessions.load()
        return Postgrest(config, transport, sessions) to transport
    }

    private fun path(r: HttpRequest) = r.url.substringAfter(FakeTransport.BASE_URL)

    @Test
    fun `sends no read for a switched-off feature`() = runTest {
        val off = """[{"value":{"sessions_enabled":false,"events_enabled":false,"tournaments_enabled":false,"announcements_enabled":false,"challenges_enabled":false,"fees_enabled":false}}]"""
        val (pg, transport) = postgrest { r -> if (path(r).contains("key=eq.features")) ok(off) else ok("[]") }
        val f = loadFeed(pg, viewer, now)
        val paths = transport.requests.map(::path)
        for (table in listOf("sessions", "session_rsvp", "session_attendance", "club_events", "club_event_signups", "tournaments", "announcements", "challenge_participants", "club_fees")) {
            assertTrue(table, paths.none { it.startsWith("/rest/v1/$table?") })
        }
        assertTrue(paths.any { it.startsWith("/rest/v1/matches?") })
        assertTrue(paths.none { it.startsWith("/rest/v1/rpc/") })
        assertFalse(f.scheduleOn)
        assertNull(f.you.streak)
        assertTrue(transport.requests.all { it.method == "GET" })
    }

    @Test
    fun `drops the tournament card when an entry read fails`() = runTest {
        val live = """[{"id":"t1","name":"Autumn Open","start_date":"2026-10-14","end_date":"2026-10-14","tournament_events":[{"id":"e1","event_type":"open_singles","status":"live"}]}]"""
        val (pg, _) = postgrest { r ->
            val p = path(r)
            when {
                p.startsWith("/rest/v1/tournaments?") && p.contains("tournament_events") -> ok(live)
                p.startsWith("/rest/v1/tournament_pairs?") -> status(403, """{"message":"permission denied"}""")
                else -> ok("[]")
            }
        }
        assertTrue(loadFeed(pg, viewer, now).liveTournaments.isEmpty())
        val (pg2, _) = postgrest { r -> if (path(r).startsWith("/rest/v1/tournaments?") && path(r).contains("tournament_events")) ok(live) else ok("[]") }
        assertEquals(1, loadFeed(pg2, viewer, now).liveTournaments.size)
    }

    @Test
    fun `survives every secondary read failing and posts only the counts RPC`() = runTest {
        val sessions = """[{"id":"a","name":"Ladder Night","date":"2026-10-15","start_time":"18:00:00","end_time":"20:00:00","status":"open","location":"West Gym","track":"all"}]"""
        val (pg, transport) = postgrest { r ->
            val p = path(r)
            when {
                p.startsWith("/rest/v1/sessions?select=%2A") -> ok(sessions)
                p.startsWith("/rest/v1/sessions?") -> ok("[]")
                else -> status(500, """{"message":"boom"}""")
            }
        }
        val f = loadFeed(pg, viewer, now)
        assertFalse(f.scheduleError)
        assertTrue(f.clubEventsError)
        assertEquals(1, f.agendaSoon.single().rows.size)
        val posts = transport.requests.filter { it.method != "GET" }
        assertEquals(listOf("/rest/v1/rpc/get_session_attendee_counts"), posts.map(::path))
        assertEquals("{\"p_session_ids\":[\"a\"]}", posts.single().body)
    }
}
