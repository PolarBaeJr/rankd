import Foundation

// Port of ChallengeActions.kt: the arguments the website's challenge actions
// take, built exactly as the website's own forms build them:
// new-challenge-client.tsx for createChallenge, [id]/actions.tsx for the rest.
// Field names are the zod schemas' (packages/shared/src/validators/schemas.ts).
// Pure, so the bodies are tested down to the byte.

enum BuiltArgs: Equatable, Sendable {
    case args(name: String, args: [JSONValue])
    case invalid(String)
}

struct NewChallengeForm: Equatable, Sendable {
    var type: String
    var rated: Bool
    /// "1" or "3": the web form's own values, held as text.
    var games: String
    /// Digits only, as typed.
    var points: String
    var opponentId: String
    var partnerId: String = ""
    var opponentPartnerId: String = ""
    /// YYYY-MM-DD, or empty.
    var scheduledDate: String = ""
    /// HH:MM, or empty.
    var scheduledTime: String = ""
    var note: String = ""
}

/// In UTF-16 units, as the web counts a note's length.
let noteMax = 500

func pointsInvalid(_ points: String) -> Bool {
    guard let n = Int32(points) else { return true }
    return n < 5 || n > 30
}

private func nonZero(_ text: String) -> Int? {
    guard let n = Int32(text), n != 0 else { return nil }
    return Int(n)
}

/// The deuce ceiling the form's helper line quotes: a game to P is won at P + 9 at the latest.
func pointsHelper(_ points: String) -> String {
    if pointsInvalid(points) { return "Points per game must be between 5 and 30." }
    return "A game is won by two clear points, or at \((nonZero(points) ?? 21) + 9)."
}

func createChallengeArgs(_ form: NewChallengeForm) -> BuiltArgs {
    if form.opponentId.isEmpty { return .invalid("Select an opponent") }
    if pointsInvalid(form.points) { return .invalid("Points per game must be between 5 and 30") }
    if form.note.utf16.count > noteMax { return .invalid("A note can be at most \(noteMax) characters") }
    let games = nonZero(form.games) ?? 3
    let doubles = form.type == "doubles"
    var input: [(String, JSONValue)] = [
        ("type", .string(form.type)),
        ("rated_flag", .bool(form.rated)),
        ("event_type", .string(form.rated ? "rated_challenge" : "casual")),
        ("format", .string(games > 1 ? "bo3_21" : "single_21")),
        ("games_per_match", .int(Int64(games))),
        ("points_per_game", .int(Int64(nonZero(form.points) ?? 21))),
        ("opponent_id", .string(form.opponentId)),
    ]
    if doubles && !form.partnerId.isEmpty { input.append(("partner_id", .string(form.partnerId))) }
    if doubles && !form.opponentPartnerId.isEmpty { input.append(("opponent_partner_id", .string(form.opponentPartnerId))) }
    if !form.note.isEmpty { input.append(("note", .string(form.note))) }
    if !form.scheduledDate.isEmpty { input.append(("scheduled_date", .string(form.scheduledDate))) }
    if !form.scheduledTime.isEmpty { input.append(("scheduled_time", .string(form.scheduledTime))) }
    return .args(name: "createChallenge", args: [.object(input)])
}

func idArgs(_ name: String, _ id: String) -> BuiltArgs { .args(name: name, args: [.string(id)]) }

/// The submit dialog's scores. The winner is derived from ALL the games; a
/// blank third game in a best of three is then dropped, since it means the
/// match ended 2-0.
func submitResultArgs(_ challengeId: String, _ games: [GameScore], bestOfThree: Bool) -> BuiltArgs {
    guard let winner = tallyGames(games).winner else {
        return .invalid("Enter the game scores. The winner is worked out from them.")
    }
    let entered = games.enumerated().filter { i, g in !bestOfThree || i < 2 || g.sideA != "" || g.sideB != "" }
    let list: [JSONValue] = entered.map { i, g in
        .object([
            ("game_number", .int(Int64(i + 1))),
            ("side_a_score", .int(Int64(Int32(g.sideA) ?? 0))),
            ("side_b_score", .int(Int64(Int32(g.sideB) ?? 0))),
        ])
    }
    let input: JSONValue = .object([
        ("winner_side", .string(String(winner))),
        ("games", .array(list)),
        ("completed", .bool(true)),
    ])
    return .args(name: "submitMatchResult", args: [.string(challengeId), input])
}

/// The dispute dialog's reasons, in the web's order.
let disputeCategories: [(value: String, label: String)] = [
    ("score_wrong", "Score is wrong"),
    ("winner_wrong", "Winner is wrong"),
    ("format_wrong", "Wrong format"),
    ("incomplete", "Match was incomplete"),
    ("abuse", "Abuse/fraud"),
    ("other", "Other"),
]

let disputeMin = 10

/// disputeMatchResult(matchId, reason, category): the description before the category.
func disputeArgs(_ matchId: String, _ description: String, _ category: String) -> BuiltArgs {
    if description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .invalid("Reason required") }
    if description.utf16.count < disputeMin { return .invalid("Description must be at least 10 characters") }
    return .args(name: "disputeMatchResult", args: [.string(matchId), .string(description), .string(category)])
}

/// Withdrawal: the member forfeits themselves. No-show: the first participant on
/// the other side. The server re-checks both.
func walkoverArgs(_ challengeId: String, _ type: String, viewerId: String, participants: [ChallengeParticipant]) -> BuiltArgs {
    let forfeit: String?
    if type == "withdrawal" {
        forfeit = viewerId
    } else {
        let myTeam = participants.first { $0.playerId == viewerId }?.teamSide
        forfeit = participants.first { $0.playerId != viewerId && $0.teamSide != myTeam }?.playerId
    }
    guard let forfeit, !forfeit.isEmpty else { return .invalid("Could not determine forfeit player") }
    let input: JSONValue = .object([
        ("challenge_id", .string(challengeId)),
        ("forfeit_player_id", .string(forfeit)),
        ("walkover_type", .string(type)),
    ])
    return .args(name: "reportWalkover", args: [input])
}
