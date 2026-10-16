import XCTest
@testable import ClubLadder

// Port of LeaderboardTest.kt (the Expo app's src/__tests__/leaderboard.test.ts).
final class LeaderboardTests: XCTestCase {
    private func row(_ id: String, _ status: String, _ singles: Double?, _ doubles: Double?) -> LadderRow {
        LadderRow(id: id, name: id, handle: nil, status: status, singlesElo: singles, doublesElo: doubles)
    }

    private lazy var rows = [
        row("a", "recreational", 900, 1200),
        row("b", "competitive", 1100, 1000),
        row("c", "competitive", 1000, 1300),
        row("d", "pending_approval", 1200, 900),
    ]

    private struct Ranked: Equatable {
        let id: String
        let rank: Int
        let elo: Double
    }

    func test_hasTheFourWebTabsWithoutTournamentPoints() {
        XCTAssertEqual(["Open S.", "Open D.", "Comp S.", "Comp D."], LeaderboardTab.allCases.map(\.label))
    }

    func test_openSinglesKeepsEveryoneHighestSinglesEloFirst() {
        XCTAssertEqual(
            [Ranked(id: "d", rank: 1, elo: 1200), Ranked(id: "b", rank: 2, elo: 1100), Ranked(id: "c", rank: 3, elo: 1000), Ranked(id: "a", rank: 4, elo: 900)],
            rankLadder(rows, .openSingles).map { Ranked(id: $0.row.id, rank: $0.rank, elo: $0.elo) },
        )
    }

    func test_openDoublesSortsByDoublesElo() {
        XCTAssertEqual(["c", "a", "b", "d"], rankLadder(rows, .openDoubles).map(\.row.id))
    }

    func test_compTabsKeepOnlyCompetitiveMembers() {
        XCTAssertEqual(["b", "c"], rankLadder(rows, .compSingles).map(\.row.id))
        XCTAssertEqual(["c:1", "b:2"], rankLadder(rows, .compDoubles).map { "\($0.row.id):\($0.rank)" })
    }

    func test_numbersTiedMembersByPositionInTheOrderTheyArrived() {
        let tied = [
            row("x", "competitive", 400, 400),
            row("y", "competitive", 400, 400),
            row("z", "competitive", 500, 400),
        ]
        XCTAssertEqual(["z:1", "x:2", "y:3"], rankLadder(tied, .openSingles).map { "\($0.row.id):\($0.rank)" })
    }

    func test_readsAMissingEloAsZeroRatherThanThrowing() {
        let ranked = rankLadder([row("n", "competitive", nil, nil), row("m", "competitive", 1, 1)], .openSingles)
        XCTAssertEqual("n", ranked[1].row.id)
    }

    private lazy var ladder = [
        row("a", "competitive", 500, nil),
        row("b", "competitive", 400, nil),
        row("c", "competitive", 400, nil),
        row("d", "competitive", 400, nil),
        row("e", "competitive", 300, nil),
    ]

    func test_tiedMembersShareAPlace() {
        XCTAssertEqual(2, ladderPosition(ladder, playerId: "b", mySinglesElo: 400))
        XCTAssertEqual(2, ladderPosition(ladder, playerId: "d", mySinglesElo: 400))
    }

    func test_theMemberBelowATieSkipsTheTiedPlaces() {
        XCTAssertEqual(5, ladderPosition(ladder, playerId: "e", mySinglesElo: 300))
    }

    func test_theLeaderIsFirst() {
        XCTAssertEqual(1, ladderPosition(ladder, playerId: "a", mySinglesElo: 500))
    }

    func test_isNilNotLastPlaceForAMemberTheRpcLeftOut() {
        XCTAssertNil(ladderPosition(ladder, playerId: "hidden", mySinglesElo: 450))
    }

    func test_isNilWithNoRating() {
        XCTAssertNil(ladderPosition(ladder, playerId: "a", mySinglesElo: nil))
    }

    func test_decodesAnExplicitNullIntoAFieldWithADefault() throws {
        let row = try LadderRow(json: json(#"{"id":"a","name":null,"handle":null,"status":"competitive","singles_elo":null,"doubles_elo":1000}"#)!)
        XCTAssertEqual("", row.name)
        XCTAssertNil(row.singlesElo)
    }
}
