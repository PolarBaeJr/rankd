import XCTest
@testable import ClubLadder

// Port of SeasonRecordTest.kt (the settledOutcome and summarizeSeason blocks of
// apps/player/src/lib/__tests__/season-history.test.ts).
final class SeasonRecordTests: XCTestCase {
    private func match(
        matchType: String? = "singles",
        resultStatus: String? = "confirmed",
        winFlag: Bool? = true,
        pointsScored: Int? = 21,
        pointsAllowed: Int? = 17,
        playedAt: String? = "2026-09-10T02:00:00Z",
    ) -> SeasonMatchRow {
        SeasonMatchRow(matchType: matchType, resultStatus: resultStatus, winFlag: winFlag, pointsScored: pointsScored, pointsAllowed: pointsAllowed, playedAt: playedAt)
    }

    func test_countsAConfirmedWin() {
        XCTAssertEqual(true, settledOutcome(match()))
    }

    func test_countsAWalkoverWhichSomebodyReallyWasAwarded() {
        XCTAssertEqual(false, settledOutcome(match(resultStatus: "walkover", winFlag: false)))
    }

    func test_refusesAVoidedMatchEvenThoughItsWinFlagSurvivedTheVoiding() {
        XCTAssertNil(settledOutcome(match(resultStatus: "voided", winFlag: true)))
    }

    func test_refusesADisputedMatch() {
        XCTAssertNil(settledOutcome(match(resultStatus: "disputed")))
    }

    func test_refusesAConfirmedRowWhoseWinnerWasNeverStamped() {
        XCTAssertNil(settledOutcome(match(winFlag: nil)))
    }

    func test_splitsTheRecordByDisciplineAndAddsUpToTheTotal() {
        let r = summarizeSeason([
            match(matchType: "singles", winFlag: true, playedAt: "2026-09-10T02:00:00Z"),
            match(matchType: "singles", winFlag: false, playedAt: "2026-09-11T02:00:00Z"),
            match(matchType: "doubles", winFlag: true, playedAt: "2026-09-12T02:00:00Z"),
        ])
        XCTAssertEqual(DisciplineRecord(wins: 1, losses: 1, pointDiff: 8, currentStreak: -1, bestWinStreak: 1), r.singles)
        XCTAssertEqual(DisciplineRecord(wins: 1, losses: 0, pointDiff: 4, currentStreak: 1, bestWinStreak: 1), r.doubles)
        XCTAssertEqual(2, r.wins)
        XCTAssertEqual(1, r.losses)
        XCTAssertEqual(r.wins, r.singles.wins + r.doubles.wins)
        XCTAssertEqual(3, r.played)
    }

    func test_leavesUnsettledRowsOutOfPlayedNotJustOutOfTheWinColumn() {
        let r = summarizeSeason([
            match(resultStatus: "confirmed"),
            match(resultStatus: "disputed"),
            match(resultStatus: "pending_confirmation", winFlag: nil),
        ])
        XCTAssertEqual(1, r.played)
        XCTAssertEqual(1, r.wins)
        XCTAssertEqual(0, r.losses)
    }

    func test_netsThePointDifferentialOverSettledMatchesOnly() {
        let r = summarizeSeason([
            match(pointsScored: 42, pointsAllowed: 30),
            match(winFlag: false, pointsScored: 20, pointsAllowed: 42),
            match(resultStatus: "voided", pointsScored: 99, pointsAllowed: 0),
        ])
        XCTAssertEqual(12 - 22, r.pointDiff)
    }

    func test_findsTheBestWinStreakInDateOrderWhateverOrderTheRowsArriveIn() {
        let r = summarizeSeason([
            match(winFlag: true, playedAt: "2026-10-01T02:00:00Z"),
            match(winFlag: true, playedAt: "2026-09-01T02:00:00Z"),
            match(winFlag: false, playedAt: "2026-09-15T02:00:00Z"),
            match(winFlag: true, playedAt: "2026-10-08T02:00:00Z"),
            match(winFlag: true, playedAt: "2026-10-15T02:00:00Z"),
        ])
        XCTAssertEqual(3, r.bestWinStreak)
    }

    func test_doesNotLetAVoidedMatchJoinTwoWinStreaksTogether() {
        let r = summarizeSeason([
            match(winFlag: true, playedAt: "2026-09-01T02:00:00Z"),
            match(resultStatus: "voided", winFlag: false, playedAt: "2026-09-08T02:00:00Z"),
            match(winFlag: true, playedAt: "2026-09-15T02:00:00Z"),
        ])
        XCTAssertEqual(2, r.bestWinStreak)
    }

    func test_countsAnUndatedMatchTowardTheRecordButNotTowardTheStreak() {
        let r = summarizeSeason([match(winFlag: true, playedAt: nil)])
        XCTAssertEqual(1, r.played)
        XCTAssertEqual(0, r.bestWinStreak)
    }

    func test_keepsEachDisciplineItsOwnStreak() {
        let r = summarizeSeason([
            match(matchType: "singles", winFlag: true, playedAt: "2026-09-01T02:00:00Z"),
            match(matchType: "doubles", winFlag: false, playedAt: "2026-09-08T02:00:00Z"),
            match(matchType: "singles", winFlag: true, playedAt: "2026-09-15T02:00:00Z"),
        ])
        XCTAssertEqual(1, r.bestWinStreak)
        XCTAssertEqual(2, r.singles.bestWinStreak)
        XCTAssertEqual(2, r.singles.currentStreak)
        XCTAssertEqual(-1, r.doubles.currentStreak)
        XCTAssertEqual(0, r.doubles.bestWinStreak)
    }

    func test_startsADisciplineStreakOverRatherThanCountingFromZeroAfterALoss() {
        let r = summarizeSeason([
            match(matchType: "singles", winFlag: false, playedAt: "2026-09-01T02:00:00Z"),
            match(matchType: "singles", winFlag: true, playedAt: "2026-09-08T02:00:00Z"),
        ])
        XCTAssertEqual(1, r.singles.currentStreak)
    }

    func test_returnsAnEmptyRecordRatherThanThrowingOnNoRows() {
        let empty = DisciplineRecord()
        XCTAssertEqual(
            SeasonRecord(singles: empty, doubles: empty, wins: 0, losses: 0, played: 0, pointDiff: 0, bestWinStreak: 0),
            summarizeSeason([]),
        )
    }
}
