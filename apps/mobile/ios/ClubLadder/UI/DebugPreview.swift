#if DEBUG
import SwiftUI

// A debug-only way to see the signed-in screens without an account: launch
// with `-previewTab feed` (or leaderboard, challenges, myStats, membership)
// and optionally `-previewPending YES` or `-previewScrollToBottom YES` (the
// ladder opened at its end). `-previewOverlay detail|new|checkin|scan` opens a
// screen over the tabs (scan shows the paste field, as the simulator has no
// camera) and `-previewSheet submit|dispute|walkover|cancel|picker` opens a
// dialog on it. The screens draw from the invented fixtures below through the
// same pure builders the live loaders use. No service, Keychain item or
// network request exists in this mode: every write is refused on the spot.
// `xcrun simctl openurl booted clubladder://challenges/<id>` routes a link
// (iOS asks first), and `-previewLink <url>` routes one at launch.
enum DebugPreview {
    static var tab: Tab? {
        guard let name = UserDefaults.standard.string(forKey: "previewTab") else { return nil }
        return Tab.allCases.first { "\($0)" == name }
    }

    static var pending: Bool { UserDefaults.standard.bool(forKey: "previewPending") }

    static var scrollToBottom: Bool { UserDefaults.standard.bool(forKey: "previewScrollToBottom") }

    private static var sheet: String? { UserDefaults.standard.string(forKey: "previewSheet") }

    static var dialog: DetailDialog? { sheet.flatMap(DetailDialog.init(rawValue:)) }

    static var confirmCancel: Bool { sheet == "cancel" }

    static var picker: Bool { sheet == "picker" }

    static var scanOnLaunch: Bool { UserDefaults.standard.string(forKey: "previewOverlay") == "scan" }

    static var overlay: Overlay? {
        switch UserDefaults.standard.string(forKey: "previewOverlay") {
        case "detail":
            // The sheet decides which challenge: each one only offers its own actions.
            switch sheet {
            case "submit", "walkover": return .detail(id: acceptedId)
            case "cancel": return .detail(id: sentId)
            default: return .detail(id: resultId)
            }
        case "new": return .newChallenge(opponent: nil)
        case "checkin": return .checkIn(token: String(repeating: "0a", count: 24))
        default: return nil
        }
    }

    /// A made-up player id in Postgres' uuid shape, so links and QR codes route.
    private static func pid(_ n: Int) -> String { "00000000-0000-4000-8000-" + String(format: "%012d", n) }

    static let me = pid(99)

    static let viewer = Viewer(
        id: me,
        fullName: "Alex Rivera",
        status: "competitive",
        isExec: false,
        feeExempt: false,
        avatarUrl: nil,
        createdAt: "2026-09-01T00:00:00Z",
        handle: "alex_rivera",
        memberCode: "QX7K2M9",
    )

    static let ladder: [LadderRow] = [
        LadderRow(id: pid(1), name: "Jordan Blake", handle: "jblake", status: "competitive", singlesElo: 1284, doublesElo: 1190),
        LadderRow(id: pid(2), name: "Casey Morgan", handle: "casey_m", status: "competitive", singlesElo: 1231.6, doublesElo: 1302),
        LadderRow(id: pid(3), name: "Rowan Ellis", handle: nil, status: "recreational", singlesElo: 1180, doublesElo: 1105),
        LadderRow(id: pid(4), name: "Sam Okafor", handle: "samo", status: "competitive", singlesElo: 1180, doublesElo: 1150),
        LadderRow(id: me, name: "Alex Rivera", handle: "alex_rivera", status: "competitive", singlesElo: 1122.4, doublesElo: 1088),
        LadderRow(id: pid(5), name: "Taylor Nguyen", handle: "tnguyen", status: "recreational", singlesElo: 1050, doublesElo: 1210),
        LadderRow(id: pid(6), name: "Morgan Price", handle: "mprice", status: "competitive", singlesElo: 1012, doublesElo: 990),
        LadderRow(id: pid(7), name: "Riley Chen", handle: nil, status: "recreational", singlesElo: 980, doublesElo: 1001),
        LadderRow(id: pid(8), name: "Quinn Adler", handle: "quinn_a", status: "competitive", singlesElo: 944, doublesElo: 930),
        LadderRow(id: pid(9), name: "Drew Castillo", handle: "drewc", status: "recreational", singlesElo: 900, doublesElo: 920),
    ]

    static let season = ActiveSeasonRow(id: "s-fall", name: "Fall 2026")

    private static func match(_ id: String, _ season: String, _ day: String, _ type: String, _ status: String, win: Bool?, delta: Double?, score: String) -> MyMatchRow {
        var participant: [(String, JSONValue)] = [("player_id", .string(me)), ("points_scored", .int(42)), ("points_allowed", .int(35))]
        if let win { participant.append(("win_flag", .bool(win))) }
        if let delta { participant.append(("rating_delta", .double(delta))) }
        return MyMatchRow(
            id: id,
            seasonId: season,
            playedAt: "\(day)T02:00:00Z",
            matchType: type,
            resultStatus: status,
            scoreSummary: score,
            participants: .array([.object([("player_id", .string(pid(1))), ("win_flag", .bool(!(win ?? false)))]), .object(participant)]),
        )
    }

    static let matches: [MyMatchRow] = [
        match("m1", "s-fall", "2026-09-24", "singles", "confirmed", win: true, delta: 14.6, score: "21-17, 21-19"),
        match("m2", "s-fall", "2026-09-20", "doubles", "confirmed", win: false, delta: -9.5, score: "18-21, 21-23"),
        match("m3", "s-fall", "2026-09-17", "singles", "pending_confirmation", win: nil, delta: nil, score: "21-12, 21-15"),
        match("m4", "s-fall", "2026-09-12", "doubles", "walkover", win: true, delta: 6.2, score: "Walkover"),
        // An earlier season's match: never listed under this one.
        match("m0", "s-old", "2026-04-02", "singles", "confirmed", win: true, delta: 30, score: "21-3, 21-4"),
    ]

    private static func face(_ n: Int) -> JSONValue {
        let row = ladder.first { $0.id == pid(n) }!
        return .object([("id", .string(row.id)), ("full_name", .string(row.name)), ("handle", row.handle.map(JSONValue.string) ?? .null), ("avatar_url", .null)])
    }

    private static let meFace = JSONValue.object([("id", .string(me)), ("full_name", .string("Alex Rivera")), ("handle", .string("alex_rivera")), ("avatar_url", .null)])

    /// The Feed from invented rows, dated from today so the agenda and the week strip always have something on.
    static func feed(_ viewer: Viewer) -> Feed {
        let now = Date()
        let today = clubToday(now)
        func day(_ n: Int) -> String { addDaysISO(today, n) }
        let sessions = [
            OpenSessionRow(id: "x1", name: "Friday Drop in", date: day(1), startTime: "19:30:00", endTime: "21:30:00", status: "open", location: "North Gym", track: "all"),
            OpenSessionRow(id: "x2", name: "Competitive Night", date: day(4), startTime: "18:00:00", endTime: "20:30:00", status: "open", location: "South Gym", notes: "Bring a light shirt and a dark shirt.", track: "competitive"),
            OpenSessionRow(id: "x3", date: day(8), startTime: "19:30:00", status: "open", track: "all"),
            OpenSessionRow(id: "20000000-0000-4000-8000-000000000004", name: "Tuesday Drop in", date: day(19), startTime: "19:30:00", endTime: "21:30:00", status: "open", location: "North Gym", track: "all"),
        ]
        var i = FeedInputs(season: FeedSeasonRow(id: "s-fall", name: "Fall 2026", startDate: "2026-09-07", endDate: "2026-12-10"))
        i.openSessions = sessions
        i.calendarSessions = sessions.map { CalendarSessionRow(id: $0.id, name: $0.name, date: $0.date, startTime: $0.startTime, status: "open", seasonId: "s-fall") }
        i.clubEvents = [
            CalendarClubEventRow(id: "e1", title: "Games Night", kind: "social", location: "Student Lounge", startsAt: iso(hours: 50), status: "published"),
        ]
        i.signedUp = ["e1"]
        i.intents = ["x1": "going"]
        i.going = ["x1": 14, "x2": 9]
        i.checkedIn = ["x1": 0]
        i.pastSessionIds = ["p1", "p2", "p3"]
        i.attendance = ["p1": "present", "p2": "present"]
        i.announcements = [
            FeedAnnouncementRow(
                id: "a1",
                title: "Courts move to the North Gym",
                body: "Friday drop in runs in the **North Gym** for the rest of term.",
                createdAt: iso(hours: -20),
                targetAudience: "all",
                author: .object([("full_name", .string("Casey Morgan"))]),
            ),
        ]
        i.river = [
            RiverMatchRow(id: "r1", playedAt: iso(hours: -3), matchType: "singles", format: "bo3_21", scoreSummary: "21-17, 21-19", participants: [
                RiverParticipantRow(teamSide: "a", winFlag: true, ratingDelta: 14.6, postRating: 1122.4, player: meFace),
                RiverParticipantRow(teamSide: "b", winFlag: false, ratingDelta: -14.6, postRating: 1269.4, player: face(1)),
            ]),
            RiverMatchRow(id: "r2", playedAt: iso(hours: -28), matchType: "doubles", format: "single_21", scoreSummary: "21-15", participants: [
                RiverParticipantRow(teamSide: "a", winFlag: true, player: face(2)),
                RiverParticipantRow(teamSide: "a", winFlag: true, player: face(4)),
                RiverParticipantRow(teamSide: "b", winFlag: false, player: face(5)),
                RiverParticipantRow(teamSide: "b", winFlag: false, player: face(6)),
            ]),
        ]
        i.pendingChallenges = [
            PendingChallengeRow(id: "pc1", challenge: .object([
                ("id", .string(incomingId)), ("type", .string("singles")), ("format", .string("bo3_21")),
                ("created_at", .string(iso(hours: -5))), ("creator", face(3)),
            ])),
        ]
        i.rating = OwnRatingRow(singlesElo: 1122.4, doublesElo: 1088, singlesWins: 5, singlesLosses: 3, doublesWins: 2, doublesLosses: 4, singlesProvisional: false, doublesProvisional: true)
        i.prompt = .owing(totalCents: 4000, unknownCount: 0, count: 1)
        return buildFeed(i, viewer: viewer, now: now)
    }

    static let statementSeason = StatementSeason(id: "s-fall", name: "Fall 2026", endDate: "2026-12-10", competitiveFeeCents: 6000, recreationalFeeCents: 4000)

    static let feeRows: [OwnFeeRow] = [
        OwnFeeRow(id: "f1", feeType: "tournament", tournamentId: "t1", amountCents: 1500, paidAt: "2026-09-18T20:00:00Z", method: "e_transfer"),
        OwnFeeRow(id: "f2", feeType: "event", clubEventId: "e1", amountCents: nil),
        OwnFeeRow(id: "f3", feeType: "event", clubEventId: "e2", amountCents: 0, paidAt: "2026-09-10T20:00:00Z", method: "waived"),
    ]

    private static let incomingId = "10000000-0000-4000-8000-000000000001"
    private static let sentId = "10000000-0000-4000-8000-000000000002"
    private static let acceptedId = "10000000-0000-4000-8000-000000000003"
    private static let resultId = "10000000-0000-4000-8000-000000000004"
    private static let doneId = "10000000-0000-4000-8000-000000000005"

    private static func iso(hours: Double) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(hours * 3600))
    }

    private static func person(_ n: Int) -> String {
        let row = ladder.first { $0.id == pid(n) }!
        return #"{"id":"\#(row.id)","full_name":"\#(row.name)","handle":null}"#
    }

    private static let mePerson = #"{"id":"\#(me)","full_name":"Alex Rivera","handle":"alex_rivera"}"#

    /// One challenge as the detail select returns it; the list reads the same fields.
    private static func challengeJson(_ id: String, status: String, creator: String, format: String = "bo3_21", type: String = "singles", mine: String, theirs: String, opponent: Int, expires: Double?, note: String? = nil) -> String {
        let expiry = expires.map { #""\#(iso(hours: $0))""# } ?? "null"
        let noteJson = note.map { #""\#($0)""# } ?? "null"
        return #"{"id":"\#(id)","type":"\#(type)","format":"\#(format)","games_per_match":\#(format == "bo3_21" ? 3 : 1),"points_per_game":21,"rated_flag":true,"status":"\#(status)","created_by":"\#(creator)","created_at":"\#(iso(hours: -30))","expires_at":\#(expiry),"note":\#(noteJson),"creator":\#(creator == me ? mePerson : person(opponent)),"challenge_participants":[{"id":"cp-\#(id)-a","player_id":"\#(me)","role":"\#(creator == me ? "creator" : "opponent")","team_side":"a","confirmation_status":"\#(mine)","player":\#(mePerson)},{"id":"cp-\#(id)-b","player_id":"\#(pid(opponent))","role":"\#(creator == me ? "opponent" : "creator")","team_side":"b","confirmation_status":"\#(theirs)","player":\#(person(opponent))}]}"#
    }

    private static var challengeRows: [(String, String)] {
        [
            (incomingId, challengeJson(incomingId, status: "proposed", creator: pid(2), mine: "pending", theirs: "accepted", opponent: 2, expires: 5, note: "Thursday after drop in?")),
            (sentId, challengeJson(sentId, status: "proposed", creator: me, format: "single_21", mine: "accepted", theirs: "pending", opponent: 4, expires: 40)),
            (acceptedId, challengeJson(acceptedId, status: "accepted", creator: pid(1), mine: "accepted", theirs: "accepted", opponent: 1, expires: nil)),
            (resultId, challengeJson(resultId, status: "accepted", creator: me, mine: "accepted", theirs: "accepted", opponent: 3, expires: nil)),
            (doneId, challengeJson(doneId, status: "completed", creator: pid(5), type: "singles", mine: "accepted", theirs: "accepted", opponent: 5, expires: nil)),
        ]
    }

    private static func parse(_ text: String) -> JSONValue {
        guard let value = JSONValue.parse(text) else { fatalError("preview fixture is not JSON") }
        return value
    }

    static var challenges: [ChallengeListItem] {
        let rows = challengeRows.map { id, json in
            let c = parse(json)
            let mine = c["challenge_participants"]?.arrayValue?.first?["confirmation_status"]?.string ?? ""
            return try! MyChallengeRow(json: parse(#"{"id":"row-\#(id)","confirmation_status":"\#(mine)","challenge":\#(json)}"#))
        }
        return toListItems(rows)
    }

    static func challenge(_ id: String) -> ChallengeWithMatch? {
        guard let json = challengeRows.first(where: { $0.0 == id })?.1 else { return nil }
        let detail = try! ChallengeDetail(json: parse(json))
        var match: ChallengeMatch?
        if id == resultId {
            match = try! ChallengeMatch(json: parse(#"{"id":"m-result","result_status":"pending_confirmation","score_summary":"21-18, 19-21, 21-16","submitted_by":"\#(pid(3))","match_participants":[{"id":"mp1","rating_delta":null,"player":{"full_name":"Alex Rivera"}},{"id":"mp2","rating_delta":null,"player":{"full_name":"Rowan Ellis"}}],"match_games":[{"id":"g2","game_number":2,"side_a_score":19,"side_b_score":21},{"id":"g1","game_number":1,"side_a_score":21,"side_b_score":18},{"id":"g3","game_number":3,"side_a_score":21,"side_b_score":16}]}"#))
        } else if id == doneId {
            match = try! ChallengeMatch(json: parse(#"{"id":"m-done","result_status":"confirmed","score_summary":"21-15, 21-12","submitted_by":"\#(me)","match_participants":[{"id":"mp3","rating_delta":12,"player":{"full_name":"Alex Rivera"}},{"id":"mp4","rating_delta":-12.5,"player":{"full_name":"Taylor Nguyen"}}],"match_games":[]}"#))
        }
        return ChallengeWithMatch(challenge: detail, match: match)
    }

    static let context = ChallengeContext(
        playerId: me,
        standing: Standing(ok: true),
        feature: "on",
        rules: ChallengeRules(maxActive: 5, expiryHours: 72),
        quota: ChallengeQuota(used: 3, max: 5, full: false, ratio: 0.6),
        opponents: ladder.filter { $0.id != me }.map {
            Opponent(id: $0.id, fullName: $0.name, handle: $0.handle, singlesElo: $0.singlesElo, doublesElo: $0.doublesElo)
        },
    )

    static var data: ScreenData {
        ScreenData(
            siteUrl: "https://site.example.invalid",
            ladder: { ladder },
            myStats: { id in
                try buildMyStats(rating: RatingRow(singlesElo: 1122.4, doublesElo: 1088), ladder: ladder, season: season, matches: matches, playerId: id)
            },
            feed: { feed($0) },
            statement: { viewer in
                buildStatement(
                    viewer: viewer,
                    season: statementSeason,
                    feeRows: feeRows,
                    tournamentNames: ["t1": "Fall Open"],
                    eventNames: ["e1": "Year-end banquet", "e2": "Welcome social"],
                )
            },
            challenges: { _ in challenges },
            challenge: { id, _ in challenge(id) },
            context: { .ok(context) },
            action: { _, _ in .refused("This is a preview build: nothing was sent.") },
            signOut: {},
        )
    }

    @MainActor
    static func root(_ tab: Tab) -> some View { PreviewRoot(tab: tab) }
}

/// The preview's own link inbox, so an opened URL routes as it would signed in.
private struct PreviewRoot: View {
    let tab: Tab
    // `-previewLink <url>` queues a link at launch, as `.onOpenURL` does later.
    @State private var pendingLink = UserDefaults.standard.string(forKey: "previewLink").flatMap { link in
        LinkRouter.fromAppScheme(link, siteUrl: DebugPreview.data.siteUrl) ?? link
    }

    var body: some View {
        var v = DebugPreview.viewer
        if DebugPreview.pending {
            v = Viewer(id: v.id, fullName: v.fullName, status: "pending_approval", isExec: false, feeExempt: false, avatarUrl: nil, createdAt: v.createdAt, handle: v.handle, memberCode: v.memberCode)
        }
        return SignedInTabs(data: DebugPreview.data, viewer: v, pendingLink: $pendingLink, initialTab: tab, initialOverlay: DebugPreview.overlay)
            .preferredColorScheme(.dark)
            .onOpenURL { url in
                if url.scheme?.lowercased() == LinkRouter.appScheme {
                    pendingLink = LinkRouter.fromAppScheme(url.absoluteString, siteUrl: DebugPreview.data.siteUrl)
                } else if url.scheme?.lowercased() == "https" {
                    pendingLink = url.absoluteString
                }
            }
    }
}
#endif
