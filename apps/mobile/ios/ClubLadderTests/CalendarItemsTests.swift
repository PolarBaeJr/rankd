import XCTest
@testable import ClubLadder

// Port of CalendarItemsTest.kt (calendar-items.test.ts, tournamentWhen from
// agenda-rows.tsx and a mixed-case name order), same inputs and outputs.
final class CalendarItemsTests: XCTestCase {
    private let settings = CheckinSettings(defaultDurationMinutes: 120, opensMinutesBefore: nil)

    private struct Sess: AgendaSession {
        var id = "s1"
        var name: String? = "Ladder Night"
        var date = "2026-10-14"
        var startTime: String? = "18:30:00"
        var endTime: String? = "21:00:00"
        var status: String? = "open"
        var startsAt: String? = nil
        var endsAt: String? = nil
    }

    private func row(id: String = "s1", name: String? = "Ladder Night", startTime: String? = "18:30:00", status: String = "open") -> CalendarSessionRow {
        CalendarSessionRow(id: id, name: name, date: "2026-10-14", startTime: startTime, status: status)
    }

    private func clubEvent(id: String = "e1", startsAt: String = "2026-10-15T02:30:00Z", endsAt: String? = nil, status: String = "published") -> CalendarClubEventRow {
        CalendarClubEventRow(id: id, title: "Club Social", kind: "social", location: nil, startsAt: startsAt, endsAt: endsAt, status: status)
    }

    private func tournament(id: String = "t1", startDate: String = "2026-10-17", endDate: String? = "2026-10-19", status: String = "active", suspendedAt: String? = nil) -> CalendarTournamentRow {
        CalendarTournamentRow(id: id, name: "Fall Open", startDate: startDate, endDate: endDate, status: status, suspendedAt: suspendedAt)
    }

    private func item(_ key: String, date: String = "2026-10-14", allDay: Bool = false, sortTime: String? = nil, kind: CalendarItemKind = .session, tone: CalendarTone = .open, name: String = "A") -> CalendarItem {
        CalendarItem(key: key, id: "x", kind: kind, date: date, allDay: allDay, sortTime: sortTime, name: name, timeLabel: nil, tone: tone, mine: false, href: nil)
    }

    func test_tonesOpenAndClosedNightsApart() {
        XCTAssertEqual(.open, sessionCalendarItem(row(), mine: false, hasCard: true).tone)
        XCTAssertEqual(.closed, sessionCalendarItem(row(status: "closed"), mine: false, hasCard: false).tone)
    }

    func test_linksToTheCardOnlyWhenThereIsOne() {
        XCTAssertEqual("#session-s1", sessionCalendarItem(row(), mine: false, hasCard: true).href)
        XCTAssertNil(sessionCalendarItem(row(), mine: false, hasCard: false).href)
    }

    func test_hasNoTimeWhenTheSessionHasNoStartTime() {
        let it0 = sessionCalendarItem(row(name: nil, startTime: nil), mine: true, hasCard: false)
        XCTAssertNil(it0.sortTime)
        XCTAssertNil(it0.timeLabel)
        XCTAssertEqual("Practice Session", it0.name)
        XCTAssertTrue(it0.mine)
    }

    func test_placesAnEventOnItsClubDatePastTheCutover() throws {
        let it0 = try XCTUnwrap(clubEventCalendarItem(clubEvent(startsAt: "2026-11-02T07:30:00Z"), mine: false))
        XCTAssertEqual("2026-11-02", it0.date)
        XCTAssertEqual("00:30", it0.sortTime)
        XCTAssertEqual("12:30 AM", it0.timeLabel)
    }

    func test_placesAnEveningEventOnItsClubDateNotItsUtcDate() {
        XCTAssertEqual("2026-10-14", clubEventCalendarItem(clubEvent(), mine: false)?.date)
    }

    func test_tonesACancelledEventAndLinksToTheEventPage() {
        let it0 = clubEventCalendarItem(clubEvent(status: "cancelled"), mine: true)
        XCTAssertEqual(.cancelled, it0?.tone)
        XCTAssertEqual("/events/e1", it0?.href)
        XCTAssertEqual(.club, clubEventCalendarItem(clubEvent(), mine: false)?.tone)
        XCTAssertNil(clubEventCalendarItem(clubEvent(startsAt: "soon"), mine: false))
    }

    func test_putsOneAllDayItemOnEachDayWithUniqueKeys() {
        let items = tournamentCalendarItems(tournament())
        XCTAssertEqual(["2026-10-17", "2026-10-18", "2026-10-19"], items.map(\.date))
        XCTAssertEqual(3, Set(items.map(\.key)).count)
        XCTAssertTrue(items.allSatisfy { $0.allDay && $0.href == "/tournaments/t1" })
    }

    func test_capsALongRunAtSevenDaysAndTreatsAMissingEndDateAsOneDay() {
        XCTAssertEqual(7, tournamentCalendarItems(tournament(endDate: "2026-12-31")).count)
        XCTAssertEqual(1, tournamentCalendarItems(tournament(endDate: nil)).count)
    }

    func test_ordersAllDayFirstThenByTimeThenUntimedLast() {
        let sorted = sortedCalendar([
            item("untimed"),
            item("late", sortTime: "20:00"),
            item("allday", allDay: true),
            item("early", sortTime: "09:00"),
            item("tomorrow", date: "2026-10-15", allDay: true),
        ])
        XCTAssertEqual(["allday", "early", "late", "untimed", "tomorrow"], sorted.map(\.key))
    }

    func test_ordersNamesAsLocaleCompareDoes() {
        let sorted = sortedCalendar([item("b", name: "beta"), item("B", name: "Alpha"), item("a", name: "alpha")])
        XCTAssertEqual(["a", "B", "b"], sorted.map(\.key))
    }

    func test_startsTodayAndRunsSevenDaysAcrossAMonthBoundary() {
        let week = buildWeekStrip([], "2026-09-28")
        XCTAssertEqual(
            ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"],
            week.map(\.dateISO),
        )
        XCTAssertEqual([true, false, false, false, false, false, false], week.map(\.isToday))
        XCTAssertEqual("Mon", week[0].weekday)
        XCTAssertEqual(1, week[3].day)
    }

    func test_capsTheMarksAtThreeAndCountsTheRest() {
        let today = buildWeekStrip(["a", "b", "c", "d", "e"].map { item($0) }, "2026-10-14")[0]
        XCTAssertEqual(3, today.marks.count)
        XCTAssertEqual(2, today.more)
    }

    func test_spellsTheDayOutWithoutADash() {
        let week = buildWeekStrip([item("a"), item("b", kind: .clubEvent, tone: .club)], "2026-10-14")
        XCTAssertEqual("Wed 14: 1 session, 1 club event", week[0].summary)
        XCTAssertEqual("Thu 15: nothing on", week[1].summary)
        XCTAssertFalse(week[0].summary.contains("\u{2014}"))
    }

    private func agenda(
        _ now: String,
        sessions: [Sess] = [],
        clubEvents: [CalendarClubEventRow] = [],
        tournaments: [CalendarTournamentRow] = [],
        live: Set<String> = [],
    ) -> [DayGroup<AgendaEntry<Sess>>] {
        buildAgenda(sessions: sessions, clubEvents: clubEvents, tournaments: tournaments, now: at(now), todayISO: "2026-10-14", checkinSettings: settings, liveTournamentIds: live)
    }

    func test_keepsTonightUntilCheckInClosesAndDropsANightWhoseWindowHasShut() {
        let days = agenda("2026-10-15T03:00:00Z", sessions: [Sess(id: "tonight"), Sess(id: "yesterday", date: "2026-10-13")])
        XCTAssertEqual(["session:tonight"], days.flatMap { $0.sessions.map(\.key) })
    }

    func test_dropsAFinishedClubEventAndKeepsAFutureCancelledOne() {
        let days = agenda("2026-10-15T03:00:00Z", clubEvents: [
            clubEvent(id: "over", startsAt: "2026-10-14T20:00:00Z", endsAt: "2026-10-14T22:00:00Z"),
            clubEvent(id: "cancelled", startsAt: "2026-10-16T02:00:00Z", status: "cancelled"),
        ])
        XCTAssertEqual(["club_event:cancelled"], days.flatMap { $0.sessions.map(\.key) })
    }

    func test_keepsAnEventWithNoEndTimeUntilTheDefaultLengthHasPassed() {
        XCTAssertEqual(1, agenda("2026-10-15T04:00:00Z", clubEvents: [clubEvent()]).count)
    }

    func test_capsTheClubEventsAtTen() {
        let events = (0..<12).map { i in clubEvent(id: "e\(i)", startsAt: "2026-10-\(16 + i)T02:00:00Z") }
        XCTAssertEqual(10, agenda("2026-10-15T03:00:00Z", clubEvents: events).flatMap(\.sessions).count)
    }

    func test_leavesOutLiveSuspendedFinishedAndDraftTournaments() {
        let days = agenda("2026-10-15T03:00:00Z", tournaments: [
            tournament(id: "live"),
            tournament(id: "suspended", suspendedAt: "2026-10-01T00:00:00Z"),
            tournament(id: "over", startDate: "2026-10-01", endDate: "2026-10-02"),
            tournament(id: "draft", status: "draft"),
            tournament(id: "running", startDate: "2026-10-12", endDate: "2026-10-15"),
            tournament(id: "soon"),
        ], live: ["live"])
        XCTAssertEqual(
            ["tournament:running 2026-10-14", "tournament:soon 2026-10-17"],
            days.flatMap { $0.sessions.map { "\($0.key) \($0.date)" } },
        )
    }

    func test_groupsByDayInOrderWithAllDayFirstInsideADay() {
        let days = agenda(
            "2026-10-14T16:00:00Z",
            sessions: [Sess(id: "late", date: "2026-10-17"), Sess(id: "today")],
            clubEvents: [clubEvent(id: "soc", startsAt: "2026-10-17T01:00:00Z")],
            tournaments: [tournament()],
        )
        XCTAssertEqual(["2026-10-14", "2026-10-16", "2026-10-17"], days.map(\.dateISO))
        XCTAssertTrue(days[0].heading.isToday)
        if case .tournament = days[2].sessions[0] {} else { XCTFail("expected the tournament first") }
        if case .session = days[2].sessions[1] {} else { XCTFail("expected the session second") }
        XCTAssertEqual(1, days[1].sessions.count)
        if case .clubEvent = days[1].sessions[0] {} else { XCTFail("expected the club event") }
    }

    func test_saysWhenATournamentRuns() {
        let today = "2026-10-14"
        XCTAssertEqual("All day", tournamentWhen(tournament(endDate: nil), today))
        XCTAssertEqual("3 days", tournamentWhen(tournament(), today))
        XCTAssertEqual("Today", tournamentWhen(tournament(startDate: today, endDate: nil), today))
        XCTAssertEqual("Starts today, 2 days", tournamentWhen(tournament(startDate: today, endDate: "2026-10-15"), today))
        XCTAssertEqual("Day 3 of 4", tournamentWhen(tournament(startDate: "2026-10-12", endDate: "2026-10-15"), today))
    }
}
