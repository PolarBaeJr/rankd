import XCTest
@testable import ClubLadder

// Port of ClubTimeTest.kt (packages/shared/src/utils/__tests__/club-today.test.ts, plus the pin).
final class ClubTimeTests: XCTestCase {
    private func at(_ iso: String) -> String {
        clubToday(ISO8601DateFormatter().date(from: iso)!)
    }

    func test_returnsTheClubDateNotTheUtcDateOnASummerEvening() {
        XCTAssertEqual("2026-08-06", at("2026-08-07T02:00:00Z"))
    }

    func test_returnsTheClubDateNotTheUtcDateOnAWinterEvening() {
        XCTAssertEqual("2026-12-04", at("2026-12-05T01:00:00Z"))
    }

    func test_agreesWithUtcDuringTheClubDaytime() {
        XCTAssertEqual("2026-08-06", at("2026-08-06T19:00:00Z"))
    }

    func test_emitsYyyyMmDd() {
        XCTAssertNotNil(at("2026-01-02T20:00:00Z").wholeMatch(of: /\d{4}-\d{2}-\d{2}/))
    }

    func test_differsFromTheNaiveUtcSliceAtTheExactHourThatBroke() {
        XCTAssertEqual("2026-08-07", String("2026-08-07T02:00:00Z".prefix(10)))
        XCTAssertEqual("2026-08-06", at("2026-08-07T02:00:00Z"))
    }

    // Past the cutover the offset is -07:00 whatever the phone's tzdata says.
    // Old tzdata reads 07:30Z on 5 December as 23:30 on the 4th.
    func test_readsAWinterMorningPastTheCutoverOnThePinnedOffset() {
        XCTAssertEqual("2026-12-05", at("2026-12-05T07:30:00Z"))
        XCTAssertEqual("2027-01-15", at("2027-01-15T07:30:00Z"))
    }

    func test_switchesToThePinExactlyAtTheCutoverMidnight() {
        XCTAssertEqual("2026-10-31", at("2026-11-01T06:59:00Z"))
        XCTAssertEqual("2026-11-01", at("2026-11-01T07:00:00Z"))
    }
}
