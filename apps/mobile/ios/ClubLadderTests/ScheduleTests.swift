import XCTest
@testable import ClubLadder

// Port of ScheduleTest.kt (schedule.test.ts, less the month grid).
final class ScheduleTests: XCTestCase {
    private struct Row: Equatable {
        let id: String
        let date: String
    }

    func test_addsDaysAcrossMonthsYearsAndDstAndGoesBackwards() {
        XCTAssertEqual("2026-08-11", addDaysISO("2026-08-10", 1))
        XCTAssertEqual("2026-09-01", addDaysISO("2026-08-31", 1))
        XCTAssertEqual("2027-01-01", addDaysISO("2026-12-31", 1))
        XCTAssertEqual("2026-03-09", addDaysISO("2026-03-08", 1))
        XCTAssertEqual("2026-02-28", addDaysISO("2026-03-01", -1))
    }

    func test_namesTodayTomorrowAndTheWeekdayFurtherOut() {
        let today = "2026-08-10"
        XCTAssertEqual(DayHeading(label: "Today", dateLabel: "10 Aug", isToday: true, isTomorrow: false), dayHeading(today, today))
        let tomorrow = dayHeading("2026-08-11", today)
        XCTAssertEqual("Tomorrow", tomorrow.label)
        XCTAssertTrue(tomorrow.isTomorrow)
        XCTAssertEqual(DayHeading(label: "Fri", dateLabel: "14 Aug", isToday: false, isTomorrow: false), dayHeading("2026-08-14", today))
        XCTAssertEqual("Sun", dayHeading("2026-08-09", today).label)
    }

    func test_readsAPostgresDateWithoutAZoneWithOrWithoutATime() {
        for date in ["2026-10-04", "2026-10-04T00:00:00"] {
            let heading = dayHeading(date, "2026-09-01")
            XCTAssertEqual("Sun", heading.label, date)
            XCTAssertEqual("4 Oct", heading.dateLabel, date)
        }
    }

    func test_bucketsByDateOldestDayFirstKeepingQueryOrder() {
        let groups = groupSessionsByDay(
            [Row(id: "b", date: "2026-08-12"), Row(id: "a", date: "2026-08-10"), Row(id: "c", date: "2026-08-12")],
            "2026-08-10",
        ) { $0.date }
        XCTAssertEqual(["2026-08-10", "2026-08-12"], groups.map(\.dateISO))
        XCTAssertEqual([["a"], ["b", "c"]], groups.map { $0.sessions.map(\.id) })
        XCTAssertEqual("Today", groups[0].heading.label)
        XCTAssertTrue(groupSessionsByDay([Row](), "2026-08-10") { $0.date }.isEmpty)
    }

    func test_talliesRowsPerSession() {
        XCTAssertEqual(["a": 2, "b": 1], tallyBySession(["a", "b", "a"]))
        XCTAssertEqual([:], tallyBySession(nil))
        XCTAssertNil(tallyBySession(["a"])["b"])
    }

    func test_prefersAttendanceOverAnOlderRsvp() {
        XCTAssertEqual(.checkedIn, describeMyState("checked_in", "declined"))
        XCTAssertEqual(.noShow, describeMyState("no_show", "going"))
        XCTAssertEqual(.attended, describeMyState("present", nil))
        XCTAssertEqual(.excused, describeMyState("excused", "going"))
        XCTAssertEqual(.going, describeMyState(nil, "going"))
        XCTAssertEqual(.declined, describeMyState(nil, "declined"))
        XCTAssertEqual(MyState.none, describeMyState(nil, nil))
    }

    func test_recordsAttendanceForEveryStatusAndPresenceForTwo() {
        for status in ["checked_in", "present", "no_show", "excused"] { XCTAssertTrue(isAttendanceRecorded(status)) }
        XCTAssertFalse(isAttendanceRecorded(nil))
        XCTAssertTrue(wasPresent("present"))
        XCTAssertFalse(wasPresent("excused"))
    }

    func test_keepsANightUntilItsCheckInWindowCloses() {
        XCTAssertFalse(isStillUpcoming(at("2026-08-12T05:00:00Z"), now: at("2026-08-13T22:00:00Z")))
        XCTAssertTrue(isStillUpcoming(at("2026-08-14T05:00:00Z"), now: at("2026-08-13T22:00:00Z")))
        XCTAssertTrue(isStillUpcoming(at("2026-08-20T05:00:00Z"), now: at("2026-08-13T22:00:00Z")))
        XCTAssertFalse(isStillUpcoming(at("2026-08-13T22:00:00Z"), now: at("2026-08-13T22:00:00Z")))
    }
}
