import Foundation

// Port of FeedActivity.kt (apps/player/src/lib/feed-activity.ts), less
// sessionDayLabel (the feed does not use it). Keep in step with it.
//
// The web reads the club day through Intl with no tzdata pin. Here every day
// key goes through clubToday, so past 2026-11-01 it stays at UTC-07:00 on a
// phone whose zone database is older. The web's own tests all sit before the
// cutover, so the same inputs give the same outputs.

/// The club day an instant falls on, YYYY-MM-DD. The first ten characters when unreadable.
func clubDayKey(_ iso: String) -> String {
    guard let at = parseInstant(iso) else { return String(iso.prefix(10)) }
    return clubToday(at)
}

/// Shifts a YYYY-MM-DD key by whole days.
func shiftDayKey(_ key: String, _ days: Int) -> String { addDaysISO(key, days) }

private let enGBWeekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
private let enGBMonths = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEPT", "OCT", "NOV", "DEC"]

/// "TODAY", "YESTERDAY" or "WED 4 AUG", as en-GB Intl prints it (so September is "SEPT").
func dayLabel(_ key: String, _ todayKey: String) -> String {
    if key == todayKey { return "TODAY" }
    if key == shiftDayKey(todayKey, -1) { return "YESTERDAY" }
    let c = civilDate(isoDayNumber(key))
    return "\(enGBWeekdays[weekdayIndex(key)]) \(c.day) \(enGBMonths[c.month - 1])"
}

struct DaySection<T> {
    let key: String
    let label: String
    let items: [T]
}

extension DaySection: Equatable where T: Equatable {}
extension DaySection: Sendable where T: Sendable {}

/// Club days, newest first, newest first inside a day too. Sorts rather than trusting the caller.
func groupByDay<T>(_ items: [T], now: Date, atOf: (T) -> String) -> [DaySection<T>] {
    let todayKey = clubToday(now)
    let sorted = items.enumerated()
        .sorted { a, b in
            let x = atOf(a.element), y = atOf(b.element)
            return x == y ? a.offset < b.offset : x > y
        }
        .map(\.element)
    var keys: [String] = []
    var sections: [String: [T]] = [:]
    for item in sorted {
        let key = clubDayKey(atOf(item))
        if sections[key] == nil { keys.append(key) }
        sections[key, default: []].append(item)
    }
    return keys.sorted(by: >).map { DaySection(key: $0, label: dayLabel($0, todayKey), items: sections[$0]!) }
}

/// The week of the season, 1-based, inclusive of the start day. Nil before it begins.
func seasonWeek(_ startDate: String, now: Date) -> Int? {
    let start = String(startDate.prefix(10))
    let today = clubToday(now)
    if today < start { return nil }
    let days = isoDayNumber(today) - isoDayNumber(start)
    return Int(days / 7) + 1
}

/// How many of the most recent sessions in a row the member was at.
func attendanceStreak(_ pastSessionIdsNewestFirst: [String], _ attendedIds: Set<String>) -> Int {
    var streak = 0
    for id in pastSessionIdsNewestFirst {
        if !attendedIds.contains(id) { break }
        streak += 1
    }
    return streak
}

struct RiverPerson: Equatable, Sendable {
    let id: String
    let name: String
    let handle: String?
    let avatarUrl: String?
}

/// "You beat X", "X beat you", or "X beat Y"; doubles pairs joined with "&".
func describeMatch(_ winners: [RiverPerson], _ losers: [RiverPerson], viewerId: String) -> String? {
    if winners.isEmpty || losers.isEmpty { return nil }
    func names(_ people: [RiverPerson]) -> String { people.map(\.name).joined(separator: " & ") }
    if winners.contains(where: { $0.id == viewerId }) { return "You beat \(names(losers))" }
    if losers.contains(where: { $0.id == viewerId }) { return "\(names(winners)) beat you" }
    return "\(names(winners)) beat \(names(losers))"
}
