import Foundation

// Port of ClubClock.kt: wallClockToUtc and the check-in window from
// packages/shared/src/utils/session-window.ts, utcToClubWallClock and
// clubEventWallClock from club-events.ts, and formatTime from helpers.ts. Keep
// in step with them. formatRelativeTime already lives in Challenges.swift.
//
// The same two-era rule as clubToday in ClubTime.swift: from 2026-11-01 the club
// offset is a constant UTC-07:00 and the zone database is not asked. Before that
// date every tzdata release agrees about Vancouver, so the zone rules are used.
// Dates are done with integer day arithmetic, never a DateFormatter, so the
// phone's locale and calendar settings cannot change what is sent or shown.

private let pinnedOffsetSeconds: Int64 = -7 * 3600
private let enUSMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

private func floorDiv64(_ a: Int64, _ b: Int64) -> Int64 {
    let q = a / b
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
}

private func floorMod64(_ a: Int64, _ b: Int64) -> Int64 { a - floorDiv64(a, b) * b }

/// Days since 1970-01-01 for a proleptic Gregorian date. Month outside 1...12 rolls the year.
func epochDay(_ year: Int, _ month: Int, _ day: Int) -> Int64 {
    let total = Int64(year) * 12 + Int64(month - 1)
    let y0 = floorDiv64(total, 12)
    let m = floorMod64(total, 12) + 1
    let y = m <= 2 ? y0 - 1 : y0
    let era = floorDiv64(y, 400)
    let yoe = y - era * 400
    let mp = (m + 9) % 12
    let doy = (153 * mp + 2) / 5
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468 + Int64(day - 1)
}

/// The date of a day number, the inverse of epochDay.
func civilDate(_ days: Int64) -> (year: Int, month: Int, day: Int) {
    let z = days + 719_468
    let era = floorDiv64(z, 146_097)
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = mp < 10 ? mp + 3 : mp - 9
    let y = yoe + era * 400 + (m <= 2 ? 1 : 0)
    return (Int(y), Int(m), Int(d))
}

private func pad(_ n: Int, _ width: Int) -> String {
    let s = String(n)
    return s.count >= width ? s : String(repeating: "0", count: width - s.count) + s
}

func isoDay(_ days: Int64) -> String {
    let c = civilDate(days)
    return pad(c.year, 4) + "-" + pad(c.month, 2) + "-" + pad(c.day, 2)
}

private let pinFromDay = epochDay(2026, 11, 1)

private func millisOf(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded(.down)) }

private func dateOf(millis: Int64) -> Date { Date(timeIntervalSince1970: Double(millis) / 1000) }

/// An instant as JS toISOString prints it, milliseconds always included. What PostgREST is sent.
func isoMillis(_ at: Date) -> String {
    let ms = millisOf(at)
    let day = floorDiv64(ms, 86_400_000)
    let rest = Int(ms - day * 86_400_000)
    return isoDay(day) + "T" + pad(rest / 3_600_000, 2) + ":" + pad(rest / 60_000 % 60, 2) + ":" +
        pad(rest / 1000 % 60, 2) + "." + pad(rest % 1000, 3) + "Z"
}

/// A timestamp as PostgREST returns it, or a bare date read as UTC midnight as JS does. Nil when unreadable.
func parseInstant(_ iso: String?) -> Date? {
    guard let iso, !iso.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    if let ms = epochMillis(iso.replacingOccurrences(of: " ", with: "T")) { return dateOf(millis: ms) }
    return parseIsoDay(iso)
}

/// The Vancouver offset at an instant, in seconds.
private func zoneOffset(_ utcSeconds: Int64) -> Int64 {
    Int64(TimeZone(identifier: clubTimezone)!.secondsFromGMT(for: Date(timeIntervalSince1970: Double(utcSeconds))))
}

/**
 * A club wall-clock time as a UTC instant. Day overflow rolls, as Date.UTC does:
 * day + 1 is the next-day-midnight bound. Before the pin this is the two-pass
 * technique the web uses, with the same tie-breaks at the historical DST edges.
 */
func wallClockToUtc(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
    let naive = epochDay(year, month, day) * 86400 + Int64(hour) * 3600 + Int64(minute) * 60
    if floorDiv64(naive, 86400) >= pinFromDay { return Date(timeIntervalSince1970: Double(naive - pinnedOffsetSeconds)) }
    let offset1 = zoneOffset(naive)
    let offset2 = zoneOffset(naive - offset1)
    return Date(timeIntervalSince1970: Double(naive - offset2))
}

/// Seconds since the epoch on the club's wall clock.
private func clubLocalSeconds(_ at: Date) -> Int64 {
    let utc = floorDiv64(millisOf(at), 1000)
    let pinned = utc + pinnedOffsetSeconds
    if floorDiv64(pinned, 86400) >= pinFromDay { return pinned }
    return utc + zoneOffset(utc)
}

/// A stored instant as the club wall clock, `YYYY-MM-DDTHH:MM`.
func utcToClubWallClock(_ at: Date) -> String {
    let local = clubLocalSeconds(at)
    let day = floorDiv64(local, 86400)
    let rest = Int(local - day * 86400)
    return isoDay(day) + "T" + pad(rest / 3600, 2) + ":" + pad(rest / 60 % 60, 2)
}

struct ClubWallClock: Equatable, Sendable {
    let date: String
    let time: String
}

/// The club date and time a stored instant falls on, e.g. 2026-11-02 and 00:30.
func clubEventWallClock(_ at: Date) -> ClubWallClock {
    let wall = utcToClubWallClock(at)
    return ClubWallClock(date: String(wall.prefix(10)), time: String(wall.suffix(5)))
}

let clubEventKindLabels: [String: String] = [
    "social": "Social",
    "workshop": "Workshop",
    "clinic": "Clinic",
    "outing": "Outing",
    "agm": "AGM",
    "other": "Other",
]

let clubEventDefaultDurationMinutes = 120

/// "18:30:00" (or "18:30") to "6:30 PM". For Postgres TIME columns.
func formatTime(_ time: String) -> String {
    let parts = time.split(separator: ":", omittingEmptySubsequences: false)
    let hour = parts.first.flatMap { Int($0) } ?? 0
    let minute = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
    let period = hour >= 12 ? "PM" : "AM"
    let hour12 = hour % 12 == 0 ? 12 : hour % 12
    return "\(hour12):\(pad(minute, 2)) \(period)"
}

/// An instant's club date in the en-US short form, "Aug 1, 2026".
func clubDate(_ at: Date) -> String {
    let c = civilDate(floorDiv64(clubLocalSeconds(at), 86400))
    return "\(enUSMonths[c.month - 1]) \(c.day), \(c.year)"
}

/// The fields the check-in window reads. startsAt/endsAt win when the row carries them.
protocol SessionWindowFields {
    var date: String { get }
    var startTime: String? { get }
    var endTime: String? { get }
    var status: String? { get }
    var startsAt: String? { get }
    var endsAt: String? { get }
}

struct CheckinSettings: Equatable, Sendable {
    let defaultDurationMinutes: Double
    let opensMinutesBefore: Double?
}

/// What the web renders with when the settings row cannot be read (constants.ts).
let fallbackCheckinSettings = CheckinSettings(defaultDurationMinutes: 60, opensMinutesBefore: 30)

/// JS Number() on a JSON value: undefined is NaN, null and "" are 0.
private func jsNumber(_ value: JSONValue?) -> Double {
    switch value {
    case nil: return .nan
    case .null?: return 0
    case let .string(s)?:
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? 0 : Double(t) ?? .nan
    case let .bool(b)?: return b ? 1 : 0
    case let .int(n)?: return Double(n)
    case let .double(d)?: return d
    default: return .nan
    }
}

/**
 * The platform_settings 'session_attendance' value, coerced as the database
 * coerces it: duration falls back to 120 and a missing opening edge is nil.
 * Deliberately not fallbackCheckinSettings; see the web's comment.
 */
func parseCheckinSettings(_ value: JSONValue?) -> CheckinSettings {
    let row = value?.isObject == true ? value : nil
    let duration = jsNumber(row?["default_duration_minutes"])
    let opensRaw = row?["checkin_opens_minutes_before"]
    let opens = jsNumber(opensRaw)
    var opensIsNull = opensRaw == nil
    if case .null? = opensRaw { opensIsNull = true }
    return CheckinSettings(
        defaultDurationMinutes: duration.isFinite ? duration : 120,
        opensMinutesBefore: opensIsNull || !opens.isFinite ? nil : opens,
    )
}

struct CheckinWindow: Equatable, Sendable {
    let opensAt: Date?
    let closesAt: Date
}

private func dateParts(_ date: String) -> (Int, Int, Int) {
    let p = date.split(separator: "-", omittingEmptySubsequences: false)
    func at(_ i: Int, _ fallback: Int) -> Int { i < p.count ? Int(p[i]) ?? fallback : fallback }
    return (at(0, 0), at(1, 1), at(2, 1))
}

private func timeParts(_ time: String) -> (Int, Int) {
    let p = time.split(separator: ":", omittingEmptySubsequences: false)
    return (p.first.flatMap { Int($0) } ?? 0, p.count > 1 ? Int(p[1]) ?? 0 : 0)
}

private func plusMinutes(_ at: Date, _ minutes: Double) -> Date {
    dateOf(millis: millisOf(at) + Int64(minutes * 60_000))
}

private func nonEmpty(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}

private func resolveStart(_ session: SessionWindowFields) -> Date {
    if let at = parseInstant(session.startsAt) { return at }
    let (y, m, d) = dateParts(session.date)
    let (h, min) = timeParts(nonEmpty(session.startTime) ?? "00:00")
    return wallClockToUtc(y, m, d, h, min)
}

/// Same rules as session_checkin_open: end_time, else start plus the duration, else the next club midnight.
func getCheckinWindow(_ session: SessionWindowFields, _ settings: CheckinSettings = fallbackCheckinSettings) -> CheckinWindow {
    let startAt = resolveStart(session)
    let closesAt: Date
    if parseInstant(session.startsAt) != nil {
        closesAt = parseInstant(session.endsAt) ?? plusMinutes(startAt, settings.defaultDurationMinutes)
    } else {
        let (y, m, d) = dateParts(session.date)
        if let end = nonEmpty(session.endTime) {
            let (h, min) = timeParts(end)
            closesAt = wallClockToUtc(y, m, d, h, min)
        } else if nonEmpty(session.startTime) != nil {
            closesAt = plusMinutes(startAt, settings.defaultDurationMinutes)
        } else {
            closesAt = wallClockToUtc(y, m, d + 1, 0, 0)
        }
    }
    let opensAt = settings.opensMinutesBefore.map { plusMinutes(startAt, -$0) }
    return CheckinWindow(opensAt: opensAt, closesAt: closesAt)
}

func isCheckinOpen(_ session: SessionWindowFields, now: Date, _ settings: CheckinSettings = fallbackCheckinSettings) -> Bool {
    if let status = session.status, status != "open" { return false }
    let window = getCheckinWindow(session, settings)
    if let opensAt = window.opensAt, now < opensAt { return false }
    return now < window.closesAt
}
