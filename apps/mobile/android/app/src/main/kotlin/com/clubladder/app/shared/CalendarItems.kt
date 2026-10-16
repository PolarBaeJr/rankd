package com.clubladder.app.shared

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.text.Collator
import java.time.Instant
import java.util.Locale

// Port of apps/player/src/lib/calendar-items.ts, less buildCalendarMonth (the
// month grid is not in the app), plus tournamentWhen from
// apps/player/src/app/feed/agenda-rows.tsx. Keep in step with them.
//
// One difference: a club event whose starts_at cannot be read is left out. On
// the web such a row throws while it renders.

enum class CalendarTone { OPEN, CLOSED, CLUB, TOURNAMENT, CANCELLED }

enum class CalendarItemKind { SESSION, CLUB_EVENT, TOURNAMENT }

/** What compareCalendarItems orders by. */
interface CalendarOrderable {
    val date: String
    val allDay: Boolean
    val sortTime: String?
    val name: String
}

/** One entry on the week strip. */
data class CalendarItem(
    val key: String,
    val id: String,
    val kind: CalendarItemKind,
    override val date: String,
    override val allDay: Boolean,
    override val sortTime: String?,
    override val name: String,
    val timeLabel: String?,
    val tone: CalendarTone,
    val mine: Boolean,
    /** "#session-<id>" for a card on the page, a web path, or null for plain text. */
    val href: String?,
) : CalendarOrderable

@Serializable
data class CalendarSessionRow(
    val id: String = "",
    val name: String? = null,
    val date: String = "",
    @SerialName("start_time") val startTime: String? = null,
    val status: String = "",
    @SerialName("season_id") val seasonId: String? = null,
)

@Serializable
data class CalendarClubEventRow(
    val id: String = "",
    val title: String = "",
    val kind: String = "",
    val location: String? = null,
    @SerialName("starts_at") val startsAt: String = "",
    @SerialName("ends_at") val endsAt: String? = null,
    val status: String = "",
)

@Serializable
data class CalendarTournamentRow(
    val id: String = "",
    val name: String = "",
    @SerialName("start_date") val startDate: String = "",
    @SerialName("end_date") val endDate: String? = null,
    val status: String = "",
    @SerialName("suspended_at") val suspendedAt: String? = null,
)

private fun hhmm(time: String?): String? = if (time.isNullOrEmpty()) null else time.take(5)

fun sessionCalendarItem(s: CalendarSessionRow, mine: Boolean, hasCard: Boolean): CalendarItem = CalendarItem(
    key = "session:${s.id}",
    id = s.id,
    kind = CalendarItemKind.SESSION,
    date = s.date,
    allDay = false,
    sortTime = hhmm(s.startTime),
    name = s.name ?: "Practice Session",
    timeLabel = if (s.startTime.isNullOrEmpty()) null else formatTime(s.startTime),
    tone = if (s.status == "open") CalendarTone.OPEN else CalendarTone.CLOSED,
    mine = mine,
    href = if (hasCard) "#session-${s.id}" else null,
)

fun clubEventCalendarItem(e: CalendarClubEventRow, mine: Boolean): CalendarItem? {
    val at = parseInstant(e.startsAt) ?: return null
    val wall = clubEventWallClock(at)
    return CalendarItem(
        key = "club_event:${e.id}",
        id = e.id,
        kind = CalendarItemKind.CLUB_EVENT,
        date = wall.date,
        allDay = false,
        sortTime = wall.time,
        name = e.title,
        timeLabel = formatTime(wall.time),
        tone = if (e.status == "cancelled") CalendarTone.CANCELLED else CalendarTone.CLUB,
        mine = mine,
        href = "/events/${e.id}",
    )
}

private fun lastDayOf(t: CalendarTournamentRow): String =
    if (t.endDate != null && t.endDate > t.startDate) t.endDate else t.startDate

/** One all-day item per day the tournament runs, capped so a typo in end_date cannot paint a month. */
fun tournamentCalendarItems(t: CalendarTournamentRow, maxDays: Int = 7): List<CalendarItem> {
    val last = lastDayOf(t)
    val items = mutableListOf<CalendarItem>()
    var date = t.startDate
    while (date <= last && items.size < maxDays) {
        items += CalendarItem(
            key = "tournament:${t.id}:$date",
            id = t.id,
            kind = CalendarItemKind.TOURNAMENT,
            date = date,
            allDay = true,
            sortTime = null,
            name = t.name,
            timeLabel = null,
            tone = CalendarTone.TOURNAMENT,
            mine = false,
            href = "/tournaments/${t.id}",
        )
        date = addDaysISO(date, 1)
    }
    return items
}

private val NAME_ORDER: Collator = Collator.getInstance(Locale.ENGLISH)

/** By date, then all-day first, then by time with untimed last, then by name. */
val compareCalendarItems: Comparator<CalendarOrderable> = Comparator { a, b ->
    when {
        a.date != b.date -> if (a.date < b.date) -1 else 1
        a.allDay != b.allDay -> if (a.allDay) -1 else 1
        a.sortTime != b.sortTime -> when {
            a.sortTime == null -> 1
            b.sortTime == null -> -1
            else -> if (a.sortTime!! < b.sortTime!!) -1 else 1
        }
        else -> NAME_ORDER.compare(a.name, b.name)
    }
}

data class WeekStripDay(
    val dateISO: String,
    /** "Tue". */
    val weekday: String,
    val day: Int,
    val isToday: Boolean,
    /** Up to three, in day order. */
    val marks: List<CalendarTone>,
    val more: Int,
    /** The whole day in words, for a screen reader: "Tue 14: 1 session, 1 club event". */
    val summary: String,
    val count: Int,
)

private const val WEEK_MARKS = 3

private val KIND_WORDS = listOf(
    CalendarItemKind.SESSION to ("session" to "sessions"),
    CalendarItemKind.CLUB_EVENT to ("club event" to "club events"),
    CalendarItemKind.TOURNAMENT to ("tournament" to "tournaments"),
)

/** The seven days from today, each with its items as colour marks. */
fun buildWeekStrip(items: List<CalendarItem>, todayISO: String, days: Int = 7): List<WeekStripDay> =
    (0 until days).map { i ->
        val dateISO = addDaysISO(todayISO, i)
        val dayItems = items.filter { it.date == dateISO }.sortedWith(compareCalendarItems)
        val weekday = CALENDAR_WEEKDAYS[weekdayIndex(dateISO)]
        val day = dateISO.substring(8, 10).toInt()
        val counts = KIND_WORDS.mapNotNull { (kind, words) ->
            val n = dayItems.count { it.kind == kind }
            if (n > 0) "$n ${if (n == 1) words.first else words.second}" else null
        }
        WeekStripDay(
            dateISO = dateISO,
            weekday = weekday,
            day = day,
            isToday = i == 0,
            marks = dayItems.take(WEEK_MARKS).map { it.tone },
            more = maxOf(dayItems.size - WEEK_MARKS, 0),
            summary = "$weekday $day: ${if (counts.isNotEmpty()) counts.joinToString(", ") else "nothing on"}",
            count = dayItems.size,
        )
    }

/** A session the agenda can place: the check-in window fields plus a name. */
interface AgendaSession : SessionWindowFields {
    val id: String
    val name: String?
}

sealed class AgendaEntry<out S : AgendaSession> : CalendarOrderable {
    abstract val key: String

    data class Session<out S : AgendaSession>(
        override val key: String,
        override val date: String,
        override val sortTime: String?,
        override val name: String,
        val session: S,
    ) : AgendaEntry<S>() {
        override val allDay: Boolean get() = false
    }

    data class ClubEvent(
        override val key: String,
        override val date: String,
        override val sortTime: String?,
        override val name: String,
        val event: CalendarClubEventRow,
    ) : AgendaEntry<Nothing>() {
        override val allDay: Boolean get() = false
    }

    data class Tournament(
        override val key: String,
        override val date: String,
        override val name: String,
        val tournament: CalendarTournamentRow,
    ) : AgendaEntry<Nothing>() {
        override val allDay: Boolean get() = true
        override val sortTime: String? get() = null
    }
}

/** The instant a club event is over: its end, or start plus the default length. Null when unreadable. */
fun clubEventEndsAt(e: CalendarClubEventRow): Instant? =
    parseInstant(e.endsAt) ?: parseInstant(e.startsAt)?.plusSeconds(CLUB_EVENT_DEFAULT_DURATION_MINUTES * 60L)

/**
 * What is coming up, grouped by club day: open sessions until check-in closes,
 * club events until they are over (the soonest few, cancelled ones included),
 * and running-season tournaments not finished, not suspended and not already a
 * live card, placed on today once started.
 */
fun <S : AgendaSession> buildAgenda(
    sessions: List<S>,
    clubEvents: List<CalendarClubEventRow>,
    tournaments: List<CalendarTournamentRow>,
    now: Instant,
    todayISO: String,
    checkinSettings: CheckinSettings,
    liveTournamentIds: Set<String>,
    clubEventsCap: Int = 10,
): List<DayGroup<AgendaEntry<S>>> {
    val entries = mutableListOf<AgendaEntry<S>>()

    for (s in sessions) {
        if (!isStillUpcoming(getCheckinWindow(s, checkinSettings).closesAt, now)) continue
        entries += AgendaEntry.Session("session:${s.id}", s.date, hhmm(s.startTime), s.name ?: "Practice Session", s)
    }

    val events = clubEvents
        .filter { e -> clubEventEndsAt(e)?.let { now.isBefore(it) } == true && parseInstant(e.startsAt) != null }
        .sortedBy { parseInstant(it.startsAt) }
        .take(clubEventsCap)
    for (e in events) {
        val wall = clubEventWallClock(parseInstant(e.startsAt)!!)
        entries += AgendaEntry.ClubEvent("club_event:${e.id}", wall.date, wall.time, e.title, e)
    }

    for (t in tournaments) {
        if (t.status != "active" || t.suspendedAt != null || t.id in liveTournamentIds) continue
        if (lastDayOf(t) < todayISO) continue
        val date = if (t.startDate > todayISO) t.startDate else todayISO
        entries += AgendaEntry.Tournament("tournament:${t.id}", date, t.name, t)
    }

    return groupSessionsByDay(entries.sortedWith(compareCalendarItems), todayISO) { it.date }
}

/** "All day", "N days", "Today", "Starts today, N days" or "Day d of N". Steps ISO dates, capped at 60. */
fun tournamentWhen(t: CalendarTournamentRow, todayISO: String): String {
    val last = lastDayOf(t)
    var total = 1
    var day = 1
    var d = t.startDate
    while (d < last && total < 60) {
        total += 1
        if (d < todayISO) day += 1
        d = addDaysISO(d, 1)
    }
    if (t.startDate > todayISO) return if (total == 1) "All day" else "$total days"
    if (t.startDate == todayISO) return if (total == 1) "Today" else "Starts today, $total days"
    return "Day $day of $total"
}
