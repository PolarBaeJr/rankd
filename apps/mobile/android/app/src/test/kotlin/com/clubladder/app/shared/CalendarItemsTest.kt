package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

// Mirrors apps/player/src/lib/__tests__/calendar-items.test.ts, same inputs and
// outputs, plus tournamentWhen from agenda-rows.tsx and a mixed-case name order.
class CalendarItemsTest {
    private val settings = CheckinSettings(120.0, null)

    private data class Sess(
        override val id: String = "s1",
        override val name: String? = "Ladder Night",
        override val date: String = "2026-10-14",
        override val startTime: String? = "18:30:00",
        override val endTime: String? = "21:00:00",
        override val status: String? = "open",
        override val startsAt: String? = null,
        override val endsAt: String? = null,
    ) : AgendaSession

    private fun row(id: String = "s1", name: String? = "Ladder Night", startTime: String? = "18:30:00", status: String = "open") =
        CalendarSessionRow(id, name, "2026-10-14", startTime, status)

    private fun clubEvent(id: String = "e1", startsAt: String = "2026-10-15T02:30:00Z", endsAt: String? = null, status: String = "published") =
        CalendarClubEventRow(id, "Club Social", "social", null, startsAt, endsAt, status)

    private fun tournament(
        id: String = "t1",
        startDate: String = "2026-10-17",
        endDate: String? = "2026-10-19",
        status: String = "active",
        suspendedAt: String? = null,
    ) = CalendarTournamentRow(id, "Fall Open", startDate, endDate, status, suspendedAt)

    private fun item(key: String, date: String = "2026-10-14", allDay: Boolean = false, sortTime: String? = null, kind: CalendarItemKind = CalendarItemKind.SESSION, tone: CalendarTone = CalendarTone.OPEN, name: String = "A") =
        CalendarItem(key, "x", kind, date, allDay, sortTime, name, null, tone, false, null)

    private fun at(iso: String) = Instant.parse(iso)

    @Test
    fun `tones open and closed nights apart`() {
        assertEquals(CalendarTone.OPEN, sessionCalendarItem(row(), mine = false, hasCard = true).tone)
        assertEquals(CalendarTone.CLOSED, sessionCalendarItem(row(status = "closed"), mine = false, hasCard = false).tone)
    }

    @Test
    fun `links to the card only when there is one`() {
        assertEquals("#session-s1", sessionCalendarItem(row(), mine = false, hasCard = true).href)
        assertNull(sessionCalendarItem(row(), mine = false, hasCard = false).href)
    }

    @Test
    fun `has no time when the session has no start time`() {
        val it0 = sessionCalendarItem(row(startTime = null, name = null), mine = true, hasCard = false)
        assertNull(it0.sortTime)
        assertNull(it0.timeLabel)
        assertEquals("Practice Session", it0.name)
        assertTrue(it0.mine)
    }

    @Test
    fun `places an event on its club date past the 2026-11-01 cutover`() {
        val it0 = clubEventCalendarItem(clubEvent(startsAt = "2026-11-02T07:30:00Z"), mine = false)!!
        assertEquals("2026-11-02", it0.date)
        assertEquals("00:30", it0.sortTime)
        assertEquals("12:30 AM", it0.timeLabel)
    }

    @Test
    fun `places an evening event on its club date, not its UTC date`() {
        assertEquals("2026-10-14", clubEventCalendarItem(clubEvent(), mine = false)!!.date)
    }

    @Test
    fun `tones a cancelled event and links to the event page`() {
        val it0 = clubEventCalendarItem(clubEvent(status = "cancelled"), mine = true)!!
        assertEquals(CalendarTone.CANCELLED, it0.tone)
        assertEquals("/events/e1", it0.href)
        assertEquals(CalendarTone.CLUB, clubEventCalendarItem(clubEvent(), mine = false)!!.tone)
    }

    @Test
    fun `puts one all-day item on each day, with unique keys`() {
        val items = tournamentCalendarItems(tournament())
        assertEquals(listOf("2026-10-17", "2026-10-18", "2026-10-19"), items.map { it.date })
        assertEquals(3, items.map { it.key }.toSet().size)
        assertTrue(items.all { it.allDay && it.href == "/tournaments/t1" })
    }

    @Test
    fun `caps a long run at seven days and treats a missing end date as one day`() {
        assertEquals(7, tournamentCalendarItems(tournament(endDate = "2026-12-31")).size)
        assertEquals(1, tournamentCalendarItems(tournament(endDate = null)).size)
    }

    @Test
    fun `orders all-day first, then by time, then untimed last`() {
        val sorted = listOf(
            item("untimed"),
            item("late", sortTime = "20:00"),
            item("allday", allDay = true),
            item("early", sortTime = "09:00"),
            item("tomorrow", date = "2026-10-15", allDay = true),
        ).sortedWith(compareCalendarItems)
        assertEquals(listOf("allday", "early", "late", "untimed", "tomorrow"), sorted.map { it.key })
    }

    @Test
    fun `orders names as localeCompare does, ignoring case first`() {
        val sorted = listOf(item("b", name = "beta"), item("B", name = "Alpha"), item("a", name = "alpha")).sortedWith(compareCalendarItems)
        assertEquals(listOf("a", "B", "b"), sorted.map { it.key })
    }

    @Test
    fun `starts today and runs seven days across a month boundary`() {
        val week = buildWeekStrip(emptyList(), "2026-09-28")
        assertEquals(
            listOf("2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"),
            week.map { it.dateISO },
        )
        assertEquals(listOf(true, false, false, false, false, false, false), week.map { it.isToday })
        assertEquals("Mon", week[0].weekday)
        assertEquals(1, week[3].day)
    }

    @Test
    fun `caps the marks at three and counts the rest`() {
        val today = buildWeekStrip(listOf("a", "b", "c", "d", "e").map { item(it) }, "2026-10-14")[0]
        assertEquals(3, today.marks.size)
        assertEquals(2, today.more)
    }

    @Test
    fun `spells the day out without an em dash`() {
        val items = listOf(item("a"), item("b", kind = CalendarItemKind.CLUB_EVENT, tone = CalendarTone.CLUB))
        val week = buildWeekStrip(items, "2026-10-14")
        assertEquals("Wed 14: 1 session, 1 club event", week[0].summary)
        assertEquals("Thu 15: nothing on", week[1].summary)
        assertFalse(week[0].summary.contains('\u2014'))
    }

    private fun agenda(
        now: String,
        sessions: List<Sess> = emptyList(),
        clubEvents: List<CalendarClubEventRow> = emptyList(),
        tournaments: List<CalendarTournamentRow> = emptyList(),
        live: Set<String> = emptySet(),
    ) = buildAgenda(sessions, clubEvents, tournaments, at(now), "2026-10-14", settings, live)

    @Test
    fun `keeps tonight until check-in closes and drops a night whose window has shut`() {
        val days = agenda("2026-10-15T03:00:00Z", sessions = listOf(Sess(id = "tonight"), Sess(id = "yesterday", date = "2026-10-13")))
        assertEquals(listOf("session:tonight"), days.flatMap { d -> d.sessions.map { it.key } })
    }

    @Test
    fun `drops a finished club event and keeps a future cancelled one`() {
        val days = agenda(
            "2026-10-15T03:00:00Z",
            clubEvents = listOf(
                clubEvent(id = "over", startsAt = "2026-10-14T20:00:00Z", endsAt = "2026-10-14T22:00:00Z"),
                clubEvent(id = "cancelled", status = "cancelled", startsAt = "2026-10-16T02:00:00Z"),
            ),
        )
        assertEquals(listOf("club_event:cancelled"), days.flatMap { d -> d.sessions.map { it.key } })
    }

    @Test
    fun `keeps an event with no end time until the default length has passed`() {
        assertEquals(1, agenda("2026-10-15T04:00:00Z", clubEvents = listOf(clubEvent())).size)
    }

    @Test
    fun `caps the club events at ten`() {
        val events = (0 until 12).map { i -> clubEvent(id = "e$i", startsAt = "2026-10-${(16 + i).toString().padStart(2, '0')}T02:00:00Z") }
        assertEquals(10, agenda("2026-10-15T03:00:00Z", clubEvents = events).flatMap { it.sessions }.size)
    }

    @Test
    fun `leaves out live, suspended, finished and draft tournaments`() {
        val days = agenda(
            "2026-10-15T03:00:00Z",
            live = setOf("live"),
            tournaments = listOf(
                tournament(id = "live"),
                tournament(id = "suspended", suspendedAt = "2026-10-01T00:00:00Z"),
                tournament(id = "over", startDate = "2026-10-01", endDate = "2026-10-02"),
                tournament(id = "draft", status = "draft"),
                tournament(id = "running", startDate = "2026-10-12", endDate = "2026-10-15"),
                tournament(id = "soon"),
            ),
        )
        assertEquals(
            listOf("tournament:running" to "2026-10-14", "tournament:soon" to "2026-10-17"),
            days.flatMap { d -> d.sessions.map { it.key to it.date } },
        )
    }

    @Test
    fun `groups by day in order, with all-day first inside a day`() {
        val days = agenda(
            "2026-10-14T16:00:00Z",
            sessions = listOf(Sess(id = "late", date = "2026-10-17"), Sess(id = "today")),
            clubEvents = listOf(clubEvent(id = "soc", startsAt = "2026-10-17T01:00:00Z")),
            tournaments = listOf(tournament()),
        )
        assertEquals(listOf("2026-10-14", "2026-10-16", "2026-10-17"), days.map { it.dateISO })
        assertTrue(days[0].heading.isToday)
        assertTrue(days[2].sessions[0] is AgendaEntry.Tournament)
        assertTrue(days[2].sessions[1] is AgendaEntry.Session)
        assertTrue(days[1].sessions.single() is AgendaEntry.ClubEvent)
    }

    @Test
    fun `says when a tournament runs`() {
        val today = "2026-10-14"
        assertEquals("All day", tournamentWhen(tournament(endDate = null), today))
        assertEquals("3 days", tournamentWhen(tournament(), today))
        assertEquals("Today", tournamentWhen(tournament(startDate = today, endDate = null), today))
        assertEquals("Starts today, 2 days", tournamentWhen(tournament(startDate = today, endDate = "2026-10-15"), today))
        assertEquals("Day 3 of 4", tournamentWhen(tournament(startDate = "2026-10-12", endDate = "2026-10-15"), today))
    }
}
