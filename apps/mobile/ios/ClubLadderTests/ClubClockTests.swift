import XCTest
@testable import ClubLadder

/// A parsed instant, for tests only.
func at(_ iso: String) -> Date { parseInstant(iso)! }

/// Milliseconds since the epoch, as formatRelativeTime takes its clock.
func ms(_ iso: String) -> Int64 { Int64((at(iso).timeIntervalSince1970 * 1000).rounded()) }

// Port of ClubClockTest.kt (session-window.test.ts, the wall-clock cases of
// club-events.test.ts and the formatTime and formatRelativeTime cases of
// helpers.test.ts), same inputs and outputs.
final class ClubClockTests: XCTestCase {
    private struct S: SessionWindowFields {
        var date: String
        var startTime: String? = nil
        var endTime: String? = nil
        var status: String? = nil
        var startsAt: String? = nil
        var endsAt: String? = nil
    }

    private let minute: Double = 60

    func test_closesAtEndOfTheClubLocalDayWhenNoTimesAreSet() {
        let w = getCheckinWindow(S(date: "2026-07-15"))
        XCTAssertEqual(at("2026-07-15T07:00:00.000Z").addingTimeInterval(-30 * minute), w.opensAt)
        XCTAssertEqual("2026-07-16T07:00:00.000Z", isoMillis(w.closesAt))
    }

    func test_closesAtStartPlusDefaultDurationWhenOnlyStartTimeIsSet() {
        let w = getCheckinWindow(S(date: "2026-07-15", startTime: "18:30:00"))
        XCTAssertEqual(at("2026-07-16T01:30:00.000Z").addingTimeInterval(60 * minute), w.closesAt)
    }

    func test_respectsAnExplicitEndTime() {
        let w = getCheckinWindow(S(date: "2026-07-15", startTime: "18:30:00", endTime: "21:00:00"))
        XCTAssertEqual("2026-07-16T04:00:00.000Z", isoMillis(w.closesAt))
    }

    func test_usesTheWinterOffsetForWinterDates() {
        XCTAssertEqual("2026-01-16T05:00:00.000Z", isoMillis(getCheckinWindow(S(date: "2026-01-15", endTime: "21:00")).closesAt))
    }

    func test_handlesTheSpringForwardBoundarySanely() {
        XCTAssertEqual("2026-03-09T04:00:00.000Z", isoMillis(getCheckinWindow(S(date: "2026-03-08", endTime: "21:00")).closesAt))
        XCTAssertEqual("2026-03-08T08:00:00.000Z", isoMillis(getCheckinWindow(S(date: "2026-03-07")).closesAt))
    }

    func test_prefersTheStoredInstantsWhenTheRowCarriesThem() {
        let w = getCheckinWindow(S(date: "2026-07-15", startTime: "18:30", endTime: "21:00", startsAt: "2026-07-16T01:00:00+00:00"))
        XCTAssertEqual(at("2026-07-16T02:00:00Z"), w.closesAt)
        XCTAssertEqual(at("2026-07-16T00:30:00Z"), w.opensAt)
    }

    func test_isOpenAcrossTheSessionDayWhenNoTimesAreSet() {
        let s = S(date: "2026-07-15")
        XCTAssertTrue(isCheckinOpen(s, now: at("2026-07-15T07:30:00Z")))
        XCTAssertTrue(isCheckinOpen(s, now: at("2026-07-16T06:30:00Z")))
        XCTAssertFalse(isCheckinOpen(s, now: at("2026-07-10T00:00:00Z")))
    }

    func test_closesAfterStartPlusDefaultDurationForAStartOnlySession() {
        let s = S(date: "2026-07-15", startTime: "18:30")
        XCTAssertTrue(isCheckinOpen(s, now: at("2026-07-16T02:00:00Z")))
        XCTAssertFalse(isCheckinOpen(s, now: at("2026-07-16T03:31:00Z")))
    }

    func test_closesAtTheExplicitEndTime() {
        let s = S(date: "2026-07-15", startTime: "18:30", endTime: "22:00")
        XCTAssertTrue(isCheckinOpen(s, now: at("2026-07-16T04:59:00Z")))
        XCTAssertFalse(isCheckinOpen(s, now: at("2026-07-16T05:00:00Z")))
    }

    func test_isClosedWhenNowIsBeyondTheCloseBound() {
        XCTAssertFalse(isCheckinOpen(S(date: "2026-07-15"), now: at("2026-07-16T07:00:00Z")))
    }

    func test_isClosedForANonOpenSessionRegardlessOfTime() {
        XCTAssertFalse(isCheckinOpen(S(date: "2026-07-15", status: "closed"), now: at("2026-07-15T20:00:00Z")))
    }

    func test_parsesTheSettingsRowTheWayTheDatabaseCoercesIt() {
        XCTAssertEqual(CheckinSettings(defaultDurationMinutes: 120, opensMinutesBefore: nil), parseCheckinSettings(nil))
        XCTAssertEqual(
            CheckinSettings(defaultDurationMinutes: 90, opensMinutesBefore: 15),
            parseCheckinSettings(json(#"{"default_duration_minutes":90,"checkin_opens_minutes_before":"15"}"#)),
        )
        XCTAssertEqual(
            CheckinSettings(defaultDurationMinutes: 120, opensMinutesBefore: nil),
            parseCheckinSettings(json(#"{"default_duration_minutes":"soon","checkin_opens_minutes_before":null}"#)),
        )
        XCTAssertEqual(CheckinSettings(defaultDurationMinutes: 120, opensMinutesBefore: nil), parseCheckinSettings(.int(5)))
    }

    func test_resolvesAWallClockAcrossThe20261101Pin() {
        XCTAssertEqual("2026-11-02T02:00:00.000Z", isoMillis(wallClockToUtc(2026, 11, 1, 19, 0)))
        XCTAssertEqual("2027-01-16T02:00:00.000Z", isoMillis(wallClockToUtc(2027, 1, 15, 19, 0)))
        XCTAssertEqual("2026-07-02T02:00:00.000Z", isoMillis(wallClockToUtc(2026, 7, 1, 19, 0)))
    }

    func test_rollsADayOverflowIntoTheNextMonth() {
        XCTAssertEqual("2026-08-01T07:00:00.000Z", isoMillis(wallClockToUtc(2026, 7, 32, 0, 0)))
    }

    func test_roundTripsAWallClock() {
        let cases: [(String, [Int])] = [
            ("2026-07-01T19:00", [2026, 7, 1, 19, 0]),
            ("2026-11-01T19:00", [2026, 11, 1, 19, 0]),
            ("2027-03-14T09:30", [2027, 3, 14, 9, 30]),
        ]
        for (wall, p) in cases {
            XCTAssertEqual(wall, utcToClubWallClock(wallClockToUtc(p[0], p[1], p[2], p[3], p[4])))
        }
    }

    func test_readsPastTheCutoverAtAFixedUtcMinus7() {
        XCTAssertEqual(ClubWallClock(date: "2026-11-02", time: "00:30"), clubEventWallClock(at("2026-11-02T07:30:00Z")))
    }

    func test_putsAnEveningEventOnItsClubDateNotItsUtcDate() {
        XCTAssertEqual(ClubWallClock(date: "2026-10-14", time: "19:30"), clubEventWallClock(at("2026-10-15T02:30:00Z")))
    }

    func test_formatsTimeValuesOnA12HourClock() {
        XCTAssertEqual("6:30 PM", formatTime("18:30:00"))
        XCTAssertEqual("9:05 AM", formatTime("09:05"))
        XCTAssertEqual("12:00 AM", formatTime("00:00:00"))
        XCTAssertEqual("12:00 PM", formatTime("12:00"))
    }

    func test_countsBackInMinutesHoursAndDays() {
        let now = ms("2026-08-10T12:00:00Z")
        XCTAssertEqual("just now", formatRelativeTime("2026-08-10T12:00:00Z", now: now))
        XCTAssertEqual("5m ago", formatRelativeTime("2026-08-10T11:55:00Z", now: now))
        XCTAssertEqual("3h ago", formatRelativeTime("2026-08-10T09:00:00Z", now: now))
        XCTAssertEqual("2d ago", formatRelativeTime("2026-08-08T12:00:00Z", now: now))
    }

    func test_rendersTheOverAWeekFallbackInClubTime() {
        let now = ms("2026-09-01T00:00:00Z")
        XCTAssertEqual("Aug 1, 2026", formatRelativeTime("2026-08-02T02:00:00Z", now: now))
        XCTAssertEqual("Aug 2, 2026", formatRelativeTime("2026-08-02T20:00:00Z", now: now))
        XCTAssertEqual("Aug 1, 2026", clubDate(at("2026-08-02T02:00:00Z")))
    }

    func test_sendsInstantsWithMillisecondsAsToISOStringDoes() {
        XCTAssertEqual("2026-07-01T00:00:00.000Z", isoMillis(at("2026-07-01T00:00:00Z")))
        XCTAssertNil(parseInstant("not a time"))
        XCTAssertEqual(at("2026-07-01T00:00:00Z"), parseInstant("2026-07-01"))
    }

    func test_readsTheTimestampShapesPostgrestSends() {
        XCTAssertEqual("2026-07-01T12:34:56.123Z", isoMillis(at("2026-07-01T12:34:56.123456+00:00")))
        XCTAssertEqual("2026-07-01T12:34:56.000Z", isoMillis(at("2026-07-01 12:34:56+00:00")))
        XCTAssertEqual("2026-07-01T19:34:56.000Z", isoMillis(at("2026-07-01T12:34:56-07:00")))
    }
}
