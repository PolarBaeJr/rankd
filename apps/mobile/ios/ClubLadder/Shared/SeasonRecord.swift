import Foundation

// Port of packages/shared/src/utils/season-record.ts, via SeasonRecord.kt. Keep
// in step with it. The record a member posted in one season, counted from that
// season's own match rows and never read off `ratings`, whose counters are
// lifetime figures.

let settledResultStatuses = ["confirmed", "walkover"]

/// One of the member's matches in a season, reduced to what the tallies read.
struct SeasonMatchRow: Equatable, Sendable {
    var matchType: String?
    var resultStatus: String?
    var winFlag: Bool?
    var pointsScored: Int?
    var pointsAllowed: Int?
    var playedAt: String?
}

/// True or false for a settled win or loss; nil when there is no result to count.
func settledOutcome(_ row: SeasonMatchRow) -> Bool? {
    guard let status = row.resultStatus, settledResultStatuses.contains(status) else { return nil }
    return row.winFlag
}

struct DisciplineRecord: Equatable, Sendable {
    var wins = 0
    var losses = 0
    var pointDiff = 0
    /// Positive is a run of wins, negative a run of losses, zero nothing yet.
    var currentStreak = 0
    var bestWinStreak = 0
}

struct SeasonRecord: Equatable, Sendable {
    let singles: DisciplineRecord
    let doubles: DisciplineRecord
    let wins: Int
    let losses: Int
    /// Settled matches, not rows.
    let played: Int
    let pointDiff: Int
    let bestWinStreak: Int
}

/// The member's record for one season. Rows may arrive in any order; the streak
/// sorts by played_at itself, and an undated row counts toward the record but
/// not toward any streak.
func summarizeSeason(_ rows: [SeasonMatchRow]) -> SeasonRecord {
    var singles = DisciplineRecord()
    var doubles = DisciplineRecord()
    var wins = 0
    var losses = 0
    var played = 0
    var pointDiff = 0
    var bestWinStreak = 0

    for row in rows {
        guard let won = settledOutcome(row) else { continue }
        played += 1
        if won { wins += 1 } else { losses += 1 }
        let diff = (row.pointsScored ?? 0) - (row.pointsAllowed ?? 0)
        pointDiff += diff
        // Anything that is not singles counts as doubles, so the halves add up.
        if row.matchType == "singles" {
            if won { singles.wins += 1 } else { singles.losses += 1 }
            singles.pointDiff += diff
        } else {
            if won { doubles.wins += 1 } else { doubles.losses += 1 }
            doubles.pointDiff += diff
        }
    }

    var run = 0
    // ISO 8601 sorts as a plain string; the index keeps the sort stable, as Array.sort is.
    var withDates: [(index: Int, playedAt: String, row: SeasonMatchRow)] = []
    for (index, row) in rows.enumerated() {
        if let playedAt = row.playedAt { withDates.append((index, playedAt, row)) }
    }
    withDates.sort { a, b in a.playedAt != b.playedAt ? a.playedAt < b.playedAt : a.index < b.index }
    let dated = withDates.map(\.row)
    for row in dated {
        guard let won = settledOutcome(row) else { continue }
        run = won ? run + 1 : 0
        if run > bestWinStreak { bestWinStreak = run }

        func step(_ bucket: inout DisciplineRecord) {
            bucket.currentStreak = won ? max(bucket.currentStreak, 0) + 1 : min(bucket.currentStreak, 0) - 1
            if bucket.currentStreak > bucket.bestWinStreak { bucket.bestWinStreak = bucket.currentStreak }
        }
        if row.matchType == "singles" { step(&singles) } else { step(&doubles) }
    }

    return SeasonRecord(
        singles: singles,
        doubles: doubles,
        wins: wins,
        losses: losses,
        played: played,
        pointDiff: pointDiff,
        bestWinStreak: bestWinStreak,
    )
}
