import XCTest
@testable import ClubLadder

// Port of MatchResultTest.kt (packages/shared/src/utils/__tests__/match-result.test.ts).
final class MatchResultTests: XCTestCase {
    private func g(_ a: Any, _ b: Any) -> GameScore { GameScore(sideA: "\(a)", sideB: "\(b)") }

    func test_countsGamesWonNotPoints() {
        XCTAssertEqual(MatchTally(aGamesWon: 2, bGamesWon: 1, winner: "a"), tallyGames([g(21, 19), g(15, 21), g(21, 10)]))
    }

    func test_givesTheMatchToTheSideThatTookMoreGamesEvenAfterABlowoutLoss() {
        XCTAssertEqual("a", tallyGames([g(21, 19), g(0, 21), g(21, 19)]).winner)
    }

    func test_ignoresUnplayedTrailingGamesInABestOfThree() {
        XCTAssertEqual(MatchTally(aGamesWon: 2, bGamesWon: 0, winner: "a"), tallyGames([g(21, 15), g(21, 12), g("", "")]))
    }

    func test_returnsNoWinnerWhenNothingHasBeenEntered() {
        XCTAssertNil(tallyGames([g("", ""), g("", "")]).winner)
        XCTAssertNil(tallyGames([]).winner)
    }

    func test_returnsNoWinnerWhileTheGamesAreLevel() {
        XCTAssertNil(tallyGames([g(21, 15), g(18, 21)]).winner)
    }

    func test_treatsADrawnGameAsWonByNeitherSide() {
        XCTAssertEqual(MatchTally(aGamesWon: 0, bGamesWon: 0, winner: nil), tallyGames([g(21, 21)]))
    }

    func test_acceptsStringScoresFromFormInputs() {
        XCTAssertEqual("a", tallyGames([g("21", "15")]).winner)
        XCTAssertEqual("b", tallyGames([g("15", "21")]).winner)
    }

    func test_treatsJunkAndBlanksAsZero() {
        XCTAssertEqual("b", tallyGames([g("abc", "21")]).winner)
        XCTAssertEqual("a", tallyGames([g(21, "")]).winner)
    }

    func test_readsLeadingDigitsTheWayParseIntDoes() {
        XCTAssertEqual("a", tallyGames([g("21x", "3")]).winner)
    }
}
