import Foundation

// Port of clubToday() in packages/shared/src/utils/session-window.ts, via
// ClubTime.kt, with the pin explained beside CLUB_PERMANENT_OFFSET_FROM there.
// Keep in step with it.
//
// From 2026-11-01 British Columbia stays on UTC-07:00 for good, but a phone's
// timezone data may predate that change and still say UTC-08:00 in winter. So
// past that date the offset is a constant and the zone database is not asked.

let clubTimezone = "America/Vancouver"
let clubPermanentOffsetFrom = "2026-11-01"
private let clubPermanentOffsetSeconds = -7 * 3600

/// Today's date on the club's clock, as YYYY-MM-DD.
func clubToday(_ now: Date = Date()) -> String {
    let pinned = isoDate(now, TimeZone(secondsFromGMT: clubPermanentOffsetSeconds)!)
    // YYYY-MM-DD sorts as a plain string.
    if pinned >= clubPermanentOffsetFrom { return pinned }
    return isoDate(now, TimeZone(identifier: clubTimezone)!)
}

private func isoDate(_ date: Date, _ zone: TimeZone) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
}
