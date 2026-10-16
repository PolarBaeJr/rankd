import XCTest
@testable import ClubLadder

// Port of ChallengesTest.kt.
final class ChallengesTests: XCTestCase {
    private func rows(_ text: String) throws -> [ChallengeListItem] {
        let list = try XCTUnwrap(JSONValue.parse(text)?.arrayValue)
        return toListItems(try list.map(MyChallengeRow.init(json:)))
    }

    private func row(_ id: String, _ status: String, _ createdBy: String, _ confirmation: String, _ createdAt: String, _ type: String = "singles") -> String {
        #"{"id":"r\#(id)","confirmation_status":"\#(confirmation)","challenge":{"id":"\#(id)","created_by":"\#(createdBy)","# +
            #""type":"\#(type)","format":"bo3_21","rated_flag":true,"status":"\#(status)","created_at":"\#(createdAt)"}}"#
    }

    func test_readsTheListWithTheWebPagesSelect() {
        XCTAssertEqual(
            "/rest/v1/challenge_participants?select=id%2Cconfirmation_status%2Cchallenge%3Achallenges%28id%2Ccreated_by%2C" +
                "type%2Cformat%2Crated_flag%2Cstatus%2Ccreated_at%2Cexpires_at%2Cscheduled_date%2Cscheduled_time%2C" +
                "creator%3Aplayers%21challenges_created_by_fkey%28id%2Cfull_name%2Chandle%2Cavatar_url%29%2C" +
                "challenge_participants%28id%2Cplayer_id%2Crole%2Cteam_side%2Cplayer%3Aplayers%28id%2Cfull_name%2Chandle%29%29%29" +
                "&player_id=eq.p1&limit=200",
            myChallengesQuery("p1").pathAndQuery(),
        )
    }

    func test_readsOneChallengeAndItsMatchById() {
        XCTAssertTrue(challengeDetailQuery("c1").pathAndQuery().hasPrefix("/rest/v1/challenges?select=id%2Ctype%2Cformat%2Cgames_per_match"))
        XCTAssertTrue(challengeDetailQuery("c1").pathAndQuery().hasSuffix("&id=eq.c1"))
        XCTAssertEqual(
            "/rest/v1/matches?select=id%2Cresult_status%2Cscore_summary%2Csubmitted_by%2Cmatch_participants%28id%2C" +
                "rating_delta%2Cplayer%3Aplayers%28full_name%29%29%2Cmatch_games%28id%2Cgame_number%2Cside_a_score%2C" +
                "side_b_score%29&challenge_id=eq.c1",
            matchForChallengeQuery("c1").pathAndQuery(),
        )
    }

    func test_readsToOneEmbedsAsAnObjectOrAOneRowArrayNewestFirst() throws {
        let items = try rows(
            """
            [
            {"id":"r1","confirmation_status":"accepted","challenge":{"id":"c1","created_by":"me","status":"accepted",
              "created_at":"2026-09-01T10:00:00+00:00","creator":{"id":"me","full_name":"Member One"},
              "challenge_participants":[{"id":"x","player_id":"me","team_side":"a","player":[{"id":"me","full_name":"Member One"}]}]}},
            {"id":"r2","confirmation_status":"pending","challenge":[{"id":"c2","created_by":"them","status":"proposed",
              "created_at":"2026-09-02T10:00:00+00:00","creator":[{"id":"them","full_name":"Member Two"}]}]},
            {"id":"r3","confirmation_status":"pending","challenge":null}
            ]
            """,
        )
        XCTAssertEqual(["c2", "c1"], items.map(\.challenge.id))
        XCTAssertEqual("Member Two", items[0].challenge.creatorPerson?.fullName)
        XCTAssertEqual("Member One", items[1].challenge.creatorPerson?.fullName)
        XCTAssertEqual("Member One", items[1].challenge.participants[0].person?.fullName)
    }

    func test_partitionsAsTheWebDoes() throws {
        let items = try rows("[" + [
            row("in", "proposed", "them", "pending", "2026-09-05T00:00:00Z"),
            row("partial", "partially_confirmed", "them", "pending", "2026-09-04T00:00:00Z"),
            row("mine", "proposed", "me", "accepted", "2026-09-03T00:00:00Z"),
            row("acc", "accepted", "me", "accepted", "2026-09-02T00:00:00Z"),
            row("exp", "expired", "them", "pending", "2026-09-01T00:00:00Z"),
        ].joined(separator: ",") + "]")
        let parts = partitionChallenges(items, viewerId: "me")
        XCTAssertEqual(["in", "partial"], parts.incoming.map(\.challenge.id))
        XCTAssertEqual(["partial", "acc"], parts.active.map(\.challenge.id))
        XCTAssertEqual(["mine", "acc"], parts.outgoing.map(\.challenge.id))
        XCTAssertEqual(["exp"], parts.archived.map(\.challenge.id))
    }

    func test_archiveListsSinglesFirstNewestFirstWithinEach() throws {
        let items = try rows("[" + [
            row("d-new", "completed", "me", "accepted", "2026-09-05T00:00:00Z", "doubles"),
            row("s-old", "rejected", "me", "accepted", "2026-09-01T00:00:00Z"),
            row("s-new", "cancelled", "me", "accepted", "2026-09-04T00:00:00Z"),
        ].joined(separator: ",") + "]")
        XCTAssertEqual(["s-new", "s-old", "d-new"], sortArchived(items).map(\.challenge.id))
    }

    private let now: Int64 = epochMillis("2026-09-27T12:00:00Z")!

    private func inMinutes(_ m: Int64) -> String {
        let f = ISO8601DateFormatter()
        return f.string(from: Date(timeIntervalSince1970: Double(now + m * 60_000) / 1000))
    }

    func test_labelsTheReplyWindow() {
        XCTAssertEqual(ExpiryState(kind: .urgent, hoursLeft: 0, label: "59m left"), expiryState(inMinutes(59), "proposed", now: now))
        XCTAssertEqual(ExpiryState(kind: .urgent, hoursLeft: 11, label: "11h left"), expiryState(inMinutes(11 * 60 + 30), "proposed", now: now))
        XCTAssertEqual(ExpiryState(kind: .open, hoursLeft: 47, label: "47h left"), expiryState(inMinutes(47 * 60), "partially_confirmed", now: now))
        XCTAssertEqual(ExpiryState(kind: .open, hoursLeft: 72, label: "3d left"), expiryState(inMinutes(72 * 60), "proposed", now: now))
        XCTAssertEqual("Expired", expiryState(inMinutes(-5), "proposed", now: now).label)
        XCTAssertNil(expiryState(inMinutes(60), "accepted", now: now).label)
        XCTAssertNil(expiryState(nil, "proposed", now: now).label)
    }

    func test_saysHowLongAgoThenTheClubDate() {
        XCTAssertEqual("just now", formatRelativeTime(inMinutes(0), now: now))
        XCTAssertEqual("5m ago", formatRelativeTime(inMinutes(-5), now: now))
        XCTAssertEqual("3h ago", formatRelativeTime(inMinutes(-180), now: now))
        XCTAssertEqual("2d ago", formatRelativeTime(inMinutes(-2 * 24 * 60), now: now))
        XCTAssertEqual("Sep 1, 2026", formatRelativeTime("2026-09-01T18:00:00Z", now: now))
    }

    func test_namesTheShapeAChallengeWasMadeWith() {
        XCTAssertEqual("Best of 3 to 15", shapeLabel("bo3_21", 3, 15))
        XCTAssertEqual("1 Game to 11", shapeLabel("single_21", 1, 11))
        XCTAssertEqual("Best of 3 to 21", shapeLabel("bo3_21", nil, nil))
        XCTAssertEqual("custom", shapeLabel("custom", nil, 21))
    }

    func test_onlyTheCreatorAndTheRosterMaySeeAChallenge() {
        let c = ChallengeDetail(id: "c1", createdBy: "me", participants: [ChallengeParticipant(playerId: "them")])
        XCTAssertTrue(viewerMaySeeChallenge(c, "me"))
        XCTAssertTrue(viewerMaySeeChallenge(c, "them"))
        XCTAssertFalse(viewerMaySeeChallenge(c, "else"))
        XCTAssertFalse(viewerMaySeeChallenge(c, ""))
        XCTAssertFalse(viewerMaySeeChallenge(nil, "me"))
    }

    // iOS only: the timestamp reader stands in for OffsetDateTime.parse.
    func test_readsPostgresTimestampsAndRefusesZonelessOrImpossibleOnes() {
        XCTAssertEqual(1_788_256_800_000, epochMillis("2026-09-01T10:00:00+00:00"))
        XCTAssertEqual(1_788_256_800_000, epochMillis("2026-09-01T03:00:00-07:00"))
        XCTAssertEqual(1_788_256_800_123, epochMillis("2026-09-01T10:00:00.123456+00:00"))
        XCTAssertEqual(1_788_256_800_500, epochMillis("2026-09-01T10:00:00.5Z"))
        XCTAssertEqual(1_788_256_800_000, epochMillis("2026-09-01T10:00Z"))
        XCTAssertNil(epochMillis("2026-09-01T10:00:00"))
        XCTAssertNil(epochMillis("2026-02-30T10:00:00Z"))
        XCTAssertNil(epochMillis("2026-09-01 10:00:00+00"))
        XCTAssertNil(epochMillis(""))
        XCTAssertNil(epochMillis(nil))
    }
}
