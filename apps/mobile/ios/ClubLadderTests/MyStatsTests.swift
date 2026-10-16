import XCTest
@testable import ClubLadder

// Port of MyStatsTest.kt, plus one iOS-only case for the recent list's season rule.
final class MyStatsTests: XCTestCase {
    private func match(_ text: String) throws -> MyMatchRow { try MyMatchRow(json: json(text)!) }

    func test_takesTheMembersOwnParticipantEvenWhenAnOpponentIsListedFirst() throws {
        let m = try match(
            """
            {"id":"m1","participants":[
                {"player_id":"them","win_flag":true,"rating_delta":12.0},
                {"player_id":"me","win_flag":false,"rating_delta":-12.0}]}
            """,
        )
        let own = try ownParticipant(m, playerId: "me")
        XCTAssertEqual("me", own?.playerId)
        XCTAssertEqual(false, own?.winFlag)
    }

    func test_readsASingleObjectEmbed() throws {
        let m = try match(#"{"id":"m1","participants":{"player_id":"me","win_flag":true}}"#)
        XCTAssertEqual(true, try ownParticipant(m, playerId: "me")?.winFlag)
    }

    func test_hasNoSeasonRecordWithoutAnActiveSeason() throws {
        let m = try match(#"{"id":"m1","season_id":"s1","participants":[{"player_id":"me","win_flag":true}]}"#)
        XCTAssertTrue(try seasonRecordRows([m], activeSeasonId: nil, playerId: "me").isEmpty)
    }

    func test_countsOnlyThisSeasonsMatches() throws {
        let rows = try seasonRecordRows(
            [
                match(#"{"id":"a","season_id":"s1","result_status":"confirmed","participants":[{"player_id":"me","win_flag":true}]}"#),
                match(#"{"id":"b","season_id":"s0","result_status":"confirmed","participants":[{"player_id":"me","win_flag":true}]}"#),
            ],
            activeSeasonId: "s1",
            playerId: "me",
        )
        XCTAssertEqual(1, rows.count)
        XCTAssertEqual(true, rows[0].winFlag)
    }

    // Math.round rounds a tie up; Swift's rounded() would give -3 for -2.5.
    func test_roundsARatingChangeTheWayMathRoundDoes() {
        XCTAssertEqual("+3", fmtDelta(2.5))
        XCTAssertEqual("-2", fmtDelta(-2.5))
        XCTAssertEqual("0", fmtDelta(0.4))
        XCTAssertEqual("0", fmtDelta(-0.4))
        XCTAssertEqual("", fmtDelta(nil))
    }

    func test_formatsARatingOrADashWithNone() {
        XCTAssertEqual("1001", fmtElo(1000.5))
        XCTAssertEqual("-", fmtElo(nil))
    }

    func test_readsTheWebsMatchSelectWithoutItsWhitespace() {
        let query = myMatchesQuery("p1").pathAndQuery()
        XCTAssertEqual(
            "select=id%2Cseason_id%2Cplayed_at%2Cmatch_type%2Cformat%2Crated_flag%2Ccompleted_flag%2Cresult_status%2C" +
                "score_summary%2Cparticipants%3Amatch_participants%21inner%28id%2Cplayer_id%2Cwin_flag%2Crating_delta%2C" +
                "post_rating%2Cteam_side%2Cpoints_scored%2Cpoints_allowed%29" +
                "&participants.player_id=eq.p1&played_at=not.is.null&order=played_at.desc&limit=200",
            String(query[query.index(after: query.firstIndex(of: "?")!)...]),
        )
    }

    func test_ignoresTheSelectsColumnsTheAppDoesNotRead() throws {
        let m = try match(#"{"id":"m1","format":"x","rated_flag":true,"participants":[]}"#)
        XCTAssertEqual("m1", m.id)
    }

    // iOS only: the recent list keeps to the active season, as the website's does.
    func test_listsOnlyTheActiveSeasonsMatchesAsRecent() throws {
        let matches = try [
            match(#"{"id":"a","season_id":"s1","result_status":"confirmed","participants":[{"player_id":"me","win_flag":true,"rating_delta":2.5}]}"#),
            match(#"{"id":"b","season_id":"s0","result_status":"confirmed","participants":[{"player_id":"me","win_flag":true}]}"#),
        ]
        let stats = try buildMyStats(
            rating: RatingRow(singlesElo: 1000, doublesElo: nil),
            ladder: [LadderRow(id: "me", singlesElo: 1000)],
            season: ActiveSeasonRow(id: "s1", name: "Fall 2026"),
            matches: matches,
            playerId: "me",
        )
        XCTAssertEqual(["a"], stats.recent.map(\.id))
        XCTAssertEqual(true, stats.recent[0].outcome)
        XCTAssertEqual(1, stats.position)
        XCTAssertEqual(1, stats.record?.played)

        let noSeason = try buildMyStats(rating: nil, ladder: [], season: nil, matches: matches, playerId: "me")
        XCTAssertTrue(noSeason.recent.isEmpty)
        XCTAssertNil(noSeason.record)
    }
}
