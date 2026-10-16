import XCTest
@testable import ClubLadder

// Port of FeedBuildTest.kt: the Feed's derivations, pinned against
// apps/player/src/app/feed/page.tsx, and the loader's failure costs.
final class FeedBuildTests: XCTestCase {
    // 12:00 club time on Wednesday 14 October 2026.
    private let now = at("2026-10-14T19:00:00Z")
    private let season = FeedSeasonRow(id: "s1", name: "Fall 2026", startDate: "2026-09-07", endDate: "2026-12-10")

    private func viewer(_ status: String = "recreational") -> Viewer {
        Viewer(id: "me", fullName: "Rowan Tessaly", status: status, isExec: false, feeExempt: false, avatarUrl: nil, createdAt: nil, handle: nil, memberCode: nil, eligibilityFlag: false)
    }

    private func inputs(_ change: (inout FeedInputs) -> Void = { _ in }) -> FeedInputs {
        var i = FeedInputs(season: season, checkin: CheckinSettings(defaultDurationMinutes: 60, opensMinutesBefore: 30))
        change(&i)
        return i
    }

    private func session(_ id: String, _ date: String, start: String? = "18:00:00", end: String? = "20:00:00", track: String = "all") -> OpenSessionRow {
        OpenSessionRow(id: id, name: "Ladder Night", date: date, startTime: start, endTime: end, status: "open", location: "West Gym", track: track)
    }

    private func feed(_ i: FeedInputs? = nil, _ v: Viewer? = nil, now: Date? = nil) -> Feed {
        buildFeed(i ?? inputs(), viewer: v ?? viewer(), now: now ?? self.now)
    }

    private func sessionRows(_ day: AgendaDay) -> [FeedAgendaRow.Session] {
        day.rows.compactMap { if case let .session(s) = $0 { return s } else { return nil } }
    }

    func test_headsThePageWithTheSeasonAndItsWeek() {
        XCTAssertEqual("FALL 2026 \u{00B7} WEEK 6", feed().eyebrow)
        XCTAssertEqual("THE CLUB", feed(inputs { $0.season = nil }).eyebrow)
    }

    func test_saysWhichOfTheThreeEmptySchedulesItIs() {
        XCTAssertEqual("No sessions yet", feed().empty?.title)
        XCTAssertTrue(feed().empty!.hint.hasPrefix("Nothing has been posted for Fall 2026 yet."))
        XCTAssertEqual("No season is running", feed(inputs { $0.season = nil }).empty?.title)
        XCTAssertEqual("Nothing coming up", feed(inputs { $0.flags["sessions"] = false }).empty?.title)
        XCTAssertEqual("Nothing on the calendar.", feed().upNextSub)
    }

    func test_reportsAFailedSessionsReadInsteadOfAnEmptySchedule() {
        let f = feed(inputs { $0.openSessions = nil })
        XCTAssertTrue(f.scheduleError)
        XCTAssertNil(f.empty)
    }

    func test_foldsAfterTwoWeeksButAlwaysShowsThreeDates() {
        let spread = ["2026-10-15", "2026-10-20", "2026-10-27", "2026-10-29", "2026-11-05"].enumerated().map { session("s\($0.offset)", $0.element) }
        let f = feed(inputs { $0.openSessions = spread })
        XCTAssertEqual(["2026-10-15", "2026-10-20", "2026-10-27"], f.agendaSoon.map(\.dateISO))
        XCTAssertEqual(["2026-10-29", "2026-11-05"], f.agendaLater.map(\.dateISO))

        let sparse = ["2026-10-15", "2026-11-20", "2026-12-01", "2026-12-08"].enumerated().map { session("s\($0.offset)", $0.element) }
        let g = feed(inputs { $0.openSessions = sparse })
        XCTAssertEqual(3, g.agendaSoon.count)
        XCTAssertEqual(1, g.agendaLater.count)
    }

    func test_countsWhatIsComingUpSingularAndPlural() {
        let one = feed(inputs {
            $0.openSessions = [session("a", "2026-10-15")]
            $0.intents = ["a": "going"]
        })
        XCTAssertEqual("1 session coming up \u{00B7} you're in for 1.", one.upNextSub)
        let event = CalendarClubEventRow(id: "e1", title: "Board Game Night", kind: "social", location: "Lounge", startsAt: "2026-10-16T02:00:00Z", status: "published")
        var event2 = event
        event2.id = "e2"
        let two = feed(inputs {
            $0.openSessions = [session("a", "2026-10-15"), session("b", "2026-10-16")]
            $0.clubEvents = [event, event2]
        })
        XCTAssertEqual("2 sessions coming up \u{00B7} 2 club events.", two.upNextSub)
    }

    func test_labelsTheCheckInWindowOfANightStillAhead() {
        let f = feed(inputs { $0.openSessions = [session("a", "2026-10-14"), session("b", "2026-10-14", start: "10:00:00", end: "11:00:00")] })
        let rows = sessionRows(f.agendaSoon[0])
        XCTAssertEqual(["a"], rows.map(\.id))
        XCTAssertEqual("Opens at 5:30 PM", rows[0].windowLabel)
        XCTAssertEqual("6:00 PM to 8:00 PM", rows[0].timeLabel)
        XCTAssertTrue(rows[0].isNext)
        XCTAssertFalse(rows[0].canScan)
    }

    func test_offersTheScanInsideTheWindowAndHidesTheLabel() {
        let atDoor = at("2026-10-15T01:10:00Z")
        let open = inputs { $0.openSessions = [session("a", "2026-10-14")] }
        let row = sessionRows(feed(open, now: atDoor).agendaSoon[0])[0]
        XCTAssertTrue(row.canScan)
        XCTAssertNil(row.windowLabel)
        XCTAssertFalse(sessionRows(feed(open, viewer("pending_approval"), now: atDoor).agendaSoon[0])[0].canScan)
        let checkedIn = inputs {
            $0.openSessions = [session("a", "2026-10-14")]
            $0.attendance = ["a": "checked_in"]
        }
        let done = sessionRows(feed(checkedIn, now: atDoor).agendaSoon[0])[0]
        XCTAssertFalse(done.canScan)
        XCTAssertEqual("Checked In", done.stateChip)
    }

    func test_writesATimeRangeAStartAloneOrTimeTbc() {
        func time(_ start: String?, _ end: String?) -> String {
            sessionRows(feed(inputs { $0.openSessions = [session("a", "2026-10-15", start: start, end: end)] }).agendaSoon[0])[0].timeLabel
        }
        XCTAssertEqual("6:00 PM to 8:30 PM", time("18:00:00", "20:30:00"))
        XCTAssertEqual("6:00 PM", time("18:00:00", nil))
        XCTAssertEqual("Time TBC", time(nil, nil))
    }

    func test_saysTimeTbcAndTagsAnotherTrack() {
        let row = sessionRows(feed(inputs { $0.openSessions = [session("a", "2026-10-15", start: nil, end: nil, track: "recreational")] }).agendaSoon[0])[0]
        XCTAssertEqual("Time TBC", row.timeLabel)
        XCTAssertEqual("RECREATIONAL", row.trackTag)
    }

    private func person(_ id: String) -> String {
        #"{"id":"\#(id)","full_name":"\#(id.uppercased())","handle":null,"avatar_url":null}"#
    }

    private func match(_ id: String, _ winner: String, _ loser: String, _ delta: Int, _ rating: Int) throws -> RiverMatchRow {
        let text = """
            {"id":"\(id)","played_at":"2026-10-14T03:00:00Z","match_type":"singles","format":"bo3_21","score_summary":null,
             "match_participants":[
               {"team_side":"a","win_flag":true,"rating_delta":\(delta),"post_rating":\(rating),"player":\(person(winner))},
               {"team_side":"b","win_flag":false,"rating_delta":\(-delta),"post_rating":\(rating - 30),"player":[\(person(loser))]}]}
            """
        return try RiverMatchRow(json: XCTUnwrap(json(text)))
    }

    func test_showsRatingFiguresOnTheReadersOwnRowsOnly() throws {
        let river = [try match("m1", "me", "x", 14, 1017), try match("m2", "y", "x", 9, 1100)]
        let f = feed(inputs { $0.river = river })
        let rows = f.river.flatMap(\.items)
        let mine = try XCTUnwrap(rows.first { $0.key == "match-m1" })
        XCTAssertEqual("You beat X", mine.sentence)
        XCTAssertEqual("+14", mine.delta)
        XCTAssertEqual("1017", mine.rating)
        XCTAssertEqual(.myStats, mine.link)
        XCTAssertEqual("Singles \u{00B7} Best of 3 to 21 \u{00B7} 16h ago", mine.meta)
        let theirs = try XCTUnwrap(rows.first { $0.key == "match-m2" })
        XCTAssertEqual("Y beat X", theirs.sentence)
        XCTAssertNil(theirs.delta)
        XCTAssertNil(theirs.rating)
        XCTAssertEqual(.web("/leaderboard/y"), theirs.link)
        XCTAssertEqual("End of week 6", f.riverEnd)
    }

    private let tournament = FeedTournament(
        id: "t1", name: "Autumn Open", startDate: "2026-10-14", endDate: "2026-10-14",
        tournamentEvents: [FeedEvent(id: "e1", eventType: "open_singles", status: "live"), FeedEvent(id: "e2", eventType: "mixed_doubles", status: "checkin")],
    )

    func test_tellsAMemberWhoIsNotEnteredThatTheDrawsAreOpenToWatch() {
        let card = feed(inputs {
            $0.liveTournaments = [tournament]
            $0.entryParticipants = [EntryParticipantRow(eventId: "e1", playerId: "x", status: "registered")]
        }).liveTournaments[0]
        XCTAssertEqual("UNDER WAY", card.eyebrow)
        XCTAssertEqual("TODAY \u{00B7} 1 PLAYER", card.meta)
        XCTAssertEqual("2 events are on now. You are not entered. The draws are open to watch.", card.notEntered)
        XCTAssertTrue(card.entries.isEmpty)
    }

    func test_listsTheMembersOwnEventsWithTheirCheckIn() {
        let card = feed(inputs {
            $0.liveTournaments = [tournament]
            $0.entryParticipants = [EntryParticipantRow(eventId: "e1", playerId: "me", status: "checked_in")]
            $0.entryPairs = [EntryPairRow(eventId: "e2", player1Id: "x", player2Id: "me", status: "registered")]
        }).liveTournaments[0]
        XCTAssertNil(card.notEntered)
        XCTAssertEqual(["Open Singles", "Mixed Doubles"], card.entries.map(\.eventLabel))
        XCTAssertEqual([true, false], card.entries.map(\.checkedIn))
        XCTAssertEqual("TODAY \u{00B7} 2 PLAYERS", card.meta)
        XCTAssertEqual(.web("/tournaments/t1/events/e1"), card.entries[0].link)
    }

    func test_picksTheFirstNoticeAddressedToTheMember() {
        let rows = [
            FeedAnnouncementRow(id: "a1", title: "For competitive", body: "x", createdAt: "2026-10-14T18:00:00Z", targetAudience: "competitive"),
            FeedAnnouncementRow(id: "a2", title: "Courts moved", body: "**Courts** moved to *West*", createdAt: "2026-10-14T17:00:00Z", targetAudience: "all", author: json(#"{"full_name":"Idris Varga"}"#)),
        ]
        let notice = feed(inputs { $0.announcements = rows }).notice
        XCTAssertEqual("Courts moved", notice?.title)
        XCTAssertEqual("Courts moved to West", notice?.body)
        XCTAssertEqual("Posted by Idris Varga \u{00B7} 2h ago", notice?.meta)
        XCTAssertNil(feed(inputs {
            $0.announcements = rows
            $0.flags["announcements"] = false
        }).notice)
    }

    func test_explainsAPendingAccountAndShowsTheBannerOnlyWhenApproved() {
        let owing = PaymentPrompt.owing(totalCents: 4000, unknownCount: 0, count: 1)
        let pending = feed(inputs { $0.prompt = owing }, viewer("pending_approval"))
        XCTAssertEqual("Waiting on approval", pending.standing?.title)
        XCTAssertNil(pending.paymentAmount)
        XCTAssertEqual("$40.00", feed(inputs { $0.prompt = owing }).paymentAmount)
        XCTAssertEqual("fees", feed(inputs { $0.prompt = .owing(totalCents: 0, unknownCount: 1, count: 1) }).paymentAmount)
        XCTAssertEqual("Account suspended", feed(nil, viewer("suspended")).standing?.title)
    }

    func test_writesNoEmOrEnDashAnywhere() throws {
        let river = [try match("m1", "me", "x", 14, 1017)]
        var one = tournament
        one.tournamentEvents = [FeedEvent(id: "e1", eventType: "open_singles", status: "live")]
        let all = String(describing: feed(inputs {
            $0.openSessions = [session("a", "2026-10-15")]
            $0.river = river
            $0.liveTournaments = [tournament]
        }, viewer("pending_approval"))) + String(describing: feed(inputs { $0.liveTournaments = [one] }))
        XCTAssertFalse(all.contains("\u{2014}"))
        XCTAssertFalse(all.contains("\u{2013}"))
    }

    // MARK: The loader

    private let stored = StoredSession(accessToken: "access-1", refreshToken: "refresh-1", expiresAtEpochSec: Fixtures.now + 3600, userId: "u1")

    private func postgrest(_ respond: @escaping @Sendable (HttpRequest) async -> HttpResponse) async -> (Postgrest, FakeTransport) {
        let transport = FakeTransport(respond)
        let sessions = await Fixtures.manager(transport, InMemorySessionStore(stored))
        return (Fixtures.postgrest(transport, sessions), transport)
    }

    func test_sendsNoReadForASwitchedOffFeature() async throws {
        let off = #"[{"value":{"sessions_enabled":false,"events_enabled":false,"tournaments_enabled":false,"announcements_enabled":false,"challenges_enabled":false,"fees_enabled":false}}]"#
        let (pg, transport) = await postgrest { r in r.path.contains("key=eq.features") ? ok(off) : ok("[]") }
        let f = try await loadFeed(pg, viewer: viewer(), now: now)
        let paths = transport.paths()
        for table in ["sessions", "session_rsvp", "session_attendance", "club_events", "club_event_signups", "tournaments", "announcements", "challenge_participants", "club_fees"] {
            XCTAssertFalse(paths.contains { $0.hasPrefix("/rest/v1/\(table)?") }, table)
        }
        XCTAssertTrue(paths.contains { $0.hasPrefix("/rest/v1/matches?") })
        XCTAssertFalse(paths.contains { $0.hasPrefix("/rest/v1/rpc/") })
        XCTAssertFalse(f.scheduleOn)
        XCTAssertNil(f.you.streak)
        XCTAssertTrue(transport.requests.allSatisfy { $0.method == "GET" })
    }

    func test_dropsTheTournamentCardWhenAnEntryReadFails() async throws {
        let live = #"[{"id":"t1","name":"Autumn Open","start_date":"2026-10-14","end_date":"2026-10-14","tournament_events":[{"id":"e1","event_type":"open_singles","status":"live"}]}]"#
        let (pg, _) = await postgrest { r in
            if r.path.hasPrefix("/rest/v1/tournaments?") && r.path.contains("tournament_events") { return ok(live) }
            if r.path.hasPrefix("/rest/v1/tournament_pairs?") { return status(403, #"{"message":"permission denied"}"#) }
            return ok("[]")
        }
        let dropped = try await loadFeed(pg, viewer: viewer(), now: now)
        XCTAssertTrue(dropped.liveTournaments.isEmpty)
        let (pg2, _) = await postgrest { r in
            r.path.hasPrefix("/rest/v1/tournaments?") && r.path.contains("tournament_events") ? ok(live) : ok("[]")
        }
        let kept = try await loadFeed(pg2, viewer: viewer(), now: now)
        XCTAssertEqual(1, kept.liveTournaments.count)
    }

    func test_survivesEverySecondaryReadFailingAndPostsOnlyTheCountsRpc() async throws {
        let sessions = #"[{"id":"a","name":"Ladder Night","date":"2026-10-15","start_time":"18:00:00","end_time":"20:00:00","status":"open","location":"West Gym","track":"all"}]"#
        let (pg, transport) = await postgrest { r in
            if r.path.hasPrefix("/rest/v1/sessions?select=%2A") { return ok(sessions) }
            if r.path.hasPrefix("/rest/v1/sessions?") { return ok("[]") }
            return status(500, #"{"message":"boom"}"#)
        }
        let f = try await loadFeed(pg, viewer: viewer(), now: now)
        XCTAssertFalse(f.scheduleError)
        XCTAssertTrue(f.clubEventsError)
        XCTAssertEqual(1, f.agendaSoon[0].rows.count)
        let posts = transport.requests.filter { $0.method != "GET" }
        XCTAssertEqual(["/rest/v1/rpc/get_session_attendee_counts"], posts.map(\.path))
        XCTAssertEqual(#"{"p_session_ids":["a"]}"#, posts.first?.body)
    }
}
