package com.clubladder.app.shared

import java.time.Instant
import java.time.LocalDate

// Port of apps/player/src/lib/schedule.ts, without the month grid (the month
// calendar is desktop only on the web and not in the app). Keep in step with it.
// Every function takes the club's "today" as an argument, so one render reads
// the clock once.

val CALENDAR_WEEKDAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
private val SCHEDULE_MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

private fun isoDate(dateISO: String): LocalDate {
    val p = dateISO.take(10).split("-")
    val y = p.getOrNull(0)?.toIntOrNull() ?: 1970
    val m = p.getOrNull(1)?.toIntOrNull() ?: 1
    val d = p.getOrNull(2)?.toIntOrNull() ?: 1
    return LocalDate.of(y, 1, 1).plusMonths((m - 1).toLong()).plusDays((d - 1).toLong())
}

/** Calendar arithmetic on a bare YYYY-MM-DD. No clock or zone is read. */
fun addDaysISO(dateISO: String, days: Int): String = isoDate(dateISO).plusDays(days.toLong()).toString()

/** Sunday is 0, as JS getUTCDay counts. */
fun weekdayIndex(dateISO: String): Int = isoDate(dateISO).dayOfWeek.value % 7

data class DayHeading(
    /** "Today", "Tomorrow", or a weekday. */
    val label: String,
    /** "14 Aug": always shown too, so a relative word is never the only anchor. */
    val dateLabel: String,
    val isToday: Boolean,
    val isTomorrow: Boolean,
)

fun dayHeading(dateISO: String, todayISO: String): DayHeading {
    val date = isoDate(dateISO)
    val weekday = CALENDAR_WEEKDAYS[date.dayOfWeek.value % 7]
    val isToday = dateISO == todayISO
    val isTomorrow = dateISO == addDaysISO(todayISO, 1)
    return DayHeading(
        label = if (isToday) "Today" else if (isTomorrow) "Tomorrow" else weekday,
        dateLabel = "${date.dayOfMonth} ${SCHEDULE_MONTHS[date.monthValue - 1]}",
        isToday = isToday,
        isTomorrow = isTomorrow,
    )
}

data class DayGroup<T>(val dateISO: String, val sessions: List<T>, val heading: DayHeading)

/** Bucketed by club date, oldest first, query order kept inside a day. */
fun <T> groupSessionsByDay(sessions: List<T>, todayISO: String, dateOf: (T) -> String): List<DayGroup<T>> {
    val byDate = LinkedHashMap<String, MutableList<T>>()
    for (session in sessions) byDate.getOrPut(dateOf(session)) { mutableListOf() }.add(session)
    return byDate.keys.sorted().map { DayGroup(it, byDate.getValue(it), dayHeading(it, todayISO)) }
}

/** How many rows each session id has. */
fun tallyBySession(sessionIds: List<String>?): Map<String, Int> {
    val counts = LinkedHashMap<String, Int>()
    for (id in sessionIds.orEmpty()) counts[id] = (counts[id] ?: 0) + 1
    return counts
}

enum class MyState { CHECKED_IN, ATTENDED, NO_SHOW, EXCUSED, GOING, DECLINED, NONE }

/** Attendance always outranks an earlier RSVP. */
fun describeMyState(status: String?, intent: String?): MyState = when {
    status == "checked_in" -> MyState.CHECKED_IN
    status == "present" -> MyState.ATTENDED
    status == "no_show" -> MyState.NO_SHOW
    status == "excused" -> MyState.EXCUSED
    intent == "going" -> MyState.GOING
    intent == "declined" -> MyState.DECLINED
    else -> MyState.NONE
}

/** The two statuses that mean the member was there. Not isAttendanceRecorded. */
fun wasPresent(status: String?): Boolean = status == "checked_in" || status == "present"

/** True once attendance is on the record, present or not. */
fun isAttendanceRecorded(status: String?): Boolean =
    status == "checked_in" || status == "present" || status == "no_show" || status == "excused"

/** A night stays under Up next until its check-in window closes, whatever its status says. */
fun isStillUpcoming(closesAt: Instant, now: Instant): Boolean = now.isBefore(closesAt)
