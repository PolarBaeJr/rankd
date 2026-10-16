import Foundation

// Port of MyStats.kt (the Expo app's src/lib/my-stats.ts and the formatters
// from its MyStatsScreen.tsx), which mirror the current-season branch of
// apps/player/src/app/my-stats/page.tsx. Keep in step with them. The app reads
// Elo and never computes it, so no rating engine is ported.

/// The match window the web reads: a season and a half of heavy play.
let matchWindow = 200

/// How many of those get a row in the recent list.
let historyRows = 20

/// The web's select, verbatim, so both apps read the same rows.
let myMatchesSelect =
    "id, season_id, played_at, match_type, format, rated_flag, completed_flag, result_status, score_summary, " +
    "participants:match_participants!inner(id, player_id, win_flag, rating_delta, post_rating, team_side, " +
    "points_scored, points_allowed)"

struct OwnParticipant: Equatable, Sendable {
    var playerId: String? = nil
    var winFlag: Bool? = nil
    var ratingDelta: Double? = nil
    var pointsScored: Int? = nil
    var pointsAllowed: Int? = nil
}

extension OwnParticipant {
    init(json: JSONValue) throws {
        let row = try json.object()
        playerId = try row.optString("player_id")
        winFlag = try row.optBool("win_flag")
        ratingDelta = try row.optDouble("rating_delta")
        pointsScored = try row.optInt("points_scored")
        pointsAllowed = try row.optInt("points_allowed")
    }
}

struct MyMatchRow: Equatable, Sendable {
    var id: String
    var seasonId: String? = nil
    var playedAt: String? = nil
    var matchType: String? = nil
    var resultStatus: String? = nil
    var scoreSummary: String? = nil
    var participants: JSONValue? = nil
}

extension MyMatchRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        seasonId = try row.optString("season_id")
        playedAt = try row.optString("played_at")
        matchType = try row.optString("match_type")
        resultStatus = try row.optString("result_status")
        scoreSummary = try row.optString("score_summary")
        participants = row.optValue("participants")
    }
}

/// The member's own participant row, matched on player_id rather than taken as
/// the first element: if the embed filter ever stops narrowing the array, the
/// first element is an OPPONENT and every figure is plausibly wrong.
func ownParticipant(_ match: MyMatchRow, playerId: String) throws -> OwnParticipant? {
    let rows: [JSONValue]
    switch match.participants {
    case let .array(items)?: rows = items
    case let .some(obj) where obj.isObject: rows = [obj]
    default: rows = []
    }
    return try rows.map(OwnParticipant.init(json:)).first { $0.playerId == playerId }
}

private func seasonRowOf(_ match: MyMatchRow, _ own: OwnParticipant?) -> SeasonMatchRow {
    SeasonMatchRow(
        matchType: match.matchType,
        resultStatus: match.resultStatus,
        winFlag: own?.winFlag,
        pointsScored: own?.pointsScored,
        pointsAllowed: own?.pointsAllowed,
        playedAt: match.playedAt,
    )
}

/// This season's matches only, counted from match rows and never read off `ratings`.
func seasonRecordRows(_ matches: [MyMatchRow], activeSeasonId: String?, playerId: String) throws -> [SeasonMatchRow] {
    guard let activeSeasonId else { return [] }
    return try matches.filter { $0.seasonId == activeSeasonId }.map { seasonRowOf($0, try ownParticipant($0, playerId: playerId)) }
}

/// Math.round semantics: ties go up, so -2.5 is -2. Never Swift's rounded(),
/// which rounds ties away from zero.
func roundHalfUp(_ x: Double) -> Int { Int(floor(x + 0.5)) }

func fmtElo(_ elo: Double?) -> String { elo.map { String(roundHalfUp($0)) } ?? "-" }

func fmtDelta(_ delta: Double?) -> String {
    guard let delta else { return "" }
    let rounded = roundHalfUp(delta)
    return rounded > 0 ? "+\(rounded)" : String(rounded)
}

struct RecentMatch: Equatable, Sendable {
    let id: String
    let playedAt: String?
    let type: String?
    let outcome: Bool?
    let delta: Double?
    let score: String?
}

struct MyStats: Equatable, Sendable {
    let singlesElo: Double?
    let doublesElo: Double?
    let position: Int?
    let seasonName: String?
    let record: SeasonRecord?
    let recent: [RecentMatch]
}

struct RatingRow: Equatable, Sendable {
    var singlesElo: Double? = nil
    var doublesElo: Double? = nil
}

extension RatingRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        singlesElo = try row.optDouble("singles_elo")
        doublesElo = try row.optDouble("doubles_elo")
    }
}

func myMatchesQuery(_ playerId: String) -> PostgrestQuery {
    PostgrestQuery.select("matches", myMatchesSelect)
        .eq("participants.player_id", playerId)
        .notIsNull("played_at")
        .order("played_at", ascending: false)
        .limit(matchWindow)
}

/// The screen's figures from the four reads. Pure, so a test and the debug
/// preview run the same rules as the app.
func buildMyStats(rating: RatingRow?, ladder: [LadderRow], season: ActiveSeasonRow?, matches: [MyMatchRow], playerId: String) throws -> MyStats {
    let singlesElo = rating?.singlesElo
    // Same season rule as the website's My stats: a match from an earlier or
    // hidden season (the retired test season) never shows under this one.
    let recent = try matches.filter { season != nil && $0.seasonId == season?.id }.prefix(historyRows).map { m in
        let own = try ownParticipant(m, playerId: playerId)
        return RecentMatch(
            id: m.id,
            playedAt: m.playedAt,
            type: m.matchType,
            outcome: settledOutcome(seasonRowOf(m, own)),
            delta: own?.ratingDelta,
            score: m.scoreSummary,
        )
    }
    return MyStats(
        singlesElo: singlesElo,
        doublesElo: rating?.doublesElo,
        position: ladderPosition(ladder, playerId: playerId, mySinglesElo: singlesElo),
        seasonName: season?.name,
        record: try season.map { summarizeSeason(try seasonRecordRows(matches, activeSeasonId: $0.id, playerId: playerId)) },
        recent: recent,
    )
}

func loadMyStats(_ postgrest: Postgrest, playerId: String) async throws -> MyStats {
    // Explicit columns, and never the *_wins / *_losses counters: those are
    // lifetime figures that survive every season rollover.
    async let ratingRead = postgrest.maybeSingle(
        PostgrestQuery.select("ratings", "singles_elo, doubles_elo").eq("player_id", playerId),
        what: "your rating",
        RatingRow.init(json:),
    )
    async let ladderRead = loadLadder(postgrest)
    async let seasonRead = loadActiveSeason(postgrest)
    async let matchesRead = postgrest.list(myMatchesQuery(playerId), what: "your matches", MyMatchRow.init(json:))
    let rating = try await ratingRead
    let ladder = try await ladderRead
    let season = try await seasonRead
    let matches = try await matchesRead
    return try buildMyStats(rating: rating, ladder: ladder, season: season, matches: matches, playerId: playerId)
}
