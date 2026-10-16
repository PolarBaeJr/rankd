import XCTest
@testable import ClubLadder

// Port of FeedActivityTest.kt (feed-activity.test.ts, less sessionDayLabel),
// same inputs and outputs, with invented names, plus one case past the pin.
final class FeedActivityTests: XCTestCase {
    private struct Item: Equatable {
        let at: String
        let id: String
    }

    private func person(_ id: String, _ name: String) -> RiverPerson { RiverPerson(id: id, name: name, handle: nil, avatarUrl: nil) }

    func test_readsATimestampInClubTimeNotUtc() {
        XCTAssertEqual("2026-08-04", clubDayKey("2026-08-05T06:00:00Z"))
        XCTAssertEqual("2026-08-05", clubDayKey("2026-08-05T20:00:00Z"))
    }

    func test_leavesAMalformedDateUnchanged() {
        XCTAssertEqual("soon", clubDayKey("soon"))
    }

    func test_groupsAMatchPastTheCutoverAtUtcMinus7() {
        XCTAssertEqual("2026-11-01", clubDayKey("2026-11-02T06:30:00Z"))
        let sections = groupByDay([Item(at: "2026-11-02T06:30:00Z", id: "m")], now: at("2026-11-03T18:00:00Z")) { $0.at }
        XCTAssertEqual("2026-11-01", sections[0].key)
        XCTAssertEqual("SUN 1 NOV", sections[0].label)
    }

    func test_stepsAcrossMonthAndYearBoundaries() {
        XCTAssertEqual("2026-08-04", shiftDayKey("2026-08-05", -1))
        XCTAssertEqual("2026-07-31", shiftDayKey("2026-08-01", -1))
        XCTAssertEqual("2025-12-31", shiftDayKey("2026-01-01", -1))
    }

    func test_namesTodayAndYesterdayAndDatesAnythingOlder() {
        XCTAssertEqual("TODAY", dayLabel("2026-08-05", "2026-08-05"))
        XCTAssertEqual("YESTERDAY", dayLabel("2026-08-04", "2026-08-05"))
        XCTAssertEqual("SAT 1 AUG", dayLabel("2026-08-01", "2026-08-05"))
        XCTAssertEqual("TUE 1 SEPT", dayLabel("2026-09-01", "2026-09-05"))
    }

    func test_bucketsIntoClubDaysNewestDayFirst() {
        let now = at("2026-08-05T18:00:00Z")
        XCTAssertTrue(groupByDay([Item](), now: now) { $0.at }.isEmpty)
        let sections = groupByDay(
            [Item(at: "2026-08-04T20:00:00Z", id: "older"), Item(at: "2026-08-05T17:00:00Z", id: "newest"), Item(at: "2026-08-05T16:00:00Z", id: "today-earlier")],
            now: now,
        ) { $0.at }
        XCTAssertEqual(["TODAY", "YESTERDAY"], sections.map(\.label))
        XCTAssertEqual(["newest", "today-earlier"], sections[0].items.map(\.id))
        XCTAssertEqual(["older"], sections[1].items.map(\.id))
    }

    func test_sortsRatherThanTrustingTheCaller() {
        let sections = groupByDay([Item(at: "2026-08-05T10:00:00Z", id: "b"), Item(at: "2026-08-05T14:00:00Z", id: "a")], now: at("2026-08-05T18:00:00Z")) { $0.at }
        XCTAssertEqual(["a", "b"], sections[0].items.map(\.id))
    }

    func test_agreesWithTheRowDateForAClubEveningAndAnAfternoon() {
        let now = at("2026-08-05T18:00:00Z")
        let evening = groupByDay([Item(at: "2026-08-02T02:00:00Z", id: "m")], now: now) { $0.at }[0]
        XCTAssertEqual("2026-08-01", evening.key)
        XCTAssertEqual("SAT 1 AUG", evening.label)
        XCTAssertEqual("Aug 1, 2026", formatRelativeTime("2026-08-02T02:00:00Z", now: ms("2026-09-01T00:00:00Z")))
        let afternoon = groupByDay([Item(at: "2026-08-02T20:00:00Z", id: "m")], now: now) { $0.at }[0]
        XCTAssertEqual("2026-08-02", afternoon.key)
        XCTAssertEqual("SUN 2 AUG", afternoon.label)
        XCTAssertEqual("Aug 2, 2026", formatRelativeTime("2026-08-02T20:00:00Z", now: ms("2026-09-01T00:00:00Z")))
    }

    func test_countsSeasonWeeksFromTheStartDay() {
        XCTAssertEqual(1, seasonWeek("2026-06-01", now: at("2026-06-01T18:00:00Z")))
        XCTAssertEqual(2, seasonWeek("2026-06-01", now: at("2026-06-08T18:00:00Z")))
        XCTAssertEqual(1, seasonWeek("2026-06-01", now: at("2026-06-07T18:00:00Z")))
        XCTAssertNil(seasonWeek("2026-09-01", now: at("2026-08-05T18:00:00Z")))
        XCTAssertEqual(2, seasonWeek("2026-06-01T00:00:00Z", now: at("2026-06-09T18:00:00Z")))
    }

    func test_countsTheStreakBackFromTheLatestSession() {
        XCTAssertEqual(0, attendanceStreak(["a", "b"], []))
        XCTAssertEqual(3, attendanceStreak(["c", "b", "a"], ["c", "b", "a"]))
        XCTAssertEqual(1, attendanceStreak(["c", "b", "a"], ["c", "a"]))
        XCTAssertEqual(0, attendanceStreak(["c", "b", "a"], ["b", "a"]))
    }

    func test_describesAMatchFromTheReadersSide() {
        let me = person("me", "Rowan Tessaly")
        let a = person("a", "Idris Varga")
        let b = person("b", "Mireille Okonkwo")
        let c = person("c", "Tobin Halvard")
        XCTAssertNil(describeMatch([], [a], viewerId: "me"))
        XCTAssertEqual("You beat Idris Varga", describeMatch([me], [a], viewerId: "me"))
        XCTAssertEqual("Idris Varga beat you", describeMatch([a], [me], viewerId: "me"))
        XCTAssertEqual("You beat Idris Varga & Mireille Okonkwo", describeMatch([me, c], [a, b], viewerId: "me"))
        XCTAssertEqual("Mireille Okonkwo beat Idris Varga", describeMatch([b], [a], viewerId: "me"))
    }
}
