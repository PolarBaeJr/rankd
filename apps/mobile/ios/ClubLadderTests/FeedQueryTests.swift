import XCTest
@testable import ClubLadder

// Port of FeedQueryTest.kt (home-schedule-query.test.ts and
// feed-tournament-query.test.ts), pinning the Feed's reads to the selects in
// apps/player/src/app/feed/page.tsx.
final class FeedQueryTests: XCTestCase {
    private let season = "11111111-1111-4111-8111-111111111111"
    private let player = "22222222-2222-4222-8222-222222222222"
    private let verifiedTournaments = ["id", "name", "start_date", "end_date", "status", "suspended_at", "season_id"]
    private let verifiedEvents = ["id", "tournament_id", "event_type", "status"]

    private func params(_ q: PostgrestQuery) -> [(String, String)] {
        let path = q.pathAndQuery()
        guard let mark = path.firstIndex(of: "?") else { return [] }
        return path[path.index(after: mark)...].split(separator: "&").map { pair in
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            return (String(parts[0]).removingPercentEncoding!, String(parts[1]).removingPercentEncoding!)
        }
    }

    private func get(_ q: PostgrestQuery, _ key: String) -> [String] { params(q).filter { $0.0 == key }.map(\.1) }

    private func one(_ q: PostgrestQuery, _ key: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        let values = get(q, key)
        XCTAssertEqual(1, values.count, key, file: file, line: line)
        return values.first ?? ""
    }

    func test_readsTheClubEventsByCalendarColumnsPublishedOrCancelled() {
        let q = clubEventsQuery("2026-09-01T07:00:00.000Z")
        XCTAssertTrue(q.pathAndQuery().hasPrefix("/rest/v1/club_events?"))
        XCTAssertEqual("id,title,kind,location,starts_at,ends_at,status", one(q, "select"))
        XCTAssertEqual("in.(published,cancelled)", one(q, "status"))
        XCTAssertEqual("gte.2026-09-01T07:00:00.000Z", one(q, "starts_at"))
        XCTAssertEqual("starts_at.asc", one(q, "order"))
        XCTAssertEqual("200", one(q, "limit"))
    }

    func test_readsCalendarTournamentsWithoutDraftsOrFreeText() {
        let q = calendarTournamentsQuery(season)
        let select = one(q, "select")
        XCTAssertEqual("in.(active,completed)", one(q, "status"))
        XCTAssertEqual("(season_id.eq.\(season),season_id.is.null)", one(q, "or"))
        XCTAssertFalse(select.contains("*") || select.contains("notes") || select.contains("suspension_reason"))
        for col in select.split(separator: ",") { XCTAssertTrue(verifiedTournaments.contains(String(col)), String(col)) }
    }

    func test_selectsExactlyWhatTheWeekStripNeeds() {
        let q = calendarSessionsQuery(season, "competitive")
        XCTAssertEqual("id,name,date,start_time,status,season_id", one(q, "select"))
        XCTAssertEqual("(season_id.eq.\(season),season_id.is.null)", one(q, "or"))
        XCTAssertEqual("in.(competitive,all)", one(q, "track"))
        XCTAssertTrue(get(q, "status").isEmpty)
    }

    func test_readsEveryColumnOfTheOpenSessionsSeasonScopedAndTrackFiltered() {
        XCTAssertEqual(
            "/rest/v1/sessions?select=%2A&status=eq.open&or=%28season_id.eq.\(season)%2Cseason_id.is.null%29" +
                "&track=in.%28competitive%2Call%29&order=date.asc%2Cstart_time.asc.nullslast",
            openSessionsQuery(season, "competitive").pathAndQuery(),
        )
        XCTAssertTrue(get(openSessionsQuery(nil, "competitive"), "or").isEmpty)
        XCTAssertEqual("in.(competitive,recreational,all)", one(openSessionsQuery(nil, "pending_approval"), "track"))
    }

    func test_readsOnlyThisMembersSignUpsAttendanceAndRsvps() {
        XCTAssertEqual("/rest/v1/club_event_signups?select=event_id&player_id=eq.\(player)", mySignupsQuery(player).pathAndQuery())
        XCTAssertEqual("/rest/v1/session_attendance?select=session_id%2Cstatus&player_id=eq.\(player)", myAttendanceQuery(player).pathAndQuery())
        XCTAssertEqual("/rest/v1/session_rsvp?select=session_id%2Cintent&player_id=eq.\(player)", myRsvpQuery(player).pathAndQuery())
    }

    func test_pagesTheGoingCountsInSessionOrder() {
        XCTAssertEqual(
            "/rest/v1/session_rsvp?select=session_id&session_id=in.%28a%2Cb%29&intent=eq.going&order=session_id.asc&offset=500&limit=500",
            goingQuery(["a", "b"], offset: 500).pathAndQuery(),
        )
    }

    func test_asksForCheckedInCountsThroughTheAggregateRpc() {
        let q = attendeeCountsRpc(["a", "b"])
        XCTAssertEqual("POST", q.method)
        XCTAssertEqual("/rest/v1/rpc/get_session_attendee_counts", q.pathAndQuery())
        XCTAssertEqual(#"{"p_session_ids":["a","b"]}"#, q.body)
    }

    func test_readsTheSettingsRowsByKey() {
        XCTAssertEqual("/rest/v1/platform_settings?select=value&key=eq.features", featureFlagsQuery().pathAndQuery())
        XCTAssertEqual("/rest/v1/platform_settings?select=value&key=eq.session_attendance", checkinSettingsQuery().pathAndQuery())
        XCTAssertEqual("/rest/v1/seasons?select=id%2Cname%2Cstart_date%2Cend_date&active_flag=eq.true", activeSeasonRowQuery().pathAndQuery())
    }

    func test_countsTheStreakThroughPastSessionsOnTheMembersTracks() {
        XCTAssertEqual(
            "/rest/v1/sessions?select=id%2Cdate&date=lt.2026-10-14&or=%28season_id.eq.\(season)%2Cseason_id.is.null%29" +
                "&track=in.%28recreational%2Call%29&order=date.desc&limit=20",
            streakSessionsQuery("2026-10-14", season, "recreational").pathAndQuery(),
        )
    }

    func test_appliesExpiryAndSeasonAsTwoSeparateOrParams() {
        let q = announcementsQuery("2026-08-11T00:00:00.000Z", "season-1")
        XCTAssertEqual("id,title,body,created_at,target_audience,author:players(full_name)", one(q, "select"))
        XCTAssertEqual("eq.published", one(q, "status"))
        XCTAssertEqual(
            ["(expires_at.is.null,expires_at.gt.2026-08-11T00:00:00.000Z)", "(all_seasons.eq.true,season_id.eq.season-1)"],
            get(q, "or"),
        )
        XCTAssertEqual("pinned.desc,created_at.desc", one(q, "order"))
        XCTAssertEqual("3", one(q, "limit"))
        let noSeason = announcementsQuery("2026-08-11T00:00:00.000Z", nil)
        XCTAssertEqual(1, get(noSeason, "or").count)
        XCTAssertFalse(noSeason.pathAndQuery().contains("all_seasons"))
    }

    func test_readsTheRiverWithPlayersPublicColumnsOnly() {
        let q = riverQuery(season)
        XCTAssertEqual(
            "id,played_at,match_type,format,score_summary,match_participants(team_side,win_flag,rating_delta,post_rating," +
                "player:players(id,full_name,handle,avatar_url))",
            one(q, "select"),
        )
        XCTAssertEqual("eq.confirmed", one(q, "result_status"))
        XCTAssertEqual("not.is.null", one(q, "played_at"))
        XCTAssertEqual("(season_id.eq.\(season),season_id.is.null)", one(q, "or"))
        XCTAssertEqual("played_at.desc", one(q, "order"))
        XCTAssertEqual("15", one(q, "limit"))
        XCTAssertFalse(one(q, "select").contains("status"))
    }

    func test_readsPendingChallengesWithTheCreatorByItsNamedKey() {
        let q = pendingChallengesQuery(player)
        XCTAssertEqual(
            "id,challenge:challenges(id,type,format,created_at,creator:players!challenges_created_by_fkey(id,full_name,handle,avatar_url))",
            one(q, "select"),
        )
        XCTAssertEqual("eq.\(player)", one(q, "player_id"))
        XCTAssertEqual("eq.pending", one(q, "confirmation_status"))
        XCTAssertEqual("5", one(q, "limit"))
    }

    func test_readsLiveTournamentsByVerifiedColumnsOnly() {
        let q = liveTournamentsQuery(season)
        let select = one(q, "select")
        XCTAssertEqual("id,name,start_date,end_date,tournament_events(id,event_type,status)", select)
        XCTAssertEqual("eq.active", one(q, "status"))
        XCTAssertEqual("is.null", one(q, "suspended_at"))
        XCTAssertEqual("(season_id.eq.\(season),season_id.is.null)", one(q, "or"))
        XCTAssertEqual("start_date.asc", one(q, "order"))
        let outer = select.components(separatedBy: ",tournament_events(")[0]
        let inner = select.components(separatedBy: "tournament_events(")[1].dropLast()
        for col in outer.split(separator: ",") { XCTAssertTrue(verifiedTournaments.contains(String(col)), String(col)) }
        for col in inner.split(separator: ",") { XCTAssertTrue(verifiedEvents.contains(String(col)), String(col)) }
        XCTAssertTrue(get(liveTournamentsQuery(nil), "or").isEmpty)
    }

    func test_readsBothEntryTablesForTheRunningEvents() {
        XCTAssertEqual(
            "/rest/v1/tournament_participants?select=event_id%2Cplayer_id%2Cstatus&event_id=in.%28ea%2Ceb%29",
            entryParticipantsQuery(["ea", "eb"]).pathAndQuery(),
        )
        XCTAssertEqual(
            "/rest/v1/tournament_pairs?select=event_id%2Cplayer1_id%2Cplayer2_id%2Cstatus&event_id=in.%28ea%2Ceb%29",
            entryPairsQuery(["ea", "eb"]).pathAndQuery(),
        )
    }

    func test_readsTheMembersOwnRatingRow() {
        XCTAssertEqual(
            "singles_elo,doubles_elo,singles_wins,singles_losses,doubles_wins,doubles_losses,singles_provisional,doubles_provisional",
            one(ownRatingQuery(player), "select"),
        )
        XCTAssertEqual("eq.\(player)", one(ownRatingQuery(player), "player_id"))
    }

    func test_startsTheClubEventsWindowAtTheTermsFirstClubMidnight() {
        XCTAssertEqual("2026-09-01T07:00:00.000Z", clubEventsLowerBound(FeedSeasonRow(id: "s", name: "Fall", startDate: "2026-09-01"), "2026-10-14"))
        XCTAssertEqual("2026-11-01T07:00:00.000Z", clubEventsLowerBound(nil, "2026-12-31"))
    }
}
