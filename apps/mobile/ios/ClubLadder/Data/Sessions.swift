import Foundation

// Port of Sessions.kt (the Expo app's src/lib/sessions.ts). Keep in step with
// it. The schedule itself now lives on the Feed (Data/Feed.swift).

struct ActiveSeasonRow: Equatable, Sendable {
    let id: String
    let name: String?
}

extension ActiveSeasonRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        name = try row.optString("name")
    }
}

/// get_active_season() returns a set; the first row is the season, none means no season.
func loadActiveSeason(_ postgrest: Postgrest) async throws -> ActiveSeasonRow? {
    try await postgrest.list(PostgrestQuery.rpc("get_active_season"), what: "the season", ActiveSeasonRow.init(json:)).first
}

/// A strict YYYY-MM-DD at UTC midnight, as LocalDate.parse reads it: 2026-02-30 is refused.
func parseIsoDay(_ text: String) -> Date? {
    guard let m = text.wholeMatch(of: /(\d{4})-(\d{2})-(\d{2})/),
          let y = Int(m.1), let mo = Int(m.2), let d = Int(m.3) else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    guard let date = calendar.date(from: DateComponents(year: y, month: mo, day: d)) else { return nil }
    let back = calendar.dateComponents([.year, .month, .day], from: date)
    guard back.year == y, back.month == mo, back.day == d else { return nil }
    return date
}
