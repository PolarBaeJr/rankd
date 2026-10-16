package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

// Mirrors apps/player/src/lib/__tests__/schedule.test.ts, less the month grid.
class ScheduleTest {
    private data class Row(val id: String, val date: String)

    @Test
    fun `adds days across months, years and DST, and goes backwards`() {
        assertEquals("2026-08-11", addDaysISO("2026-08-10", 1))
        assertEquals("2026-09-01", addDaysISO("2026-08-31", 1))
        assertEquals("2027-01-01", addDaysISO("2026-12-31", 1))
        assertEquals("2026-03-09", addDaysISO("2026-03-08", 1))
        assertEquals("2026-02-28", addDaysISO("2026-03-01", -1))
    }

    @Test
    fun `names today, tomorrow and the weekday further out`() {
        val today = "2026-08-10"
        assertEquals(DayHeading("Today", "10 Aug", isToday = true, isTomorrow = false), dayHeading(today, today))
        val tomorrow = dayHeading("2026-08-11", today)
        assertEquals("Tomorrow", tomorrow.label)
        assertTrue(tomorrow.isTomorrow)
        assertEquals(DayHeading("Fri", "14 Aug", isToday = false, isTomorrow = false), dayHeading("2026-08-14", today))
        assertEquals("Sun", dayHeading("2026-08-09", today).label)
    }

    @Test
    fun `reads a Postgres date without a zone, with or without a time`() {
        for (date in listOf("2026-10-04", "2026-10-04T00:00:00")) {
            val heading = dayHeading(date, "2026-09-01")
            assertEquals("Sun", heading.label)
            assertEquals("4 Oct", heading.dateLabel)
        }
    }

    @Test
    fun `buckets by date, oldest day first, keeping query order`() {
        val groups = groupSessionsByDay(
            listOf(Row("b", "2026-08-12"), Row("a", "2026-08-10"), Row("c", "2026-08-12")),
            "2026-08-10",
        ) { it.date }
        assertEquals(listOf("2026-08-10", "2026-08-12"), groups.map { it.dateISO })
        assertEquals(listOf(listOf("a"), listOf("b", "c")), groups.map { g -> g.sessions.map { it.id } })
        assertEquals("Today", groups[0].heading.label)
        assertEquals(emptyList<DayGroup<Row>>(), groupSessionsByDay(emptyList<Row>(), "2026-08-10") { it.date })
    }

    @Test
    fun `tallies rows per session`() {
        assertEquals(mapOf("a" to 2, "b" to 1), tallyBySession(listOf("a", "b", "a")))
        assertEquals(emptyMap<String, Int>(), tallyBySession(null))
        assertNull(tallyBySession(listOf("a"))["b"])
    }

    @Test
    fun `prefers attendance over an older RSVP`() {
        assertEquals(MyState.CHECKED_IN, describeMyState("checked_in", "declined"))
        assertEquals(MyState.NO_SHOW, describeMyState("no_show", "going"))
        assertEquals(MyState.ATTENDED, describeMyState("present", null))
        assertEquals(MyState.EXCUSED, describeMyState("excused", "going"))
        assertEquals(MyState.GOING, describeMyState(null, "going"))
        assertEquals(MyState.DECLINED, describeMyState(null, "declined"))
        assertEquals(MyState.NONE, describeMyState(null, null))
    }

    @Test
    fun `records attendance for every status and presence for two`() {
        for (status in listOf("checked_in", "present", "no_show", "excused")) assertTrue(isAttendanceRecorded(status))
        assertFalse(isAttendanceRecorded(null))
        assertTrue(wasPresent("present"))
        assertFalse(wasPresent("excused"))
    }

    @Test
    fun `keeps a night until its check-in window closes`() {
        fun at(iso: String) = Instant.parse(iso)
        assertFalse(isStillUpcoming(at("2026-08-12T05:00:00Z"), at("2026-08-13T22:00:00Z")))
        assertTrue(isStillUpcoming(at("2026-08-14T05:00:00Z"), at("2026-08-13T22:00:00Z")))
        assertTrue(isStillUpcoming(at("2026-08-20T05:00:00Z"), at("2026-08-13T22:00:00Z")))
        assertFalse(isStillUpcoming(at("2026-08-13T22:00:00Z"), at("2026-08-13T22:00:00Z")))
    }
}
