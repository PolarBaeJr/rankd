import Foundation

// Port of Challenges.kt: the member's challenges, read the way the website
// reads them. The list is apps/player/src/app/challenges/page.tsx, the detail
// apps/player/src/app/challenges/[id]/page.tsx, and the pure rules below are
// ports of apps/player/src/lib/challenge-rules.ts,
// apps/player/src/lib/challenge-visibility.ts and
// packages/shared/src/utils/{tags,helpers}.ts. Keep in step with them.
//
// Reads only. Every write goes through AppApi to the website's own actions.

/// The list page's select, verbatim, so both apps read the same rows.
let myChallengesSelect =
    "id, confirmation_status, challenge:challenges(id, created_by, type, format, rated_flag, status, created_at, " +
    "expires_at, scheduled_date, scheduled_time, creator:players!challenges_created_by_fkey(id, full_name, " +
    "handle, avatar_url), challenge_participants(id, player_id, role, team_side, player:players(id, full_name, " +
    "handle)))"

/// The detail page's challenge, with named columns rather than `*` and no ratings embed.
let challengeDetailSelect =
    "id, type, format, games_per_match, points_per_game, rated_flag, status, created_by, created_at, expires_at, " +
    "scheduled_date, scheduled_time, note, creator:players!challenges_created_by_fkey(full_name), " +
    "challenge_participants(id, player_id, role, team_side, confirmation_status, " +
    "player:players(id, full_name, handle, avatar_url))"

/// The detail page's match select, verbatim.
let matchForChallengeSelect =
    "id, result_status, score_summary, submitted_by, match_participants(id, rating_delta, " +
    "player:players(full_name)), match_games(id, game_number, side_a_score, side_b_score)"

struct Person: Equatable, Sendable {
    var id: String? = nil
    var fullName: String? = nil
    var handle: String? = nil
    var avatarUrl: String? = nil

    init(id: String? = nil, fullName: String? = nil, handle: String? = nil, avatarUrl: String? = nil) {
        self.id = id
        self.fullName = fullName
        self.handle = handle
        self.avatarUrl = avatarUrl
    }

    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id")
        fullName = try row.optString("full_name")
        handle = try row.optString("handle")
        avatarUrl = try row.optString("avatar_url")
    }
}

struct ChallengeParticipant: Equatable, Sendable {
    var id: String = ""
    var playerId: String = ""
    var role: String? = nil
    var teamSide: String? = nil
    var confirmationStatus: String? = nil
    var player: JSONValue? = nil

    var person: Person? { pickOne(player, Person.init(json:)) }

    init(id: String = "", playerId: String = "", role: String? = nil, teamSide: String? = nil, confirmationStatus: String? = nil, player: JSONValue? = nil) {
        self.id = id
        self.playerId = playerId
        self.role = role
        self.teamSide = teamSide
        self.confirmationStatus = confirmationStatus
        self.player = player
    }

    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        playerId = try row.optString("player_id") ?? ""
        role = try row.optString("role")
        teamSide = try row.optString("team_side")
        confirmationStatus = try row.optString("confirmation_status")
        player = row.optValue("player")
    }
}

struct ChallengeSummary: Equatable, Sendable {
    let id: String
    var createdBy: String = ""
    var type: String = ""
    var format: String = ""
    var ratedFlag: Bool = false
    var status: String = ""
    var createdAt: String = ""
    var expiresAt: String? = nil
    var scheduledDate: String? = nil
    var scheduledTime: String? = nil
    var creator: JSONValue? = nil
    var participants: [ChallengeParticipant] = []

    var creatorPerson: Person? { pickOne(creator, Person.init(json:)) }

    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        createdBy = try row.optString("created_by") ?? ""
        type = try row.optString("type") ?? ""
        format = try row.optString("format") ?? ""
        ratedFlag = try row.optBool("rated_flag") ?? false
        status = try row.optString("status") ?? ""
        createdAt = try row.optString("created_at") ?? ""
        expiresAt = try row.optString("expires_at")
        scheduledDate = try row.optString("scheduled_date")
        scheduledTime = try row.optString("scheduled_time")
        creator = row.optValue("creator")
        participants = try row.optList("challenge_participants", ChallengeParticipant.init(json:)) ?? []
    }
}

struct MyChallengeRow: Equatable, Sendable {
    let id: String
    var confirmationStatus: String = ""
    var challenge: JSONValue? = nil

    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        confirmationStatus = try row.optString("confirmation_status") ?? ""
        challenge = row.optValue("challenge")
    }
}

/// One card on the list: the viewer's participant row and its challenge.
struct ChallengeListItem: Equatable, Sendable {
    let rowId: String
    let confirmationStatus: String
    let challenge: ChallengeSummary
}

struct ChallengeDetail: Equatable, Sendable {
    let id: String
    var type: String = ""
    var format: String = ""
    var gamesPerMatch: Int? = nil
    var pointsPerGame: Int? = nil
    var ratedFlag: Bool = false
    var status: String = ""
    var createdBy: String = ""
    var createdAt: String = ""
    var expiresAt: String? = nil
    var scheduledDate: String? = nil
    var scheduledTime: String? = nil
    var note: String? = nil
    var creator: JSONValue? = nil
    var participants: [ChallengeParticipant] = []

    init(id: String, type: String = "", format: String = "", gamesPerMatch: Int? = nil, pointsPerGame: Int? = nil, ratedFlag: Bool = false, status: String = "", createdBy: String = "", createdAt: String = "", note: String? = nil, participants: [ChallengeParticipant] = []) {
        self.id = id
        self.type = type
        self.format = format
        self.gamesPerMatch = gamesPerMatch
        self.pointsPerGame = pointsPerGame
        self.ratedFlag = ratedFlag
        self.status = status
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.note = note
        self.participants = participants
    }

    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        type = try row.optString("type") ?? ""
        format = try row.optString("format") ?? ""
        gamesPerMatch = try row.optInt("games_per_match")
        pointsPerGame = try row.optInt("points_per_game")
        ratedFlag = try row.optBool("rated_flag") ?? false
        status = try row.optString("status") ?? ""
        createdBy = try row.optString("created_by") ?? ""
        createdAt = try row.optString("created_at") ?? ""
        expiresAt = try row.optString("expires_at")
        scheduledDate = try row.optString("scheduled_date")
        scheduledTime = try row.optString("scheduled_time")
        note = try row.optString("note")
        creator = row.optValue("creator")
        participants = try row.optList("challenge_participants", ChallengeParticipant.init(json:)) ?? []
    }
}

struct MatchParticipant: Equatable, Sendable {
    var id: String = ""
    var ratingDelta: Double? = nil
    var player: JSONValue? = nil

    var person: Person? { pickOne(player, Person.init(json:)) }

    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        ratingDelta = try row.optDouble("rating_delta")
        player = row.optValue("player")
    }
}

struct MatchGame: Equatable, Sendable {
    var id: String = ""
    var gameNumber: Int = 0
    var sideAScore: Int = 0
    var sideBScore: Int = 0

    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        gameNumber = try row.optInt("game_number") ?? 0
        sideAScore = try row.optInt("side_a_score") ?? 0
        sideBScore = try row.optInt("side_b_score") ?? 0
    }
}

struct ChallengeMatch: Equatable, Sendable {
    let id: String
    var resultStatus: String? = nil
    var scoreSummary: String? = nil
    var submittedBy: String? = nil
    var participants: [MatchParticipant] = []
    var games: [MatchGame] = []

    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        resultStatus = try row.optString("result_status")
        scoreSummary = try row.optString("score_summary")
        submittedBy = try row.optString("submitted_by")
        participants = try row.optList("match_participants", MatchParticipant.init(json:)) ?? []
        games = try row.optList("match_games", MatchGame.init(json:)) ?? []
    }
}

struct ChallengeWithMatch: Equatable, Sendable {
    let challenge: ChallengeDetail
    let match: ChallengeMatch?
}

/// helpers.ts pickOne: a to-one embed can arrive as an object, a one-row array, or null.
func pickOne<T>(_ element: JSONValue?, _ decode: (JSONValue) throws -> T) -> T? {
    let obj: JSONValue?
    switch element {
    case let value? where value.isObject: obj = value
    case let .array(items)?: obj = items.first.flatMap { $0.isObject ? $0 : nil }
    default: obj = nil
    }
    guard let obj else { return nil }
    return try? decode(obj)
}

func myChallengesQuery(_ playerId: String) -> PostgrestQuery {
    PostgrestQuery.select("challenge_participants", myChallengesSelect).eq("player_id", playerId).limit(200)
}

func challengeDetailQuery(_ id: String) -> PostgrestQuery {
    PostgrestQuery.select("challenges", challengeDetailSelect).eq("id", id)
}

func matchForChallengeQuery(_ challengeId: String) -> PostgrestQuery {
    PostgrestQuery.select("matches", matchForChallengeSelect).eq("challenge_id", challengeId)
}

/// Newest first on the embedded created_at, as the page sorts once the rows are in hand.
func toListItems(_ rows: [MyChallengeRow]) -> [ChallengeListItem] {
    let items = rows.compactMap { row in
        pickOne(row.challenge, ChallengeSummary.init(json:)).map {
            ChallengeListItem(rowId: row.id, confirmationStatus: row.confirmationStatus, challenge: $0)
        }
    }
    return items.enumerated()
        .map { (index: $0.offset, item: $0.element, at: epochMillis($0.element.challenge.createdAt) ?? Int64.min) }
        .sorted { $0.at != $1.at ? $0.at > $1.at : $0.index < $1.index }
        .map(\.item)
}

func loadMyChallenges(_ postgrest: Postgrest, playerId: String) async throws -> [ChallengeListItem] {
    toListItems(try await postgrest.list(myChallengesQuery(playerId), what: "your challenges", MyChallengeRow.init(json:)))
}

/// challenge-visibility.ts: the creator, or somebody on the participant list.
func viewerMaySeeChallenge(_ challenge: ChallengeDetail?, _ viewerId: String?) -> Bool {
    guard let challenge, let viewerId, !viewerId.isEmpty else { return false }
    if challenge.createdBy == viewerId { return true }
    return challenge.participants.contains { $0.playerId == viewerId }
}

/// Nil when there is no such challenge or it is not the viewer's to see: the web's 404.
func loadChallenge(_ postgrest: Postgrest, id: String, viewerId: String) async throws -> ChallengeWithMatch? {
    let challenge = try await postgrest.maybeSingle(challengeDetailQuery(id), what: "this challenge", ChallengeDetail.init(json:))
    guard let challenge, viewerMaySeeChallenge(challenge, viewerId) else { return nil }
    let match = try await postgrest.maybeSingle(matchForChallengeQuery(id), what: "the match result", ChallengeMatch.init(json:))
    return ChallengeWithMatch(challenge: challenge, match: match)
}

// MARK: Sections (challenge-rules.ts partitionChallenges)

let terminalStatuses: Set<String> = ["completed", "walkover_confirmed", "rejected", "cancelled", "expired"]

struct ChallengePartition: Equatable, Sendable {
    let incoming: [ChallengeListItem]
    let active: [ChallengeListItem]
    let outgoing: [ChallengeListItem]
    let archived: [ChallengeListItem]
}

/// A partially confirmed challenge the viewer has not answered sits in both incoming and active, as on the web.
func partitionChallenges(_ rows: [ChallengeListItem], viewerId: String) -> ChallengePartition {
    func live(_ r: ChallengeListItem) -> Bool { !terminalStatuses.contains(r.challenge.status) }
    return ChallengePartition(
        incoming: rows.filter { live($0) && $0.challenge.createdBy != viewerId && $0.confirmationStatus == "pending" },
        active: rows.filter { ["accepted", "partially_confirmed"].contains($0.challenge.status) },
        outgoing: rows.filter { live($0) && $0.challenge.createdBy == viewerId },
        archived: rows.filter { terminalStatuses.contains($0.challenge.status) },
    )
}

/// The Archived section: singles first, then newest first within each.
func sortArchived(_ rows: [ChallengeListItem]) -> [ChallengeListItem] {
    rows.enumerated()
        .map { (index: $0.offset, item: $0.element, singles: $0.element.challenge.type == "singles" ? 0 : 1, at: epochMillis($0.element.challenge.createdAt) ?? Int64.min) }
        .sorted { a, b in
            if a.singles != b.singles { return a.singles < b.singles }
            if a.at != b.at { return a.at > b.at }
            return a.index < b.index
        }
        .map(\.item)
}

// MARK: Expiry (challenge-rules.ts expiryState)

enum ExpiryKind: Equatable, Sendable { case none, expired, urgent, open }

struct ExpiryState: Equatable, Sendable {
    let kind: ExpiryKind
    let hoursLeft: Int64?
    let label: String?
}

private let expirableStatuses: Set<String> = ["proposed", "partially_confirmed"]
private let urgentHours: Int64 = 12
private let hourMs: Int64 = 3_600_000

func nowMillis() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)) }

func expiryState(_ expiresAt: String?, _ status: String, now: Int64 = nowMillis()) -> ExpiryState {
    let none = ExpiryState(kind: .none, hoursLeft: nil, label: nil)
    guard let expiresAt, expirableStatuses.contains(status), let deadline = epochMillis(expiresAt) else { return none }
    let msLeft = deadline - now
    // Truncated toward zero, like Math.trunc: with 90 minutes left, "1h".
    let hoursLeft = msLeft / hourMs
    if msLeft <= 0 { return ExpiryState(kind: .expired, hoursLeft: hoursLeft, label: "Expired") }
    if msLeft < hourMs {
        let minutes = max(1, msLeft / 60_000)
        return ExpiryState(kind: .urgent, hoursLeft: hoursLeft, label: "\(minutes)m left")
    }
    if hoursLeft < urgentHours { return ExpiryState(kind: .urgent, hoursLeft: hoursLeft, label: "\(hoursLeft)h left") }
    if hoursLeft < 48 { return ExpiryState(kind: .open, hoursLeft: hoursLeft, label: "\(hoursLeft)h left") }
    return ExpiryState(kind: .open, hoursLeft: hoursLeft, label: "\(hoursLeft / 24)d left")
}

// MARK: Labels (packages/shared tags.ts and constants.ts)

let challengeStatusLabel: [String: String] = [
    "proposed": "Proposed",
    "partially_confirmed": "Partial",
    "accepted": "Accepted",
    "completed": "Completed",
    "walkover_confirmed": "Walkover",
    "walkover_pending": "Walkover review",
    "disputed": "Disputed",
    "rejected": "Rejected",
    "cancelled": "Cancelled",
    "expired": "Expired",
]

/// The web's .tag colour classes, by name: gold, win, red, or plain.
enum TagTone: Sendable { case plain, gold, win, red }

let challengeStatusTone: [String: TagTone] = [
    "proposed": .gold,
    "partially_confirmed": .gold,
    "accepted": .win,
    "walkover_pending": .red,
    "disputed": .red,
]

let participantConfirmTone: [String: TagTone] = [
    "accepted": .win,
    "rejected": .red,
    "pending": .gold,
]

let matchFormatLabels: [String: String] = [
    "bo3_21": "Best of 3 to 21",
    "single_21": "1 Game to 21",
    "single_15": "1 Game to 15",
    "single_11": "1 Game to 11",
]

func formatLabel(_ format: String) -> String { matchFormatLabels[format] ?? format }

/// The shape the challenge was actually created with, when it carries one:
/// "Best of 3 to 15". The enum label only when the custom columns are empty,
/// since the enum alone says 21 for every custom target.
func shapeLabel(_ format: String, _ gamesPerMatch: Int?, _ pointsPerGame: Int?) -> String {
    guard let gamesPerMatch, let pointsPerGame else { return formatLabel(format) }
    return gamesPerMatch <= 1 ? "1 Game to \(pointsPerGame)" : "Best of \(gamesPerMatch) to \(pointsPerGame)"
}

// MARK: Time

/// An ISO 8601 timestamp with an offset, as OffsetDateTime.parse reads one:
/// `Z` or `+hh:mm`, seconds and up to nine fraction digits optional, and an
/// impossible date refused. Nil for anything else, a zoneless time included.
func epochMillis(_ timestamp: String?) -> Int64? {
    guard let timestamp, !timestamp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    guard let m = timestamp.wholeMatch(of: /(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{0,9}))?)?([Zz]|[+-]\d{2}:\d{2}(?::\d{2})?)/)
    else { return nil }
    guard let hour = Int(m.4), let minute = Int(m.5), hour < 24, minute < 60 else { return nil }
    let second = m.6.flatMap { Int($0) } ?? 0
    guard second < 60 else { return nil }
    guard let day = parseIsoDay("\(m.1)-\(m.2)-\(m.3)") else { return nil }
    var millis = Int64(day.timeIntervalSince1970) * 1000 + Int64(hour * 3600 + minute * 60 + second) * 1000
    if let fraction = m.7, !fraction.isEmpty {
        let padded = (String(fraction) + "000").prefix(3)
        millis += Int64(padded) ?? 0
    }
    let zone = String(m.8)
    if zone != "Z" && zone != "z" {
        let sign: Int64 = zone.hasPrefix("-") ? -1 : 1
        let parts = zone.dropFirst().split(separator: ":").compactMap { Int64($0) }
        guard parts.count >= 2, parts[0] <= 18, parts[1] < 60 else { return nil }
        let seconds = parts[0] * 3600 + parts[1] * 60 + (parts.count > 2 ? parts[2] : 0)
        millis -= sign * seconds * 1000
    }
    return millis
}

private func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
    let q = a / b
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
}

private func clubDateFormatter(_ zone: TimeZone, _ format: String) -> DateFormatter {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = zone
    f.dateFormat = format
    return f
}

/// helpers.ts formatRelativeTime, with clubDate for anything a week old or more.
func formatRelativeTime(_ timestamp: String, now: Int64 = nowMillis()) -> String {
    guard let then = epochMillis(timestamp) else { return "" }
    let diff = now - then
    let minutes = floorDiv(diff, 60_000)
    let hours = floorDiv(diff, hourMs)
    let days = floorDiv(diff, 86_400_000)
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m ago" }
    if hours < 24 { return "\(hours)h ago" }
    if days < 7 { return "\(days)d ago" }
    let instant = Date(timeIntervalSince1970: Double(then) / 1000)
    let pinnedZone = TimeZone(secondsFromGMT: -7 * 3600)!
    let pinnedDay = clubDateFormatter(pinnedZone, "yyyy-MM-dd").string(from: instant)
    let zone = pinnedDay >= clubPermanentOffsetFrom ? pinnedZone : TimeZone(identifier: clubTimezone)!
    return clubDateFormatter(zone, "MMM d, yyyy").string(from: instant)
}

private extension JSONValue {
    /// A list under `key` decoded element by element, nil when missing or null.
    func optList<T>(_ key: String, _ decode: (JSONValue) throws -> T) throws -> [T]? {
        guard let value = optValue(key) else { return nil }
        guard let items = value.arrayValue else { throw DecodeError(message: "\(key) is not a list") }
        return try items.map(decode)
    }
}
