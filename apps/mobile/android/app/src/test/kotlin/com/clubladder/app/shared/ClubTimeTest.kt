package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

// Mirrors packages/shared/src/utils/__tests__/club-today.test.ts, plus the pin.
class ClubTimeTest {
    private fun at(iso: String) = clubToday(Instant.parse(iso))

    @Test
    fun `returns the club date, not the UTC date, on a summer evening`() {
        assertEquals("2026-08-06", at("2026-08-07T02:00:00Z"))
    }

    @Test
    fun `returns the club date, not the UTC date, on a winter evening`() {
        assertEquals("2026-12-04", at("2026-12-05T01:00:00Z"))
    }

    @Test
    fun `agrees with UTC during the club daytime`() {
        assertEquals("2026-08-06", at("2026-08-06T19:00:00Z"))
    }

    @Test
    fun `emits YYYY-MM-DD`() {
        assertTrue(Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(at("2026-01-02T20:00:00Z")))
    }

    @Test
    fun `differs from the naive UTC slice at the exact hour that broke`() {
        assertEquals("2026-08-07", "2026-08-07T02:00:00Z".take(10))
        assertEquals("2026-08-06", at("2026-08-07T02:00:00Z"))
    }

    // Past the cutover the offset is -07:00 whatever the phone's tzdata says.
    // Old tzdata reads 07:30Z on 5 December as 23:30 on the 4th.
    @Test
    fun `reads a winter morning past the cutover on the pinned offset`() {
        assertEquals("2026-12-05", at("2026-12-05T07:30:00Z"))
        assertEquals("2027-01-15", at("2027-01-15T07:30:00Z"))
    }

    @Test
    fun `switches to the pin exactly at the cutover midnight`() {
        assertEquals("2026-10-31", at("2026-11-01T06:59:00Z"))
        assertEquals("2026-11-01", at("2026-11-01T07:00:00Z"))
    }
}
