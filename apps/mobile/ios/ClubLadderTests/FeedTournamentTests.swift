import XCTest
@testable import ClubLadder

// Port of FeedTournamentTest.kt (feed-tournament.test.ts and the
// countEnteredPlayers cases of tournament-index.test.ts), same inputs and outputs.
final class FeedTournamentTests: XCTestCase {
    private func ev(_ status: String, _ type: String = "open_singles") -> FeedEvent { FeedEvent(id: "e-\(status)-\(type)", eventType: type, status: status) }

    private func tournament(_ startDate: String = "2026-08-17", _ endDate: String? = "2026-08-17", events: [FeedEvent]? = nil, noEvents: Bool = false) -> FeedTournament {
        FeedTournament(id: "t1", name: "Autumn Open", startDate: startDate, endDate: endDate, tournamentEvents: noEvents ? nil : events ?? [ev("live")])
    }

    private let all = ["registration", "checkin", "pool_generated", "pool_live", "bracket_generated", "live", "completed"]

    func test_excludesExactlyTheTwoEndsOfTheLifecycle() {
        XCTAssertEqual(["checkin", "pool_generated", "pool_live", "bracket_generated", "live"], all.filter { isRunningEvent(ev($0)) })
        XCTAssertFalse(isRunningEvent(ev("registration")))
    }

    func test_separatesDrawnOrPlayingFromOpenForCheckIn() {
        XCTAssertEqual(["pool_generated", "pool_live", "bracket_generated", "live"], all.filter { isPlayingEvent(ev($0)) })
    }

    func test_takesTheLastDayFromEndDateElseStartDateTrimmed() {
        XCTAssertEqual("2026-08-17", lastDayOf("2026-08-15", "2026-08-17"))
        XCTAssertEqual("2026-08-15", lastDayOf("2026-08-15", nil))
        XCTAssertEqual("2026-08-17", lastDayOf("2026-08-15", "2026-08-17T00:00:00Z"))
    }

    func test_refusesALiveEventOnATournamentThatEndedLastMonth() {
        let stale = tournament("2026-07-24", "2026-07-24", events: [ev("completed", "mens_singles"), ev("completed"), ev("live", "womens_singles")])
        XCTAssertTrue(stale.tournamentEvents!.contains(where: isRunningEvent))
        XCTAssertFalse(isUnderWay(stale, "2026-08-17"))
    }

    func test_isUnderWayOnTheDayAndThroughTheFinalDayInclusive() {
        XCTAssertTrue(isUnderWay(tournament(), "2026-08-17"))
        let multi = tournament("2026-08-15", "2026-08-17")
        XCTAssertTrue(isUnderWay(multi, "2026-08-17"))
        XCTAssertFalse(isUnderWay(multi, "2026-08-18"))
        XCTAssertTrue(isUnderWay(tournament("2026-08-15", "2026-08-19"), "2026-08-17"))
        let undated = tournament("2026-08-17", nil)
        XCTAssertTrue(isUnderWay(undated, "2026-08-17"))
        XCTAssertFalse(isUnderWay(undated, "2026-08-18"))
    }

    func test_needsAtLeastOneRunningEvent() {
        XCTAssertFalse(isUnderWay(tournament(events: [ev("registration")]), "2026-08-17"))
        XCTAssertFalse(isUnderWay(tournament(events: [ev("completed")]), "2026-08-17"))
        XCTAssertTrue(isUnderWay(tournament(events: [ev("completed", "mens_singles"), ev("checkin", "mixed_doubles")]), "2026-08-17"))
        XCTAssertFalse(isUnderWay(tournament(events: []), "2026-08-17"))
        XCTAssertFalse(isUnderWay(tournament(noEvents: true), "2026-08-17"))
    }

    func test_comparesDayKeysAsStringsAcrossTheCutover() {
        let t = tournament("2026-11-02", "2026-11-02")
        XCTAssertTrue(isUnderWay(t, "2026-11-02"))
        XCTAssertFalse(isUnderWay(t, "2026-11-03"))
    }

    func test_keepsTheQueryOrderOfRunningEvents() {
        let t = tournament(events: [ev("completed", "mens_singles"), ev("live", "womens_singles"), ev("registration"), ev("checkin", "mixed_doubles")])
        XCTAssertEqual(["womens_singles", "mixed_doubles"], runningEvents(t).map(\.eventType))
    }

    func test_picksTheEyebrowByWhetherAnythingIsDrawn() {
        XCTAssertEqual("UNDER WAY", underWayEyebrow([ev("checkin"), ev("live")]))
        XCTAssertEqual("UNDER WAY", underWayEyebrow([ev("bracket_generated")]))
        XCTAssertEqual("UNDER WAY", underWayEyebrow([ev("pool_live")]))
        XCTAssertEqual("CHECK-IN OPEN", underWayEyebrow([ev("checkin")]))
    }

    func test_countsPeopleNotRows() {
        XCTAssertEqual(3, countEnteredPlayers([EntrantRow(playerId: "a", status: "registered")], [EntrantPairRow(player1Id: "b", player2Id: "c", status: "registered")]))
        XCTAssertEqual(2, countEnteredPlayers([EntrantRow(playerId: "a", status: "registered")], [EntrantPairRow(player1Id: "a", player2Id: "b", status: "registered")]))
        XCTAssertEqual(2, countEnteredPlayers(
            [
                EntrantRow(playerId: "a", status: "registered"), EntrantRow(playerId: "b", status: "withdrawn"),
                EntrantRow(playerId: "c", status: "disqualified"), EntrantRow(playerId: "d", status: "checked_in"),
            ],
            [EntrantPairRow(player1Id: "e", player2Id: "f", status: "withdrawn")],
        ))
    }

    func test_readsTheEmbeddedEventsFromARow() throws {
        let t = try FeedTournament(json: json(#"{"id":"t1","name":"Autumn Open","start_date":"2026-08-17","end_date":null,"tournament_events":[{"id":"e1","event_type":"open_singles","status":"live"}]}"#)!)
        XCTAssertEqual([FeedEvent(id: "e1", eventType: "open_singles", status: "live")], t.tournamentEvents)
        XCTAssertNil(t.endDate)
    }
}
