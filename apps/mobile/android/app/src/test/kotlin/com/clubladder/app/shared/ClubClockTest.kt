package com.clubladder.app.shared

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

// Mirrors packages/shared/src/utils/__tests__/session-window.test.ts, the
// wall-clock cases of club-events.test.ts and the formatTime and
// formatRelativeTime cases of helpers.test.ts, same inputs and outputs.
class ClubClockTest {
    private data class S(
        override val date: String,
        override val startTime: String? = null,
        override val endTime: String? = null,
        override val status: String? = null,
        override val startsAt: String? = null,
        override val endsAt: String? = null,
    ) : SessionWindowFields

    private fun at(iso: String) = Instant.parse(iso)
    private val minute = 60_000L

    @Test
    fun `closes at end of the club-local day when no times are set`() {
        val w = getCheckinWindow(S("2026-07-15"))
        val midnight = at("2026-07-15T07:00:00.000Z")
        assertEquals(midnight.minusMillis(30 * minute), w.opensAt)
        assertEquals("2026-07-16T07:00:00.000Z", isoMillis(w.closesAt))
    }

    @Test
    fun `closes at start + default duration when only start_time is set`() {
        val w = getCheckinWindow(S("2026-07-15", startTime = "18:30:00"))
        assertEquals(at("2026-07-16T01:30:00.000Z").plusMillis(60 * minute), w.closesAt)
    }

    @Test
    fun `respects an explicit end_time`() {
        val w = getCheckinWindow(S("2026-07-15", startTime = "18:30:00", endTime = "21:00:00"))
        assertEquals("2026-07-16T04:00:00.000Z", isoMillis(w.closesAt))
    }

    @Test
    fun `uses the winter (PST) offset for winter dates`() {
        assertEquals("2026-01-16T05:00:00.000Z", isoMillis(getCheckinWindow(S("2026-01-15", endTime = "21:00")).closesAt))
    }

    @Test
    fun `handles the spring-forward DST boundary sanely`() {
        assertEquals("2026-03-09T04:00:00.000Z", isoMillis(getCheckinWindow(S("2026-03-08", endTime = "21:00")).closesAt))
        assertEquals("2026-03-08T08:00:00.000Z", isoMillis(getCheckinWindow(S("2026-03-07")).closesAt))
    }

    @Test
    fun `prefers the stored instants when the row carries them`() {
        val w = getCheckinWindow(
            S("2026-07-15", startTime = "18:30", endTime = "21:00", startsAt = "2026-07-16T01:00:00+00:00", endsAt = null),
        )
        assertEquals(at("2026-07-16T02:00:00Z"), w.closesAt)
        assertEquals(at("2026-07-16T00:30:00Z"), w.opensAt)
    }

    @Test
    fun `is open across the session day when no times are set`() {
        val s = S("2026-07-15")
        assertTrue(isCheckinOpen(s, at("2026-07-15T07:30:00Z")))
        assertTrue(isCheckinOpen(s, at("2026-07-16T06:30:00Z")))
        assertFalse(isCheckinOpen(s, at("2026-07-10T00:00:00Z")))
    }

    @Test
    fun `closes after start + default duration for a start-only session`() {
        val s = S("2026-07-15", startTime = "18:30")
        assertTrue(isCheckinOpen(s, at("2026-07-16T02:00:00Z")))
        assertFalse(isCheckinOpen(s, at("2026-07-16T03:31:00Z")))
    }

    @Test
    fun `closes at the explicit end_time`() {
        val s = S("2026-07-15", startTime = "18:30", endTime = "22:00")
        assertTrue(isCheckinOpen(s, at("2026-07-16T04:59:00Z")))
        assertFalse(isCheckinOpen(s, at("2026-07-16T05:00:00Z")))
    }

    @Test
    fun `is closed when now is beyond the close bound`() {
        assertFalse(isCheckinOpen(S("2026-07-15"), at("2026-07-16T07:00:00Z")))
    }

    @Test
    fun `is closed for a non-open session regardless of time`() {
        assertFalse(isCheckinOpen(S("2026-07-15", status = "closed"), at("2026-07-15T20:00:00Z")))
    }

    @Test
    fun `parses the settings row the way the database coerces it`() {
        assertEquals(CheckinSettings(120.0, null), parseCheckinSettings(null))
        assertEquals(
            CheckinSettings(90.0, 15.0),
            parseCheckinSettings(buildJsonObject { put("default_duration_minutes", 90); put("checkin_opens_minutes_before", "15") }),
        )
        val nulls = buildJsonObject { put("default_duration_minutes", "soon"); put("checkin_opens_minutes_before", JsonNull) }
        assertEquals(CheckinSettings(120.0, null), parseCheckinSettings(nulls))
        assertEquals(CheckinSettings(120.0, null), parseCheckinSettings(JsonPrimitive(5)))
    }

    @Test
    fun `resolves a wall clock across the 2026-11-01 pin`() {
        assertEquals("2026-11-02T02:00:00.000Z", isoMillis(wallClockToUtc(2026, 11, 1, 19, 0)))
        assertEquals("2027-01-16T02:00:00.000Z", isoMillis(wallClockToUtc(2027, 1, 15, 19, 0)))
        assertEquals("2026-07-02T02:00:00.000Z", isoMillis(wallClockToUtc(2026, 7, 1, 19, 0)))
    }

    @Test
    fun `rolls a day overflow into the next month`() {
        assertEquals("2026-08-01T07:00:00.000Z", isoMillis(wallClockToUtc(2026, 7, 32, 0, 0)))
    }

    @Test
    fun `round-trips a wall clock`() {
        for ((wall, parts) in listOf(
            "2026-07-01T19:00" to listOf(2026, 7, 1, 19, 0),
            "2026-11-01T19:00" to listOf(2026, 11, 1, 19, 0),
            "2027-03-14T09:30" to listOf(2027, 3, 14, 9, 30),
        )) {
            assertEquals(wall, utcToClubWallClock(wallClockToUtc(parts[0], parts[1], parts[2], parts[3], parts[4])))
        }
    }

    @Test
    fun `reads past the 2026-11-01 cutover at a fixed UTC-7, whatever tzdata says`() {
        assertEquals(ClubWallClock("2026-11-02", "00:30"), clubEventWallClock(at("2026-11-02T07:30:00Z")))
    }

    @Test
    fun `puts an evening event on its club date, not its UTC date`() {
        assertEquals(ClubWallClock("2026-10-14", "19:30"), clubEventWallClock(at("2026-10-15T02:30:00Z")))
    }

    @Test
    fun `formats TIME values on a 12-hour clock`() {
        assertEquals("6:30 PM", formatTime("18:30:00"))
        assertEquals("9:05 AM", formatTime("09:05"))
        assertEquals("12:00 AM", formatTime("00:00:00"))
        assertEquals("12:00 PM", formatTime("12:00"))
    }

    @Test
    fun `counts back in minutes, hours and days`() {
        val now = at("2026-08-10T12:00:00Z")
        assertEquals("just now", formatRelativeTime("2026-08-10T12:00:00Z", now))
        assertEquals("5m ago", formatRelativeTime("2026-08-10T11:55:00Z", now))
        assertEquals("3h ago", formatRelativeTime("2026-08-10T09:00:00Z", now))
        assertEquals("2d ago", formatRelativeTime("2026-08-08T12:00:00Z", now))
    }

    @Test
    fun `renders the over-a-week fallback in club time, not the runtime zone`() {
        val now = at("2026-09-01T00:00:00Z")
        assertEquals("Aug 1, 2026", formatRelativeTime("2026-08-02T02:00:00Z", now))
        assertEquals("Aug 2, 2026", formatRelativeTime("2026-08-02T20:00:00Z", now))
    }

    @Test
    fun `sends instants with milliseconds, as toISOString does`() {
        assertEquals("2026-07-01T00:00:00.000Z", isoMillis(at("2026-07-01T00:00:00Z")))
        assertNull(parseInstant("not a time"))
        assertEquals(at("2026-07-01T00:00:00Z"), parseInstant("2026-07-01"))
    }
}
