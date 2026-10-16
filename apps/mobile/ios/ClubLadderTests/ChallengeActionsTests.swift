import XCTest
@testable import ClubLadder

// Port of ChallengeActionsTest.kt.
final class ChallengeActionsTests: XCTestCase {
    private func args(_ built: BuiltArgs) -> String {
        guard case let .args(_, args) = built else { return "not args: \(built)" }
        return JSONValue.array(args).serialized
    }

    private func name(_ built: BuiltArgs) -> String {
        guard case let .args(name, _) = built else { return "not args: \(built)" }
        return name
    }

    private func invalid(_ built: BuiltArgs) -> String {
        guard case let .invalid(message) = built else { return "not invalid: \(built)" }
        return message
    }

    private let form = NewChallengeForm(type: "singles", rated: true, games: "3", points: "21", opponentId: "p2")

    private func with(_ change: (inout NewChallengeForm) -> Void) -> NewChallengeForm {
        var f = form
        change(&f)
        return f
    }

    func test_buildsTheWebFormsCreateChallengeInputAndLeavesEmptyOptionalsOut() {
        let built = createChallengeArgs(form)
        XCTAssertEqual("createChallenge", name(built))
        XCTAssertEqual(
            #"[{"type":"singles","rated_flag":true,"event_type":"rated_challenge","format":"bo3_21","# +
                #""games_per_match":3,"points_per_game":21,"opponent_id":"p2"}]"#,
            args(built),
        )
    }

    func test_aCasualOneGameChallenge() {
        let built = createChallengeArgs(with { $0.rated = false; $0.games = "1"; $0.points = "15"; $0.note = "Tuesday?" })
        XCTAssertEqual(
            #"[{"type":"singles","rated_flag":false,"event_type":"casual","format":"single_21","# +
                #""games_per_match":1,"points_per_game":15,"opponent_id":"p2","note":"Tuesday?"}]"#,
            args(built),
        )
    }

    func test_sendsPartnersOnlyForDoubles() {
        let singles = createChallengeArgs(with { $0.partnerId = "p3"; $0.opponentPartnerId = "p4" })
        XCTAssertFalse(args(singles).contains("partner"))
        let doubles = createChallengeArgs(with { $0.type = "doubles"; $0.partnerId = "p3"; $0.opponentPartnerId = "p4" })
        XCTAssertTrue(args(doubles).contains(#""partner_id":"p3","opponent_partner_id":"p4""#))
        let half = createChallengeArgs(with { $0.type = "doubles"; $0.partnerId = "p3" })
        XCTAssertFalse(args(half).contains("opponent_partner_id"))
    }

    func test_carriesAScheduleWhenOneIsSet() {
        let built = createChallengeArgs(with { $0.scheduledDate = "2026-10-01"; $0.scheduledTime = "18:30" })
        XCTAssertTrue(args(built).hasSuffix(#""scheduled_date":"2026-10-01","scheduled_time":"18:30"}]"#))
    }

    func test_refusesWhatTheWebFormRefuses() {
        XCTAssertEqual("Select an opponent", invalid(createChallengeArgs(with { $0.opponentId = "" })))
        XCTAssertEqual("Points per game must be between 5 and 30", invalid(createChallengeArgs(with { $0.points = "4" })))
        XCTAssertEqual("Points per game must be between 5 and 30", invalid(createChallengeArgs(with { $0.points = "31" })))
        XCTAssertEqual("Points per game must be between 5 and 30", invalid(createChallengeArgs(with { $0.points = "" })))
        XCTAssertEqual(
            "A note can be at most 500 characters",
            invalid(createChallengeArgs(with { $0.note = String(repeating: "x", count: noteMax + 1) })),
        )
    }

    func test_thePointsHelperQuotesTheDeuceCeiling() {
        XCTAssertEqual("A game is won by two clear points, or at 30.", pointsHelper("21"))
        XCTAssertEqual("A game is won by two clear points, or at 24.", pointsHelper("15"))
        XCTAssertEqual("Points per game must be between 5 and 30.", pointsHelper("3"))
    }

    func test_idActionsTakeTheIdAlone() {
        XCTAssertEqual(#"["c1"]"#, args(idArgs("acceptChallenge", "c1")))
        XCTAssertEqual("acceptChallenge", name(idArgs("acceptChallenge", "c1")))
    }

    func test_submitsAResultWithTheWinnerWorkedOutAndABlankThirdGameDropped() {
        let built = submitResultArgs(
            "c1",
            [GameScore(sideA: "21", sideB: "15"), GameScore(sideA: "21", sideB: "12"), GameScore(sideA: "", sideB: "")],
            bestOfThree: true,
        )
        XCTAssertEqual("submitMatchResult", name(built))
        XCTAssertEqual(
            #"["c1",{"winner_side":"a","games":[{"game_number":1,"side_a_score":21,"side_b_score":15},"# +
                #"{"game_number":2,"side_a_score":21,"side_b_score":12}],"completed":true}]"#,
            args(built),
        )
    }

    func test_keepsAPlayedThirdGameAndAOneGameMatch() {
        let three = submitResultArgs(
            "c1",
            [GameScore(sideA: "21", sideB: "15"), GameScore(sideA: "12", sideB: "21"), GameScore(sideA: "19", sideB: "21")],
            bestOfThree: true,
        )
        XCTAssertTrue(args(three).contains(#""winner_side":"b""#))
        XCTAssertTrue(args(three).contains(#""game_number":3"#))
        let one = submitResultArgs("c1", [GameScore(sideA: "11", sideB: "21")], bestOfThree: false)
        XCTAssertEqual(
            #"["c1",{"winner_side":"b","games":[{"game_number":1,"side_a_score":11,"side_b_score":21}],"completed":true}]"#,
            args(one),
        )
    }

    func test_refusesAResultWithNoWinner() {
        XCTAssertEqual(
            "Enter the game scores. The winner is worked out from them.",
            invalid(submitResultArgs("c1", [GameScore(sideA: "21", sideB: "15"), GameScore(sideA: "15", sideB: "21"), GameScore(sideA: "", sideB: "")], bestOfThree: true)),
        )
    }

    func test_disputeSendsTheDescriptionBeforeTheCategory() {
        let built = disputeArgs("m1", "The second game was 21-19", "score_wrong")
        XCTAssertEqual("disputeMatchResult", name(built))
        XCTAssertEqual(#"["m1","The second game was 21-19","score_wrong"]"#, args(built))
        XCTAssertEqual("Reason required", invalid(disputeArgs("m1", "   ", "other")))
        XCTAssertEqual("Description must be at least 10 characters", invalid(disputeArgs("m1", "too short", "other")))
        XCTAssertEqual(["score_wrong", "winner_wrong", "format_wrong", "incomplete", "abuse", "other"], disputeCategories.map(\.value))
    }

    private let roster = [
        ChallengeParticipant(id: "cp1", playerId: "me", teamSide: "a"),
        ChallengeParticipant(id: "cp2", playerId: "mate", teamSide: "a"),
        ChallengeParticipant(id: "cp3", playerId: "them", teamSide: "b"),
        ChallengeParticipant(id: "cp4", playerId: "them2", teamSide: "b"),
    ]

    func test_aWithdrawalForfeitsTheMemberANoShowTheFirstPlayerAcrossTheNet() {
        XCTAssertEqual(
            #"[{"challenge_id":"c1","forfeit_player_id":"me","walkover_type":"withdrawal"}]"#,
            args(walkoverArgs("c1", "withdrawal", viewerId: "me", participants: roster)),
        )
        XCTAssertEqual(
            #"[{"challenge_id":"c1","forfeit_player_id":"them","walkover_type":"no_show"}]"#,
            args(walkoverArgs("c1", "no_show", viewerId: "me", participants: roster)),
        )
        XCTAssertEqual(
            "Could not determine forfeit player",
            invalid(walkoverArgs("c1", "no_show", viewerId: "me", participants: Array(roster.prefix(2)))),
        )
    }

    // iOS only: a note is measured in UTF-16 units, as the web measures it.
    func test_countsANotesLengthInUtf16Units() {
        let astral = String(repeating: "\u{1D11E}", count: 250)
        XCTAssertEqual("createChallenge", name(createChallengeArgs(with { $0.note = astral })))
        XCTAssertEqual("A note can be at most 500 characters", invalid(createChallengeArgs(with { $0.note = astral + "x" })))
    }
}
