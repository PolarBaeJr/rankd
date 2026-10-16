import Foundation

// Port of tallyGames in packages/shared/src/utils/match-result.ts, via
// MatchResult.kt. Keep in step with it. The winner is derived from the game
// scores, never asked for.

struct GameScore: Equatable, Sendable {
    let sideA: String
    let sideB: String
}

struct MatchTally: Equatable, Sendable {
    let aGamesWon: Int
    let bGamesWon: Int
    let winner: Character?
}

/// Games are counted, not points. A drawn game (equal scores, a blank 0-0
/// included) counts for neither side, so an unplayed third game in a best of
/// three simply does not contribute.
func tallyGames(_ games: [GameScore]) -> MatchTally {
    var a = 0
    var b = 0
    for g in games {
        let sa = toScore(g.sideA)
        let sb = toScore(g.sideB)
        if sa > sb { a += 1 } else if sb > sa { b += 1 }
    }
    let winner: Character? = a > b ? "a" : b > a ? "b" : nil
    return MatchTally(aGamesWon: a, bGamesWon: b, winner: winner)
}

// parseInt semantics: the leading digits count, anything unparseable is 0.
private func toScore(_ value: String) -> Int64 {
    guard let match = value.firstMatch(of: /^\s*[+-]?\d+/) else { return 0 }
    return Int64(String(match.output).trimmingCharacters(in: .whitespaces)) ?? 0
}
