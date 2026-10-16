import Foundation

// Port of Schedule.kt (apps/player/src/lib/schedule.ts), without the month grid
// (the month calendar is desktop only on the web and not in the app). Keep in
// step with it. Every function takes the club's "today" as an argument, so one
// render reads the clock once.

let calendarWeekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
private let scheduleMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/// The day number of a YYYY-MM-DD, rolling an out-of-range month or day as Kotlin's LocalDate arithmetic does.
func isoDayNumber(_ dateISO: String) -> Int64 {
    let p = dateISO.prefix(10).split(separator: "-", omittingEmptySubsequences: false)
    func at(_ i: Int, _ fallback: Int) -> Int { i < p.count ? Int(p[i]) ?? fallback : fallback }
    return epochDay(at(0, 1970), at(1, 1), at(2, 1))
}

/// Calendar arithmetic on a bare YYYY-MM-DD. No clock or zone is read.
func addDaysISO(_ dateISO: String, _ days: Int) -> String { isoDay(isoDayNumber(dateISO) + Int64(days)) }

/// Sunday is 0, as JS getUTCDay counts.
func weekdayIndex(_ dateISO: String) -> Int {
    // 1970-01-01 was a Thursday.
    let n = (isoDayNumber(dateISO) + 4) % 7
    return Int(n < 0 ? n + 7 : n)
}

struct DayHeading: Equatable, Sendable {
    /// "Today", "Tomorrow", or a weekday.
    let label: String
    /// "14 Aug": always shown too, so a relative word is never the only anchor.
    let dateLabel: String
    let isToday: Bool
    let isTomorrow: Bool
}

func dayHeading(_ dateISO: String, _ todayISO: String) -> DayHeading {
    let date = civilDate(isoDayNumber(dateISO))
    let weekday = calendarWeekdays[weekdayIndex(dateISO)]
    let isToday = dateISO == todayISO
    let isTomorrow = dateISO == addDaysISO(todayISO, 1)
    return DayHeading(
        label: isToday ? "Today" : isTomorrow ? "Tomorrow" : weekday,
        dateLabel: "\(date.day) \(scheduleMonths[date.month - 1])",
        isToday: isToday,
        isTomorrow: isTomorrow,
    )
}

struct DayGroup<T> {
    let dateISO: String
    let sessions: [T]
    let heading: DayHeading
}

extension DayGroup: Equatable where T: Equatable {}
extension DayGroup: Sendable where T: Sendable {}

/// Bucketed by club date, oldest first, query order kept inside a day.
func groupSessionsByDay<T>(_ sessions: [T], _ todayISO: String, dateOf: (T) -> String) -> [DayGroup<T>] {
    var byDate: [String: [T]] = [:]
    for session in sessions { byDate[dateOf(session), default: []].append(session) }
    return byDate.keys.sorted().map { DayGroup(dateISO: $0, sessions: byDate[$0]!, heading: dayHeading($0, todayISO)) }
}

/// How many rows each session id has.
func tallyBySession(_ sessionIds: [String]?) -> [String: Int] {
    var counts: [String: Int] = [:]
    for id in sessionIds ?? [] { counts[id, default: 0] += 1 }
    return counts
}

enum MyState: Sendable { case checkedIn, attended, noShow, excused, going, declined, none }

/// Attendance always outranks an earlier RSVP.
func describeMyState(_ status: String?, _ intent: String?) -> MyState {
    switch (status, intent) {
    case ("checked_in"?, _): return .checkedIn
    case ("present"?, _): return .attended
    case ("no_show"?, _): return .noShow
    case ("excused"?, _): return .excused
    case (_, "going"?): return .going
    case (_, "declined"?): return .declined
    default: return .none
    }
}

/// The two statuses that mean the member was there. Not isAttendanceRecorded.
func wasPresent(_ status: String?) -> Bool { status == "checked_in" || status == "present" }

/// True once attendance is on the record, present or not.
func isAttendanceRecorded(_ status: String?) -> Bool {
    status == "checked_in" || status == "present" || status == "no_show" || status == "excused"
}

/// A night stays under Up next until its check-in window closes, whatever its status says.
func isStillUpcoming(_ closesAt: Date, now: Date) -> Bool { now < closesAt }
