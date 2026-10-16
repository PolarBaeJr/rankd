import Foundation

// Port of FeedTournament.kt: apps/player/src/lib/feed-tournament.ts and
// occupiesAPlace and countEnteredPlayers in tournament-index.ts. Keep in step
// with them. The date bound in isUnderWay is the load-bearing half: nothing
// walks a finished event back to completed, so a status-only test would show a
// stale "UNDER WAY".

struct FeedEvent: Equatable, Sendable {
    var id: String = ""
    var eventType: String = ""
    var status: String = ""
}

extension FeedEvent {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        eventType = try row.optString("event_type") ?? ""
        status = try row.optString("status") ?? ""
    }
}

struct FeedTournament: Equatable, Sendable {
    var id: String = ""
    var name: String = ""
    var startDate: String = ""
    var endDate: String? = nil
    var tournamentEvents: [FeedEvent]? = nil
}

extension FeedTournament {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        name = try row.optString("name") ?? ""
        startDate = try row.optString("start_date") ?? ""
        endDate = try row.optString("end_date")
        if let events = row.optValue("tournament_events") {
            guard let items = events.arrayValue else { throw DecodeError(message: "tournament_events is not a list") }
            tournamentEvents = try items.map(FeedEvent.init(json:))
        }
    }
}

let tournamentEventTypeLabels: [String: String] = [
    "mens_singles": "Men's Singles",
    "womens_singles": "Women's Singles",
    "open_singles": "Open Singles",
    "mens_doubles": "Men's Doubles",
    "womens_doubles": "Women's Doubles",
    "mixed_doubles": "Mixed Doubles",
    "open_doubles": "Open Doubles",
]

/// Neither taking entries nor finished. A deny-list, so a new mid-lifecycle status counts as running.
func isRunningEvent(_ event: FeedEvent) -> Bool { event.status != "registration" && event.status != "completed" }

/// Drawn or being played, as opposed to merely open for check-in.
func isPlayingEvent(_ event: FeedEvent) -> Bool {
    ["pool_generated", "pool_live", "bracket_generated", "live"].contains(event.status)
}

/// The last club day the tournament can be "on": end_date, else start_date.
func lastDayOf(_ startDate: String, _ endDate: String?) -> String { String((endDate ?? startDate).prefix(10)) }

func isUnderWay(_ t: FeedTournament, _ todayKey: String) -> Bool {
    if lastDayOf(t.startDate, t.endDate) < todayKey { return false }
    return (t.tournamentEvents ?? []).contains(where: isRunningEvent)
}

/// The running events, in the order the query returned them.
func runningEvents(_ t: FeedTournament) -> [FeedEvent] { (t.tournamentEvents ?? []).filter(isRunningEvent) }

func underWayEyebrow(_ events: [FeedEvent]) -> String { events.contains(where: isPlayingEvent) ? "UNDER WAY" : "CHECK-IN OPEN" }

/// Still holding a place in the draw, as the server's capacity check counts it.
func occupiesAPlace(_ status: String) -> Bool { status != "withdrawn" && status != "disqualified" }

struct EntrantRow: Equatable, Sendable {
    let playerId: String
    let status: String
}

struct EntrantPairRow: Equatable, Sendable {
    let player1Id: String
    let player2Id: String
    let status: String
}

/// People entered, counted once each across singles and doubles.
func countEnteredPlayers(_ participants: [EntrantRow], _ pairs: [EntrantPairRow]) -> Int {
    var players = Set<String>()
    for p in participants where occupiesAPlace(p.status) { players.insert(p.playerId) }
    for p in pairs where occupiesAPlace(p.status) {
        players.insert(p.player1Id)
        players.insert(p.player2Id)
    }
    return players.count
}
