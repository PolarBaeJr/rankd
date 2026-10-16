package com.clubladder.app.shared

import java.time.Instant

// Port of apps/player/src/lib/feed-activity.ts, less sessionDayLabel (the feed
// does not use it). Keep in step with it.
//
// The web reads the club day through Intl with no tzdata pin. Here every day
// key goes through clubToday, so past 2026-11-01 it stays at UTC-07:00 on a
// phone whose zone database is older. The web's own tests all sit before the
// cutover, so the same inputs give the same outputs.

/** The club day an instant falls on, YYYY-MM-DD. The first ten characters when unreadable. */
fun clubDayKey(iso: String): String = parseInstant(iso)?.let { clubToday(it) } ?: iso.take(10)

/** Shifts a YYYY-MM-DD key by whole days. */
fun shiftDayKey(key: String, days: Int): String = addDaysISO(key, days)

private val EN_GB_WEEKDAYS = listOf("SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT")
private val EN_GB_MONTHS = listOf("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEPT", "OCT", "NOV", "DEC")

/** "TODAY", "YESTERDAY" or "WED 4 AUG", as en-GB Intl prints it (so September is "SEPT"). */
fun dayLabel(key: String, todayKey: String): String {
    if (key == todayKey) return "TODAY"
    if (key == shiftDayKey(todayKey, -1)) return "YESTERDAY"
    val normal = addDaysISO(key, 0)
    val month = normal.substring(5, 7).toInt()
    val day = normal.substring(8, 10).toInt()
    return "${EN_GB_WEEKDAYS[weekdayIndex(normal)]} $day ${EN_GB_MONTHS[month - 1]}"
}

data class DaySection<T>(val key: String, val label: String, val items: List<T>)

/** Club days, newest first, newest first inside a day too. Sorts rather than trusting the caller. */
fun <T> groupByDay(items: List<T>, now: Instant, atOf: (T) -> String): List<DaySection<T>> {
    val todayKey = clubToday(now)
    val sections = LinkedHashMap<String, MutableList<T>>()
    for (item in items.sortedByDescending(atOf)) {
        sections.getOrPut(clubDayKey(atOf(item))) { mutableListOf() }.add(item)
    }
    return sections.entries
        .sortedByDescending { it.key }
        .map { (key, list) -> DaySection(key, dayLabel(key, todayKey), list) }
}

/** The week of the season, 1-based, inclusive of the start day. Null before it begins. */
fun seasonWeek(startDate: String, now: Instant): Int? {
    val start = startDate.take(10)
    val today = clubToday(now)
    if (today < start) return null
    val days = java.time.temporal.ChronoUnit.DAYS.between(java.time.LocalDate.parse(start), java.time.LocalDate.parse(today))
    return (days / 7).toInt() + 1
}

/** How many of the most recent sessions in a row the member was at. */
fun attendanceStreak(pastSessionIdsNewestFirst: List<String>, attendedIds: Set<String>): Int {
    var streak = 0
    for (id in pastSessionIdsNewestFirst) {
        if (id !in attendedIds) break
        streak++
    }
    return streak
}

data class RiverPerson(val id: String, val name: String, val handle: String?, val avatarUrl: String?)

/** "You beat X", "X beat you", or "X beat Y"; doubles pairs joined with "&". */
fun describeMatch(winners: List<RiverPerson>, losers: List<RiverPerson>, viewerId: String): String? {
    if (winners.isEmpty() || losers.isEmpty()) return null
    fun names(people: List<RiverPerson>) = people.joinToString(" & ") { it.name }
    if (winners.any { it.id == viewerId }) return "You beat ${names(losers)}"
    if (losers.any { it.id == viewerId }) return "${names(winners)} beat you"
    return "${names(winners)} beat ${names(losers)}"
}
