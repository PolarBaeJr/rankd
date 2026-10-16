import Foundation

// Port of CalendarItems.kt: apps/player/src/lib/calendar-items.ts, less
// buildCalendarMonth (the month grid is not in the app), plus tournamentWhen
// from apps/player/src/app/feed/agenda-rows.tsx. Keep in step with them.
//
// One difference: a club event whose starts_at cannot be read is left out. On
// the web such a row throws while it renders.

enum CalendarTone: Sendable { case open, closed, club, tournament, cancelled }

enum CalendarItemKind: Sendable { case session, clubEvent, tournament }

/// What compareCalendarItems orders by.
protocol CalendarOrderable {
    var date: String { get }
    var allDay: Bool { get }
    var sortTime: String? { get }
    var name: String { get }
}

/// One entry on the week strip.
struct CalendarItem: CalendarOrderable, Equatable, Sendable {
    let key: String
    let id: String
    let kind: CalendarItemKind
    let date: String
    let allDay: Bool
    let sortTime: String?
    let name: String
    let timeLabel: String?
    let tone: CalendarTone
    let mine: Bool
    /// "#session-<id>" for a card on the page, a web path, or nil for plain text.
    let href: String?
}

struct CalendarSessionRow: Equatable, Sendable {
    var id: String = ""
    var name: String? = nil
    var date: String = ""
    var startTime: String? = nil
    var status: String = ""
    var seasonId: String? = nil
}

extension CalendarSessionRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        name = try row.optString("name")
        date = try row.optString("date") ?? ""
        startTime = try row.optString("start_time")
        status = try row.optString("status") ?? ""
        seasonId = try row.optString("season_id")
    }
}

struct CalendarClubEventRow: Equatable, Sendable {
    var id: String = ""
    var title: String = ""
    var kind: String = ""
    var location: String? = nil
    var startsAt: String = ""
    var endsAt: String? = nil
    var status: String = ""
}

extension CalendarClubEventRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        title = try row.optString("title") ?? ""
        kind = try row.optString("kind") ?? ""
        location = try row.optString("location")
        startsAt = try row.optString("starts_at") ?? ""
        endsAt = try row.optString("ends_at")
        status = try row.optString("status") ?? ""
    }
}

struct CalendarTournamentRow: Equatable, Sendable {
    var id: String = ""
    var name: String = ""
    var startDate: String = ""
    var endDate: String? = nil
    var status: String = ""
    var suspendedAt: String? = nil
}

extension CalendarTournamentRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        name = try row.optString("name") ?? ""
        startDate = try row.optString("start_date") ?? ""
        endDate = try row.optString("end_date")
        status = try row.optString("status") ?? ""
        suspendedAt = try row.optString("suspended_at")
    }
}

private func hhmm(_ time: String?) -> String? {
    guard let time, !time.isEmpty else { return nil }
    return String(time.prefix(5))
}

func sessionCalendarItem(_ s: CalendarSessionRow, mine: Bool, hasCard: Bool) -> CalendarItem {
    CalendarItem(
        key: "session:\(s.id)",
        id: s.id,
        kind: .session,
        date: s.date,
        allDay: false,
        sortTime: hhmm(s.startTime),
        name: s.name ?? "Practice Session",
        timeLabel: (s.startTime ?? "").isEmpty ? nil : formatTime(s.startTime!),
        tone: s.status == "open" ? .open : .closed,
        mine: mine,
        href: hasCard ? "#session-\(s.id)" : nil,
    )
}

func clubEventCalendarItem(_ e: CalendarClubEventRow, mine: Bool) -> CalendarItem? {
    guard let at = parseInstant(e.startsAt) else { return nil }
    let wall = clubEventWallClock(at)
    return CalendarItem(
        key: "club_event:\(e.id)",
        id: e.id,
        kind: .clubEvent,
        date: wall.date,
        allDay: false,
        sortTime: wall.time,
        name: e.title,
        timeLabel: formatTime(wall.time),
        tone: e.status == "cancelled" ? .cancelled : .club,
        mine: mine,
        href: "/events/\(e.id)",
    )
}

private func lastDayOf(_ t: CalendarTournamentRow) -> String {
    if let end = t.endDate, end > t.startDate { return end }
    return t.startDate
}

/// One all-day item per day the tournament runs, capped so a typo in end_date cannot paint a month.
func tournamentCalendarItems(_ t: CalendarTournamentRow, maxDays: Int = 7) -> [CalendarItem] {
    let last = lastDayOf(t)
    var items: [CalendarItem] = []
    var date = t.startDate
    while date <= last && items.count < maxDays {
        items.append(CalendarItem(
            key: "tournament:\(t.id):\(date)",
            id: t.id,
            kind: .tournament,
            date: date,
            allDay: true,
            sortTime: nil,
            name: t.name,
            timeLabel: nil,
            tone: .tournament,
            mine: false,
            href: "/tournaments/\(t.id)",
        ))
        date = addDaysISO(date, 1)
    }
    return items
}

/// localeCompare's order: "alpha" before "Alpha" before "beta".
private func nameOrder(_ a: String, _ b: String) -> ComparisonResult {
    a.compare(b, options: [], range: nil, locale: Locale(identifier: "en"))
}

/// By date, then all-day first, then by time with untimed last, then by name. True when a sorts first.
func compareCalendarItems(_ a: CalendarOrderable, _ b: CalendarOrderable) -> Bool {
    if a.date != b.date { return a.date < b.date }
    if a.allDay != b.allDay { return a.allDay }
    if a.sortTime != b.sortTime {
        guard let at = a.sortTime else { return false }
        guard let bt = b.sortTime else { return true }
        return at < bt
    }
    return nameOrder(a.name, b.name) == .orderedAscending
}

/// A stable sort by compareCalendarItems, as Kotlin's sortedWith is.
func sortedCalendar<T: CalendarOrderable>(_ items: [T]) -> [T] {
    items.enumerated()
        .sorted { x, y in
            if compareCalendarItems(x.element, y.element) { return true }
            if compareCalendarItems(y.element, x.element) { return false }
            return x.offset < y.offset
        }
        .map(\.element)
}

struct WeekStripDay: Equatable, Sendable {
    let dateISO: String
    /// "Tue".
    let weekday: String
    let day: Int
    let isToday: Bool
    /// Up to three, in day order.
    let marks: [CalendarTone]
    let more: Int
    /// The whole day in words, for a screen reader: "Tue 14: 1 session, 1 club event".
    let summary: String
    let count: Int
}

private let weekMarks = 3

private let kindWords: [(CalendarItemKind, String, String)] = [
    (.session, "session", "sessions"),
    (.clubEvent, "club event", "club events"),
    (.tournament, "tournament", "tournaments"),
]

/// The seven days from today, each with its items as colour marks.
func buildWeekStrip(_ items: [CalendarItem], _ todayISO: String, days: Int = 7) -> [WeekStripDay] {
    (0..<days).map { i in
        let dateISO = addDaysISO(todayISO, i)
        let dayItems = sortedCalendar(items.filter { $0.date == dateISO })
        let weekday = calendarWeekdays[weekdayIndex(dateISO)]
        let day = Int(dateISO.dropFirst(8).prefix(2)) ?? 0
        let counts: [String] = kindWords.compactMap { kind, one, many in
            let n = dayItems.filter { $0.kind == kind }.count
            return n > 0 ? "\(n) \(n == 1 ? one : many)" : nil
        }
        return WeekStripDay(
            dateISO: dateISO,
            weekday: weekday,
            day: day,
            isToday: i == 0,
            marks: dayItems.prefix(weekMarks).map(\.tone),
            more: max(dayItems.count - weekMarks, 0),
            summary: "\(weekday) \(day): \(counts.isEmpty ? "nothing on" : counts.joined(separator: ", "))",
            count: dayItems.count,
        )
    }
}

/// A session the agenda can place: the check-in window fields plus a name.
protocol AgendaSession: SessionWindowFields {
    var id: String { get }
    var name: String? { get }
}

enum AgendaEntry<S: AgendaSession>: CalendarOrderable {
    case session(key: String, date: String, sortTime: String?, name: String, session: S)
    case clubEvent(key: String, date: String, sortTime: String?, name: String, event: CalendarClubEventRow)
    case tournament(key: String, date: String, name: String, tournament: CalendarTournamentRow)

    var key: String {
        switch self {
        case let .session(key, _, _, _, _), let .clubEvent(key, _, _, _, _), let .tournament(key, _, _, _): return key
        }
    }

    var date: String {
        switch self {
        case let .session(_, date, _, _, _), let .clubEvent(_, date, _, _, _), let .tournament(_, date, _, _): return date
        }
    }

    var sortTime: String? {
        switch self {
        case let .session(_, _, time, _, _), let .clubEvent(_, _, time, _, _): return time
        case .tournament: return nil
        }
    }

    var name: String {
        switch self {
        case let .session(_, _, _, name, _), let .clubEvent(_, _, _, name, _), let .tournament(_, _, name, _): return name
        }
    }

    var allDay: Bool {
        if case .tournament = self { return true }
        return false
    }
}

/// The instant a club event is over: its end, or start plus the default length. Nil when unreadable.
func clubEventEndsAt(_ e: CalendarClubEventRow) -> Date? {
    parseInstant(e.endsAt) ?? parseInstant(e.startsAt)?.addingTimeInterval(Double(clubEventDefaultDurationMinutes * 60))
}

/**
 * What is coming up, grouped by club day: open sessions until check-in closes,
 * club events until they are over (the soonest few, cancelled ones included),
 * and running-season tournaments not finished, not suspended and not already a
 * live card, placed on today once started.
 */
func buildAgenda<S: AgendaSession>(
    sessions: [S],
    clubEvents: [CalendarClubEventRow],
    tournaments: [CalendarTournamentRow],
    now: Date,
    todayISO: String,
    checkinSettings: CheckinSettings,
    liveTournamentIds: Set<String>,
    clubEventsCap: Int = 10,
) -> [DayGroup<AgendaEntry<S>>] {
    var entries: [AgendaEntry<S>] = []

    for s in sessions where isStillUpcoming(getCheckinWindow(s, checkinSettings).closesAt, now: now) {
        entries.append(.session(key: "session:\(s.id)", date: s.date, sortTime: hhmm(s.startTime), name: s.name ?? "Practice Session", session: s))
    }

    let events = clubEvents
        .filter { e in clubEventEndsAt(e).map { now < $0 } == true && parseInstant(e.startsAt) != nil }
        .enumerated()
        .sorted { a, b in
            let x = parseInstant(a.element.startsAt)!, y = parseInstant(b.element.startsAt)!
            return x == y ? a.offset < b.offset : x < y
        }
        .prefix(clubEventsCap)
        .map(\.element)
    for e in events {
        let wall = clubEventWallClock(parseInstant(e.startsAt)!)
        entries.append(.clubEvent(key: "club_event:\(e.id)", date: wall.date, sortTime: wall.time, name: e.title, event: e))
    }

    for t in tournaments {
        if t.status != "active" || t.suspendedAt != nil || liveTournamentIds.contains(t.id) { continue }
        if lastDayOf(t) < todayISO { continue }
        let date = t.startDate > todayISO ? t.startDate : todayISO
        entries.append(.tournament(key: "tournament:\(t.id)", date: date, name: t.name, tournament: t))
    }

    return groupSessionsByDay(sortedCalendar(entries), todayISO) { $0.date }
}

/// "All day", "N days", "Today", "Starts today, N days" or "Day d of N". Steps ISO dates, capped at 60.
func tournamentWhen(_ t: CalendarTournamentRow, _ todayISO: String) -> String {
    let last = lastDayOf(t)
    var total = 1
    var day = 1
    var d = t.startDate
    while d < last && total < 60 {
        total += 1
        if d < todayISO { day += 1 }
        d = addDaysISO(d, 1)
    }
    if t.startDate > todayISO { return total == 1 ? "All day" : "\(total) days" }
    if t.startDate == todayISO { return total == 1 ? "Today" : "Starts today, \(total) days" }
    return "Day \(day) of \(total)"
}
