import Foundation

// Port of Leaderboard.kt (the Expo app's src/lib/leaderboard.ts), which mirrors
// the web's tab filter and Elo sort (apps/player/src/app/leaderboard/
// leaderboard-client.tsx). Keep in step with it. The tournament points tab and
// win-rate sort are not here.

enum LeaderboardTab: CaseIterable, Sendable {
    case openSingles, openDoubles, compSingles, compDoubles

    var label: String {
        switch self {
        case .openSingles: return "Open S."
        case .openDoubles: return "Open D."
        case .compSingles: return "Comp S."
        case .compDoubles: return "Comp D."
        }
    }

    var isDoubles: Bool { self == .openDoubles || self == .compDoubles }
    var isCompetitive: Bool { self == .compSingles || self == .compDoubles }
}

/// One get_leaderboard() row, narrowed to what the list draws.
struct LadderRow: Equatable, Sendable {
    var id: String
    var name: String = ""
    var handle: String? = nil
    var status: String = ""
    var singlesElo: Double? = nil
    var doublesElo: Double? = nil
}

extension LadderRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        name = try row.optString("name") ?? ""
        handle = try row.optString("handle")
        status = try row.optString("status") ?? ""
        singlesElo = try row.optDouble("singles_elo")
        doublesElo = try row.optDouble("doubles_elo")
    }
}

struct RankedRow: Equatable, Sendable {
    let row: LadderRow
    let rank: Int
    let elo: Double
}

/// The tab's ladder, ordered and numbered by POSITION, as the web list is: tied
/// members get consecutive numbers in the order the stable sort leaves them.
func rankLadder(_ rows: [LadderRow], _ tab: LeaderboardTab) -> [RankedRow] {
    func eloOf(_ r: LadderRow) -> Double { (tab.isDoubles ? r.doublesElo : r.singlesElo) ?? 0 }
    let filtered = tab.isCompetitive ? rows.filter { $0.status == "competitive" } : rows
    return filtered.enumerated()
        .sorted { a, b in
            let ea = eloOf(a.element)
            let eb = eloOf(b.element)
            return ea != eb ? ea > eb : a.offset < b.offset
        }
        .enumerated()
        .map { RankedRow(row: $0.element.element, rank: $0.offset + 1, elo: eloOf($0.element.element)) }
}

/// The member's place on the Open Singles ladder as the web's My stats counts
/// it: RANK(), 1 + the members strictly above. Nil, never last place, when the
/// member is not in the RPC's rows at all or has no rating.
func ladderPosition(_ rows: [LadderRow], playerId: String, mySinglesElo: Double?) -> Int? {
    guard let mySinglesElo else { return nil }
    guard rows.contains(where: { $0.id == playerId }) else { return nil }
    return 1 + rows.filter { ($0.singlesElo ?? 0) > mySinglesElo }.count
}

/// get_leaderboard() is the database's own filtered ladder: hidden, pending and suspended are left out.
func loadLadder(_ postgrest: Postgrest) async throws -> [LadderRow] {
    try await postgrest.list(PostgrestQuery.rpc("get_leaderboard"), what: "the ladder", LadderRow.init(json:))
}
