package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

// Mirrors apps/player/src/lib/__tests__/feed-activity.test.ts (less
// sessionDayLabel), same inputs and outputs, with invented names, plus one case
// past the 2026-11-01 pin.
class FeedActivityTest {
    private data class Item(val at: String, val id: String)

    private fun person(id: String, name: String) = RiverPerson(id, name, null, null)
    private fun at(iso: String) = Instant.parse(iso)

    @Test
    fun `reads a timestamp in club time, not UTC`() {
        assertEquals("2026-08-04", clubDayKey("2026-08-05T06:00:00Z"))
        assertEquals("2026-08-05", clubDayKey("2026-08-05T20:00:00Z"))
    }

    @Test
    fun `leaves a malformed date unchanged`() {
        assertEquals("soon", clubDayKey("soon"))
    }

    @Test
    fun `groups a match past the cutover at UTC-7`() {
        assertEquals("2026-11-01", clubDayKey("2026-11-02T06:30:00Z"))
        val sections = groupByDay(listOf(Item("2026-11-02T06:30:00Z", "m")), at("2026-11-03T18:00:00Z")) { it.at }
        assertEquals("2026-11-01", sections[0].key)
        assertEquals("SUN 1 NOV", sections[0].label)
    }

    @Test
    fun `steps across month and year boundaries`() {
        assertEquals("2026-08-04", shiftDayKey("2026-08-05", -1))
        assertEquals("2026-07-31", shiftDayKey("2026-08-01", -1))
        assertEquals("2025-12-31", shiftDayKey("2026-01-01", -1))
    }

    @Test
    fun `names today and yesterday and dates anything older`() {
        assertEquals("TODAY", dayLabel("2026-08-05", "2026-08-05"))
        assertEquals("YESTERDAY", dayLabel("2026-08-04", "2026-08-05"))
        assertEquals("SAT 1 AUG", dayLabel("2026-08-01", "2026-08-05"))
        assertEquals("TUE 1 SEPT", dayLabel("2026-09-01", "2026-09-05"))
    }

    @Test
    fun `buckets into club days, newest day first`() {
        val now = at("2026-08-05T18:00:00Z")
        assertEquals(emptyList<DaySection<Item>>(), groupByDay(emptyList<Item>(), now) { it.at })
        val sections = groupByDay(
            listOf(Item("2026-08-04T20:00:00Z", "older"), Item("2026-08-05T17:00:00Z", "newest"), Item("2026-08-05T16:00:00Z", "today-earlier")),
            now,
        ) { it.at }
        assertEquals(listOf("TODAY", "YESTERDAY"), sections.map { it.label })
        assertEquals(listOf("newest", "today-earlier"), sections[0].items.map { it.id })
        assertEquals(listOf("older"), sections[1].items.map { it.id })
    }

    @Test
    fun `sorts rather than trusting the caller`() {
        val sections = groupByDay(listOf(Item("2026-08-05T10:00:00Z", "b"), Item("2026-08-05T14:00:00Z", "a")), at("2026-08-05T18:00:00Z")) { it.at }
        assertEquals(listOf("a", "b"), sections[0].items.map { it.id })
    }

    @Test
    fun `agrees with the row date for a club evening and an afternoon`() {
        val now = at("2026-08-05T18:00:00Z")
        val evening = groupByDay(listOf(Item("2026-08-02T02:00:00Z", "m")), now) { it.at }[0]
        assertEquals("2026-08-01", evening.key)
        assertEquals("SAT 1 AUG", evening.label)
        assertEquals("Aug 1, 2026", formatRelativeTime("2026-08-02T02:00:00Z", at("2026-09-01T00:00:00Z")))
        val afternoon = groupByDay(listOf(Item("2026-08-02T20:00:00Z", "m")), now) { it.at }[0]
        assertEquals("2026-08-02", afternoon.key)
        assertEquals("SUN 2 AUG", afternoon.label)
        assertEquals("Aug 2, 2026", formatRelativeTime("2026-08-02T20:00:00Z", at("2026-09-01T00:00:00Z")))
    }

    @Test
    fun `counts season weeks from the start day`() {
        assertEquals(1, seasonWeek("2026-06-01", at("2026-06-01T18:00:00Z")))
        assertEquals(2, seasonWeek("2026-06-01", at("2026-06-08T18:00:00Z")))
        assertEquals(1, seasonWeek("2026-06-01", at("2026-06-07T18:00:00Z")))
        assertNull(seasonWeek("2026-09-01", at("2026-08-05T18:00:00Z")))
        assertEquals(2, seasonWeek("2026-06-01T00:00:00Z", at("2026-06-09T18:00:00Z")))
    }

    @Test
    fun `counts the streak back from the latest session`() {
        assertEquals(0, attendanceStreak(listOf("a", "b"), emptySet()))
        assertEquals(3, attendanceStreak(listOf("c", "b", "a"), setOf("c", "b", "a")))
        assertEquals(1, attendanceStreak(listOf("c", "b", "a"), setOf("c", "a")))
        assertEquals(0, attendanceStreak(listOf("c", "b", "a"), setOf("b", "a")))
    }

    @Test
    fun `describes a match from the reader's side`() {
        val me = person("me", "Rowan Tessaly")
        val a = person("a", "Idris Varga")
        val b = person("b", "Mireille Okonkwo")
        val c = person("c", "Tobin Halvard")
        assertNull(describeMatch(emptyList(), listOf(a), "me"))
        assertEquals("You beat Idris Varga", describeMatch(listOf(me), listOf(a), "me"))
        assertEquals("Idris Varga beat you", describeMatch(listOf(a), listOf(me), "me"))
        assertEquals("You beat Idris Varga & Mireille Okonkwo", describeMatch(listOf(me, c), listOf(a, b), "me"))
        assertEquals("Mireille Okonkwo beat Idris Varga", describeMatch(listOf(b), listOf(a), "me"))
    }
}
