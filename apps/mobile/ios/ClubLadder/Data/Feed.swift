import Foundation

// Port of Feed.kt: the website's signed-in home, apps/player/src/app/feed/page.tsx,
// read straight from PostgREST on the member's own JWT as the page does. Keep in
// step with both: the reads, their order, and what each failure costs.
//
// Not ported: the month calendar (desktop only on the web), realtime (pull to
// refresh instead), the subscribe-all and add-to-calendar buttons, RSVP, the
// passkey nudge and "check in without scanning". A card that can check in offers
// only the door-code scan, which the app already has.
//
// Two differences from the page, both deliberate:
//  - A read whose feature is switched off is not sent. The web does this for the
//    schedule; here it goes for every card, since the card is dropped anyway.
//  - holdsAccess is always false (see Features.swift), and standing is
//    isApproved, as on every other tab, so a member with a pending deletion
//    reads as in good standing here. The server still refuses what it refuses.

// MARK: Rows

struct FeedSeasonRow: Equatable, Sendable {
    var id: String = ""
    var name: String? = nil
    var startDate: String? = nil
    var endDate: String? = nil
}

extension FeedSeasonRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        name = try row.optString("name")
        startDate = try row.optString("start_date")
        endDate = try row.optString("end_date")
    }
}

/// A row of `select=*` on sessions. starts_at and ends_at were applied by hand on
/// some hosts, so they are never named in a select and are read as optional here.
struct OpenSessionRow: AgendaSession, Equatable, Sendable {
    var id: String = ""
    var name: String? = nil
    var date: String = ""
    var startTime: String? = nil
    var endTime: String? = nil
    var status: String? = nil
    var startsAt: String? = nil
    var endsAt: String? = nil
    var location: String? = nil
    var notes: String? = nil
    var track: String? = nil
}

extension OpenSessionRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        name = try row.optString("name")
        date = try row.optString("date") ?? ""
        startTime = try row.optString("start_time")
        endTime = try row.optString("end_time")
        status = try row.optString("status")
        startsAt = try row.optString("starts_at")
        endsAt = try row.optString("ends_at")
        location = try row.optString("location")
        notes = try row.optString("notes")
        track = try row.optString("track")
    }
}

struct FeedAnnouncementRow: Equatable, Sendable {
    var id: String = ""
    var title: String = ""
    var body: String = ""
    var createdAt: String = ""
    var targetAudience: String? = nil
    var author: JSONValue? = nil
}

extension FeedAnnouncementRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        title = try row.optString("title") ?? ""
        body = try row.optString("body") ?? ""
        createdAt = try row.optString("created_at") ?? ""
        targetAudience = try row.optString("target_audience")
        author = row.optValue("author")
    }
}

struct RiverParticipantRow: Equatable, Sendable {
    var teamSide: String? = nil
    var winFlag: Bool? = nil
    var ratingDelta: Double? = nil
    var postRating: Double? = nil
    var player: JSONValue? = nil
}

extension RiverParticipantRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        teamSide = try row.optString("team_side")
        winFlag = try row.optBool("win_flag")
        ratingDelta = try row.optDouble("rating_delta")
        postRating = try row.optDouble("post_rating")
        player = row.optValue("player")
    }
}

struct RiverMatchRow: Equatable, Sendable {
    var id: String = ""
    var playedAt: String? = nil
    var matchType: String? = nil
    var format: String? = nil
    var scoreSummary: String? = nil
    var participants: [RiverParticipantRow]? = nil
}

extension RiverMatchRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        playedAt = try row.optString("played_at")
        matchType = try row.optString("match_type")
        format = try row.optString("format")
        scoreSummary = try row.optString("score_summary")
        if let list = row.optValue("match_participants") {
            guard let items = list.arrayValue else { throw DecodeError(message: "match_participants is not a list") }
            participants = try items.map(RiverParticipantRow.init(json:))
        }
    }
}

struct PendingChallengeRow: Equatable, Sendable {
    var id: String = ""
    var challenge: JSONValue? = nil
}

extension PendingChallengeRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        challenge = row.optValue("challenge")
    }
}

private struct PendingChallengeEmbed {
    var id: String
    var format: String?
    var createdAt: String?
    var creator: JSONValue?

    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        format = try row.optString("format")
        createdAt = try row.optString("created_at")
        creator = row.optValue("creator")
    }
}

struct EntryParticipantRow: Equatable, Sendable {
    var eventId: String = ""
    var playerId: String = ""
    var status: String = ""
}

extension EntryParticipantRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        eventId = try row.optString("event_id") ?? ""
        playerId = try row.optString("player_id") ?? ""
        status = try row.optString("status") ?? ""
    }
}

struct EntryPairRow: Equatable, Sendable {
    var eventId: String = ""
    var player1Id: String = ""
    var player2Id: String = ""
    var status: String = ""
}

extension EntryPairRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        eventId = try row.optString("event_id") ?? ""
        player1Id = try row.optString("player1_id") ?? ""
        player2Id = try row.optString("player2_id") ?? ""
        status = try row.optString("status") ?? ""
    }
}

struct OwnRatingRow: Equatable, Sendable {
    var singlesElo: Double? = nil
    var doublesElo: Double? = nil
    var singlesWins: Int? = nil
    var singlesLosses: Int? = nil
    var doublesWins: Int? = nil
    var doublesLosses: Int? = nil
    var singlesProvisional: Bool? = nil
    var doublesProvisional: Bool? = nil
}

extension OwnRatingRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        singlesElo = try row.optDouble("singles_elo")
        doublesElo = try row.optDouble("doubles_elo")
        singlesWins = try row.optInt("singles_wins")
        singlesLosses = try row.optInt("singles_losses")
        doublesWins = try row.optInt("doubles_wins")
        doublesLosses = try row.optInt("doubles_losses")
        singlesProvisional = try row.optBool("singles_provisional")
        doublesProvisional = try row.optBool("doubles_provisional")
    }
}

// MARK: Queries, in the web's chain order

let clubEventCalendarColumns = "id, title, kind, location, starts_at, ends_at, status"
let riverColumns = """
      id, played_at, match_type, format, score_summary,
      match_participants(team_side, win_flag, rating_delta, post_rating,
        player:players(id, full_name, handle, avatar_url))
    """
let pendingChallengeColumns =
    "id, challenge:challenges(id, type, format, created_at, creator:players!challenges_created_by_fkey(id, full_name, handle, avatar_url))"
let ownRatingColumns =
    "singles_elo, doubles_elo, singles_wins, singles_losses, doubles_wins, doubles_losses, singles_provisional, doubles_provisional"

/// The server's own row page and the in-list chunk query-chunks.ts uses.
let rowPageSize = 500
let inChunkSize = 110

/// The active season with its dates. get_active_season() carries neither date.
func activeSeasonRowQuery() -> PostgrestQuery {
    PostgrestQuery.select("seasons", "id, name, start_date, end_date").eq("active_flag", "true")
}

func featureFlagsQuery() -> PostgrestQuery { PostgrestQuery.select("platform_settings", "value").eq("key", "features") }

func checkinSettingsQuery() -> PostgrestQuery {
    PostgrestQuery.select("platform_settings", "value").eq("key", "session_attendance")
}

private extension PostgrestQuery {
    func sessionSeason(_ seasonId: String?) -> PostgrestQuery {
        guard let seasonId, !seasonId.isEmpty else { return self }
        return or("season_id.eq.\(seasonId),season_id.is.null")
    }

    func tournamentSeason(_ seasonId: String?) -> PostgrestQuery {
        guard let filter = activeSeasonOrFilter(seasonId) else { return self }
        return or(filter)
    }
}

func openSessionsQuery(_ seasonId: String?, _ playerStatus: String?) -> PostgrestQuery {
    PostgrestQuery.select("sessions", "*")
        .eq("status", "open")
        .sessionSeason(seasonId)
        .isIn("track", visibleTracksFor(playerStatus))
        .order("date", ascending: true)
        .order("start_time", ascending: true, nullsLast: true)
}

func calendarSessionsQuery(_ seasonId: String?, _ playerStatus: String?) -> PostgrestQuery {
    PostgrestQuery.select("sessions", "id, name, date, start_time, status, season_id")
        .sessionSeason(seasonId)
        .isIn("track", visibleTracksFor(playerStatus))
        .order("date", ascending: true)
        .order("start_time", ascending: true, nullsLast: true)
}

func clubEventsQuery(_ lowerBoundIso: String) -> PostgrestQuery {
    PostgrestQuery.select("club_events", clubEventCalendarColumns)
        .isIn("status", ["published", "cancelled"])
        .gte("starts_at", lowerBoundIso)
        .order("starts_at", ascending: true)
        .limit(200)
}

func calendarTournamentsQuery(_ seasonId: String?) -> PostgrestQuery {
    PostgrestQuery.select("tournaments", "id, name, start_date, end_date, status, suspended_at")
        .isIn("status", ["active", "completed"])
        .tournamentSeason(seasonId)
        .order("start_date", ascending: true)
}

func mySignupsQuery(_ playerId: String) -> PostgrestQuery {
    PostgrestQuery.select("club_event_signups", "event_id").eq("player_id", playerId)
}

func myAttendanceQuery(_ playerId: String) -> PostgrestQuery {
    PostgrestQuery.select("session_attendance", "session_id, status").eq("player_id", playerId)
}

func myRsvpQuery(_ playerId: String) -> PostgrestQuery {
    PostgrestQuery.select("session_rsvp", "session_id, intent").eq("player_id", playerId)
}

/// One page of "going" RSVPs for a chunk of sessions. The policy on session_rsvp is USING (TRUE).
func goingQuery(_ sessionIds: [String], offset: Int) -> PostgrestQuery {
    PostgrestQuery.select("session_rsvp", "session_id")
        .isIn("session_id", sessionIds)
        .eq("intent", "going")
        .order("session_id", ascending: true)
        .offset(offset)
        .limit(rowPageSize)
}

/// Checked-in counts per session, an aggregate: never other members' attendance rows.
func attendeeCountsRpc(_ sessionIds: [String]) -> PostgrestQuery {
    PostgrestQuery.rpc("get_session_attendee_counts", .object([("p_session_ids", .array(sessionIds.map(JSONValue.string)))]))
}

func streakSessionsQuery(_ today: String, _ seasonId: String?, _ playerStatus: String?) -> PostgrestQuery {
    PostgrestQuery.select("sessions", "id, date")
        .lt("date", today)
        .sessionSeason(seasonId)
        .isIn("track", visibleTracksFor(playerStatus))
        .order("date", ascending: false)
        .limit(20)
}

/// Expiry and season as two separate or params, which PostgREST ANDs.
func announcementsQuery(_ nowIso: String, _ seasonId: String?) -> PostgrestQuery {
    var q = PostgrestQuery.select("announcements", "id, title, body, created_at, target_audience, author:players(full_name)")
        .eq("status", "published")
        .or(announcementExpiryFilter(nowIso))
    if let season = announcementSeasonFilter(seasonId) { q = q.or(season) }
    return q.order("pinned", ascending: false).order("created_at", ascending: false).limit(3)
}

func riverQuery(_ seasonId: String?) -> PostgrestQuery {
    PostgrestQuery.select("matches", riverColumns)
        .eq("result_status", "confirmed")
        .notIsNull("played_at")
        .sessionSeason(seasonId)
        .order("played_at", ascending: false)
        .limit(15)
}

func pendingChallengesQuery(_ playerId: String) -> PostgrestQuery {
    PostgrestQuery.select("challenge_participants", pendingChallengeColumns)
        .eq("player_id", playerId)
        .eq("confirmation_status", "pending")
        .limit(5)
}

func liveTournamentsQuery(_ seasonId: String?) -> PostgrestQuery {
    PostgrestQuery.select("tournaments", "id, name, start_date, end_date, tournament_events(id, event_type, status)")
        .eq("status", "active")
        .isNull("suspended_at")
        .tournamentSeason(seasonId)
        .order("start_date", ascending: true)
}

func entryParticipantsQuery(_ eventIds: [String]) -> PostgrestQuery {
    PostgrestQuery.select("tournament_participants", "event_id, player_id, status").isIn("event_id", eventIds)
}

func entryPairsQuery(_ eventIds: [String]) -> PostgrestQuery {
    PostgrestQuery.select("tournament_pairs", "event_id, player1_id, player2_id, status").isIn("event_id", eventIds)
}

func ownRatingQuery(_ playerId: String) -> PostgrestQuery {
    PostgrestQuery.select("ratings", ownRatingColumns).eq("player_id", playerId)
}

func ownFeesQuery(_ playerId: String) -> PostgrestQuery {
    PostgrestQuery.select("club_fees", ownFeeColumns).eq("player_id", playerId).order("created_at", ascending: false)
}

func seasonFeesQuery(_ seasonId: String) -> PostgrestQuery {
    PostgrestQuery.select("seasons", "id, name, end_date, competitive_fee_cents, recreational_fee_cents").eq("id", seasonId)
}

/// The club events window starts at the term's first day, or 60 days back with none, at club midnight.
func clubEventsLowerBound(_ season: FeedSeasonRow?, _ today: String) -> String {
    let from = season?.startDate.map { String($0.prefix(10)) } ?? addDaysISO(today, -60)
    let p = from.split(separator: "-", omittingEmptySubsequences: false).map { Int($0) ?? 1 }
    return isoMillis(wallClockToUtc(p[0], p.count > 1 ? p[1] : 1, p.count > 2 ? p[2] : 1, 0, 0))
}

// MARK: What the screen shows

/// Where a tap goes. Web paths open in the browser, and only when the site is known.
enum FeedLink: Equatable, Sendable {
    case myStats
    case membership
    case newChallenge
    case challenges
    case challenge(String)
    case web(String)
}

struct FeedStanding: Equatable, Sendable {
    let title: String
    let body: String
}

struct LiveEntryRow: Equatable, Sendable {
    let eventLabel: String
    let checkedIn: Bool
    let link: FeedLink
}

struct LiveTournamentCard: Equatable, Sendable {
    let id: String
    let name: String
    let eyebrow: String
    let meta: String
    let entries: [LiveEntryRow]
    /// Set when the member is in none of the running events.
    let notEntered: String?
    let follow: FeedLink
}

enum FeedAgendaRow: Equatable, Sendable {
    struct Session: Equatable, Sendable {
        let key: String
        let id: String
        let name: String
        let trackTag: String?
        let timeLabel: String
        let location: String?
        let goingCount: Int
        let checkedInCount: Int
        let notes: String?
        /// "Checked In", "Attended", "No-show" or "Excused" once attendance is on the record.
        let stateChip: String?
        let windowLabel: String?
        let isNext: Bool
        /// Check-in is open for this member; the card offers the door-code scan.
        let canScan: Bool
    }

    struct ClubEvent: Equatable, Sendable {
        let key: String
        let kindLabel: String
        let title: String
        let cancelled: Bool
        let meta: String
        let going: Bool
        let link: FeedLink
    }

    struct Tournament: Equatable, Sendable {
        let key: String
        let name: String
        let whenLabel: String
        let link: FeedLink
    }

    case session(Session)
    case clubEvent(ClubEvent)
    case tournament(Tournament)

    var key: String {
        switch self {
        case let .session(s): return s.key
        case let .clubEvent(e): return e.key
        case let .tournament(t): return t.key
        }
    }
}

struct AgendaDay: Equatable, Sendable {
    let dateISO: String
    let label: String
    let dateLabel: String
    let isToday: Bool
    let rows: [FeedAgendaRow]
}

struct FeedEmpty: Equatable, Sendable {
    let title: String
    let hint: String
}

struct FeedNotice: Equatable, Sendable {
    let title: String
    let body: String
    let meta: String
}

struct RiverRow: Equatable, Sendable {
    let key: String
    let at: String
    let mine: Bool
    let isChallenge: Bool
    let sentence: String
    let meta: String
    let face: RiverPerson
    /// "+14", the reader's own rows only.
    let delta: String?
    let deltaUp: Bool
    let rating: String?
    let link: FeedLink
}

struct YouFigure: Equatable, Sendable {
    let label: String
    let value: String
    let sub: String
}

struct YouCard: Equatable, Sendable {
    let streak: Int?
    let figures: [YouFigure]
    let note: String?
    let showMyStats: Bool
}

struct Feed: Equatable, Sendable {
    let eyebrow: String
    let standing: FeedStanding?
    /// "$40.00" or "fees" when a payment is owed; nil hides the banner.
    let paymentAmount: String?
    let liveTournaments: [LiveTournamentCard]
    let scheduleOn: Bool
    let sessionsOn: Bool
    let week: [WeekStripDay]
    let agendaDates: Set<String>
    let upNextSub: String
    let scheduleError: Bool
    let empty: FeedEmpty?
    let agendaSoon: [AgendaDay]
    let agendaLater: [AgendaDay]
    let clubEventsError: Bool
    let tournamentsError: Bool
    let notice: FeedNotice?
    let river: [DaySection<RiverRow>]
    let riverEnd: String
    let showChallengeCta: Bool
    let announcementsOn: Bool
    let you: YouCard
}

private let standingTail =
    " You can still see the schedule and the feed. RSVP and check-in open once your account is in good standing."

private let standingDetail = [
    "pending_approval": "Your membership is waiting for an exec to approve it. Until then you can look around, but challenges, RSVPs, check-ins and tournament entries are on hold.",
    "suspended": "Your account is suspended, so club activity is paused. Contact an exec if you think this is a mistake.",
]

/// Everything the reads returned. A nil list is a read that failed; an empty one found nothing or was not sent.
struct FeedInputs: Sendable {
    var season: FeedSeasonRow?
    var flags: [String: Bool] = defaultFeatureFlags
    var checkin: CheckinSettings = fallbackCheckinSettings
    var openSessions: [OpenSessionRow]? = []
    var calendarSessions: [CalendarSessionRow]? = []
    var clubEvents: [CalendarClubEventRow]? = []
    var calendarTournaments: [CalendarTournamentRow]? = []
    var attendance: [String: String?] = [:]
    var intents: [String: String?] = [:]
    var signedUp: Set<String> = []
    var pastSessionIds: [String] = []
    var announcements: [FeedAnnouncementRow] = []
    var river: [RiverMatchRow] = []
    var pendingChallenges: [PendingChallengeRow] = []
    /// The live tournaments already under way today, or empty when the read or the entries failed.
    var liveTournaments: [FeedTournament] = []
    var entryParticipants: [EntryParticipantRow] = []
    var entryPairs: [EntryPairRow] = []
    var checkedIn: [String: Int] = [:]
    var going: [String: Int] = [:]
    var rating: OwnRatingRow? = nil
    var prompt: PaymentPrompt = .none
}

/// The open sessions that carry a card: kept until their check-in window closes.
func upcomingSessionIds(_ sessions: [OpenSessionRow], _ settings: CheckinSettings, now: Date) -> [String] {
    sessions.filter { isStillUpcoming(getCheckinWindow($0, settings).closesAt, now: now) }.map(\.id)
}

private func countLabel(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }

private func deltaLabel(_ d: Double) -> String {
    let n = roundHalfUp(d)
    return n >= 0 ? "+\(n)" : String(n)
}

private func toPerson(_ p: Person?) -> RiverPerson? {
    guard let p, let id = p.id else { return nil }
    return RiverPerson(id: id, name: p.fullName ?? "Someone", handle: p.handle, avatarUrl: p.avatarUrl)
}

private func nonEmpty(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}

private func sessionTime(_ s: OpenSessionRow) -> String {
    guard let start = nonEmpty(s.startTime) else { return "Time TBC" }
    guard let end = nonEmpty(s.endTime) else { return formatTime(start) }
    return "\(formatTime(start)) to \(formatTime(end))"
}

private func stateChip(_ status: String?) -> String? {
    switch status {
    case "checked_in"?: return "Checked In"
    case "present"?: return "Attended"
    case "no_show"?: return "No-show"
    case "excused"?: return "Excused"
    default: return nil
    }
}

private func millis(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded(.down)) }

/// Pure: every string the Feed shows, from what the reads returned.
func buildFeed(_ inputs: FeedInputs, viewer: Viewer, now: Date) -> Feed {
    let today = clubToday(now)
    func on(_ id: String) -> Bool { featureOn(inputs.flags, id) }
    let sessionsOn = on("sessions")
    let eventsOn = on("events")
    let tournamentsOn = on("tournaments")
    let approved = isApproved(viewer)
    let season = inputs.season

    let week = season?.startDate.flatMap { seasonWeek($0, now: now) }
    let eyebrowParts = [nonEmpty(season?.name), week.map { "Week \($0)" }].compactMap { $0 }
    let eyebrow = (eyebrowParts.isEmpty ? "The club" : eyebrowParts.joined(separator: " \u{00B7} ")).uppercased()

    var standing: FeedStanding?
    if !approved {
        let pending = viewer.status == "pending_approval"
        standing = FeedStanding(
            title: pending ? "Waiting on approval" : "Account suspended",
            body: standingDetail[pending ? "pending_approval" : "suspended"]! + standingTail,
        )
    }

    var paymentAmount: String?
    if case let .owing(total, unknown, _) = inputs.prompt, approved, on("fees") {
        paymentAmount = total == 0 && unknown > 0 ? "fees" : money(total)
    }

    // Live tournament cards.
    let live = tournamentsOn ? inputs.liveTournaments : []
    let liveCards: [LiveTournamentCard] = live.map { t in
        let running = runningEvents(t)
        let eventIds = Set(running.map(\.id))
        let mine: [LiveEntryRow] = running.compactMap { e in
            let solo = inputs.entryParticipants.first { $0.eventId == e.id && $0.playerId == viewer.id && occupiesAPlace($0.status) }
            let pair = inputs.entryPairs.first {
                $0.eventId == e.id && ($0.player1Id == viewer.id || $0.player2Id == viewer.id) && occupiesAPlace($0.status)
            }
            guard let status = solo?.status ?? pair?.status else { return nil }
            return LiveEntryRow(
                eventLabel: tournamentEventTypeLabels[e.eventType] ?? e.eventType,
                checkedIn: status == "checked_in",
                link: .web("/tournaments/\(t.id)/events/\(e.id)"),
            )
        }
        let entered = countEnteredPlayers(
            inputs.entryParticipants.filter { eventIds.contains($0.eventId) }.map { EntrantRow(playerId: $0.playerId, status: $0.status) },
            inputs.entryPairs.filter { eventIds.contains($0.eventId) }.map { EntrantPairRow(player1Id: $0.player1Id, player2Id: $0.player2Id, status: $0.status) },
        )
        let meta = [dayLabel(String(t.startDate.prefix(10)), today), entered > 0 ? countLabel(entered, "PLAYER", "PLAYERS") : nil]
            .compactMap { $0 }.joined(separator: " \u{00B7} ")
        let notEntered: String?
        if !mine.isEmpty {
            notEntered = nil
        } else if running.count == 1 {
            notEntered = "The \(tournamentEventTypeLabels[running[0].eventType] ?? running[0].eventType) is on now. You are not entered. The draw is open to watch."
        } else {
            notEntered = "\(running.count) events are on now. You are not entered. The draws are open to watch."
        }
        return LiveTournamentCard(id: t.id, name: t.name, eyebrow: underWayEyebrow(running), meta: meta, entries: mine, notEntered: notEntered, follow: .web("/tournaments/\(t.id)"))
    }

    // The schedule.
    let openSessions = inputs.openSessions ?? []
    let clubEvents = inputs.clubEvents ?? []
    let calendarTournaments = inputs.calendarTournaments ?? []
    let agenda = buildAgenda(
        sessions: openSessions,
        clubEvents: clubEvents,
        tournaments: calendarTournaments,
        now: now,
        todayISO: today,
        checkinSettings: inputs.checkin,
        liveTournamentIds: Set(live.map(\.id)),
    )
    let upcoming: [OpenSessionRow] = agenda.flatMap { day in
        day.sessions.compactMap { entry -> OpenSessionRow? in
            if case let .session(_, _, _, _, s) = entry { return s }
            return nil
        }
    }
    let hasCard = Set(upcoming.map(\.id))
    func state(_ id: String) -> MyState { describeMyState(inputs.attendance[id] ?? nil, inputs.intents[id] ?? nil) }
    func isMine(_ id: String) -> Bool { [.going, .checkedIn, .attended].contains(state(id)) }
    let myUpcoming = upcoming.filter { isMine($0.id) }.count
    let eventCount = agenda.reduce(0) { sum, day in
        sum + day.sessions.filter { if case .clubEvent = $0 { return true } else { return false } }.count
    }
    let nextSessionId = (upcoming.first { $0.date >= today } ?? upcoming.first)?.id

    let calendarItems = sortedCalendar(
        (inputs.calendarSessions ?? []).map { sessionCalendarItem($0, mine: isMine($0.id), hasCard: hasCard.contains($0.id)) } +
            clubEvents.compactMap { clubEventCalendarItem($0, mine: inputs.signedUp.contains($0.id)) } +
            calendarTournaments.flatMap { tournamentCalendarItems($0) },
    )

    func row(_ entry: AgendaEntry<OpenSessionRow>) -> FeedAgendaRow {
        switch entry {
        case let .clubEvent(key, _, _, _, e):
            let time = parseInstant(e.startsAt).map { clubEventWallClock($0).time }
            return .clubEvent(FeedAgendaRow.ClubEvent(
                key: key,
                kindLabel: clubEventKindLabels[e.kind] ?? "Club event",
                title: e.title,
                cancelled: e.status == "cancelled",
                meta: [time.map(formatTime), nonEmpty(e.location)].compactMap { $0 }.joined(separator: " \u{00B7} "),
                going: inputs.signedUp.contains(e.id),
                link: .web("/events/\(e.id)"),
            ))
        case let .tournament(key, _, _, t):
            return .tournament(FeedAgendaRow.Tournament(key: key, name: t.name, whenLabel: tournamentWhen(t, today), link: .web("/tournaments/\(t.id)")))
        case let .session(key, _, _, _, s):
            let canCheckIn = isCheckinOpen(s, now: now, inputs.checkin)
            let status = inputs.attendance[s.id] ?? nil
            let intent = inputs.intents[s.id] ?? nil
            let recorded = isAttendanceRecorded(status)
            var windowLabel: String?
            if !canCheckIn && s.date >= today {
                if let opensAt = getCheckinWindow(s, inputs.checkin).opensAt, now < opensAt {
                    windowLabel = "Opens at " + formatTime(String(utcToClubWallClock(opensAt).dropFirst(11)))
                } else {
                    windowLabel = "Check-in closed"
                }
            }
            let showWindow = windowLabel != nil && !recorded && !canCheckIn && intent != "declined" && approved
            let track = nonEmpty(s.track).flatMap { $0 == "all" ? nil : $0.uppercased() }
            return .session(FeedAgendaRow.Session(
                key: key,
                id: s.id,
                name: s.name ?? "Practice Session",
                trackTag: track,
                timeLabel: sessionTime(s),
                location: nonEmpty(s.location),
                goingCount: inputs.going[s.id] ?? 0,
                checkedInCount: inputs.checkedIn[s.id] ?? 0,
                notes: nonEmpty(s.notes),
                stateChip: stateChip(status),
                windowLabel: showWindow ? windowLabel : nil,
                isNext: s.id == nextSessionId,
                canScan: canCheckIn && approved && intent != "declined" && !recorded,
            ))
        }
    }

    func day(_ group: DayGroup<AgendaEntry<OpenSessionRow>>) -> AgendaDay {
        AgendaDay(dateISO: group.dateISO, label: group.heading.label, dateLabel: group.heading.dateLabel, isToday: group.heading.isToday, rows: group.sessions.map(row))
    }

    let cutoff = addDaysISO(today, 14)
    let soonAll = agenda.filter { $0.dateISO < cutoff }
    let soon = soonAll.count >= 3 ? soonAll : Array(agenda.prefix(3))
    let later = Array(agenda.dropFirst(soon.count))

    let upNextParts = [
        upcoming.isEmpty ? nil : countLabel(upcoming.count, "session", "sessions") + " coming up",
        myUpcoming > 0 ? "you're in for \(myUpcoming)" : nil,
        eventCount > 0 ? countLabel(eventCount, "club event", "club events") : nil,
    ].compactMap { $0 }
    let upNextSub = upNextParts.isEmpty ? "Nothing on the calendar." : upNextParts.joined(separator: " \u{00B7} ") + "."

    let scheduleError = inputs.openSessions == nil || inputs.calendarSessions == nil
    let empty: FeedEmpty?
    if scheduleError || !agenda.isEmpty {
        empty = nil
    } else if !sessionsOn {
        empty = FeedEmpty(title: "Nothing coming up", hint: "Club events and tournaments show up here when the exec posts them.")
    } else if let season {
        empty = FeedEmpty(
            title: "No sessions yet",
            hint: "Nothing has been posted for \(season.name ?? "null") yet. New practices show up here as soon as the exec adds them. Watch announcements.",
        )
    } else {
        empty = FeedEmpty(title: "No season is running", hint: "Sessions appear here once the exec opens a new term. Watch announcements for the start date.")
    }

    // Club activity.
    let nowMs = millis(now)
    let announcementsOn = on("announcements")
    var notice: FeedNotice?
    if announcementsOn, let a = inputs.announcements.first(where: { isAddressedTo($0.targetAudience, viewer.status, viewer.eligibilityFlag) }) {
        let author = pickOne(a.author) { try $0.optString("full_name") } ?? nil
        let by = author.map { "Posted by \($0)" } ?? "Posted by the club"
        notice = FeedNotice(title: a.title, body: plainAnnouncementText(a.body), meta: "\(by) \u{00B7} \(formatRelativeTime(a.createdAt, now: nowMs))")
    }

    let myStatsOn = on("my_stats")
    func person(_ p: RiverParticipantRow) -> Person? { pickOne(p.player, Person.init(json:)) }
    let matchRows: [RiverRow] = inputs.river.compactMap { m in
        let rows = m.participants ?? []
        let winners = rows.filter { $0.winFlag == true }.compactMap { toPerson(person($0)) }
        let losers = rows.filter { $0.winFlag == false }.compactMap { toPerson(person($0)) }
        guard let sentence = describeMatch(winners, losers, viewerId: viewer.id), let playedAt = m.playedAt else { return nil }
        let mineRow = rows.first { person($0)?.id == viewer.id }
        let mine = mineRow != nil
        let faceOrNil = mine ? (mineRow?.winFlag == true ? losers.first : winners.first) : winners.first
        guard let face = faceOrNil else { return nil }
        let meta = [
            m.matchType == "doubles" ? "Doubles" : "Singles",
            nonEmpty(m.scoreSummary) ?? m.format.map(formatLabel) ?? "",
            formatRelativeTime(playedAt, now: nowMs),
        ].filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
        let d = mine ? mineRow?.ratingDelta : nil
        return RiverRow(
            key: "match-\(m.id)",
            at: playedAt,
            mine: mine,
            isChallenge: false,
            sentence: sentence,
            meta: meta,
            face: face,
            delta: d.map(deltaLabel),
            deltaUp: (d ?? 0) >= 0,
            rating: mine ? mineRow?.postRating.map { String(roundHalfUp($0)) } : nil,
            link: mine && myStatsOn ? .myStats : .web("/leaderboard/\(face.id)"),
        )
    }
    let challengeRows: [RiverRow] = !on("challenges") ? [] : inputs.pendingChallenges.compactMap { pc in
        guard let c = pickOne(pc.challenge, PendingChallengeEmbed.init(json:)),
              let creator = toPerson(pickOne(c.creator, Person.init(json:))),
              let at = nonEmpty(c.createdAt) else { return nil }
        return RiverRow(
            key: "challenge-\(pc.id)",
            at: at,
            mine: true,
            isChallenge: true,
            sentence: "\(creator.name) wants to play you",
            meta: ["Challenge", c.format.map(formatLabel) ?? ""].filter { !$0.isEmpty }.joined(separator: " \u{00B7} "),
            face: creator,
            delta: nil,
            deltaUp: true,
            rating: nil,
            link: approved ? .challenge(c.id) : .challenges,
        )
    }
    let river = groupByDay(matchRows + challengeRows, now: now) { $0.at }

    // You.
    let r = inputs.rating
    let played = (r?.singlesWins ?? 0) + (r?.singlesLosses ?? 0) + (r?.doublesWins ?? 0) + (r?.doublesLosses ?? 0)
    func figure(_ label: String, _ elo: Double?, _ provisional: Bool?, _ wins: Int?, _ losses: Int?) -> YouFigure {
        YouFigure(
            label: label,
            value: elo.map { String(roundHalfUp($0)) } ?? "None",
            sub: (provisional == true ? "Provisional \u{00B7} " : "") + "\(wins ?? 0)W \u{00B7} \(losses ?? 0)L",
        )
    }
    let attended = Set(inputs.attendance.filter { wasPresent($0.value) }.keys)
    let you = YouCard(
        streak: sessionsOn ? attendanceStreak(inputs.pastSessionIds, attended) : nil,
        figures: played > 0 ? [
            figure("Singles", r?.singlesElo, r?.singlesProvisional, r?.singlesWins, r?.singlesLosses),
            figure("Doubles", r?.doublesElo, r?.doublesProvisional, r?.doublesWins, r?.doublesLosses),
        ] : [],
        note: played == 0
            ? "No rated matches yet. Your singles and doubles ratings start level and move the first time a result is confirmed."
            : nil,
        showMyStats: myStatsOn,
    )

    return Feed(
        eyebrow: eyebrow,
        standing: standing,
        paymentAmount: paymentAmount,
        liveTournaments: liveCards,
        scheduleOn: sessionsOn || eventsOn || tournamentsOn,
        sessionsOn: sessionsOn,
        week: buildWeekStrip(calendarItems, today),
        agendaDates: Set(agenda.map(\.dateISO)),
        upNextSub: upNextSub,
        scheduleError: scheduleError,
        empty: empty,
        agendaSoon: soon.map(day),
        agendaLater: later.map(day),
        clubEventsError: inputs.clubEvents == nil,
        tournamentsError: inputs.calendarTournaments == nil,
        notice: notice,
        river: river,
        riverEnd: week.map { "End of week \($0)" } ?? "End of the feed",
        showChallengeCta: approved && on("challenges"),
        announcementsOn: announcementsOn,
        you: you,
    )
}

// MARK: The loader

/// One read, its failure caught so it costs only its own card. Cancellation is never swallowed.
private func attempt<T>(_ body: () async throws -> T) async throws -> Result<T, Error> {
    do {
        return .success(try await body())
    } catch is CancellationError {
        throw CancellationError()
    } catch {
        return .failure(error)
    }
}

/// A list read that is sent only when its card is on; skipped reads are an empty success.
private func listRead<T>(_ on: Bool, _ body: () async throws -> [T]) async throws -> Result<[T], Error> {
    on ? try await attempt(body) : .success([])
}

private extension Result {
    var value: Success? {
        if case let .success(v) = self { return v }
        return nil
    }

    var failed: Bool {
        if case .failure = self { return true }
        return false
    }
}

/// Every "going" RSVP for these sessions: in-lists chunked, each chunk paged until a short page.
private func loadGoing(_ postgrest: Postgrest, _ ids: [String]) async throws -> [String] {
    let chunks = stride(from: 0, to: ids.count, by: inChunkSize).map { Array(ids[$0..<min($0 + inChunkSize, ids.count)]) }
    return try await withThrowingTaskGroup(of: (Int, [String]).self) { group in
        for (index, batch) in chunks.enumerated() {
            group.addTask {
                var out: [String] = []
                var offset = 0
                while true {
                    let page = try await postgrest.list(goingQuery(batch, offset: offset), what: "who is going") { try $0.object().optString("session_id") ?? "" }
                    out += page
                    if page.count < rowPageSize { break }
                    offset += rowPageSize
                }
                return (index, out)
            }
        }
        var results = Array(repeating: [String](), count: chunks.count)
        for try await (index, out) in group { results[index] = out }
        return results.flatMap { $0 }
    }
}

/**
 * Three rounds, as the page runs them: the season and the switches; then every
 * read the page makes at once; then the tournament entries and the counts,
 * which need the first two. Only a failed season read is not shown: the page
 * treats it as "no season" too.
 */
func loadFeed(_ postgrest: Postgrest, viewer: Viewer, now: Date = Date()) async throws -> Feed {
    let today = clubToday(now)
    async let seasonRead = attempt { try await postgrest.maybeSingle(activeSeasonRowQuery(), what: "the season", FeedSeasonRow.init(json:)) }
    async let flagsRead = attempt { try await postgrest.maybeSingle(featureFlagsQuery(), what: "the club switches") { $0["value"] } }
    let season = try await seasonRead.value ?? nil
    let flags: [String: Bool]
    switch try await flagsRead {
    case let .success(row): flags = parseFeatureFlags(row ?? nil)
    case .failure: flags = defaultFeatureFlags
    }
    let sessionsOn = featureOn(flags, "sessions")
    let eventsOn = featureOn(flags, "events")
    let tournamentsOn = featureOn(flags, "tournaments")
    let announcementsOn = featureOn(flags, "announcements")
    let challengesOn = featureOn(flags, "challenges")
    let feesOn = featureOn(flags, "fees")
    let approved = isApproved(viewer)
    let seasonId = season?.id
    let status = viewer.status
    let viewerId = viewer.id

    async let pastRead = listRead(sessionsOn) {
        try await postgrest.list(streakSessionsQuery(today, seasonId, status), what: "past sessions") { try $0.object().optString("id") ?? "" }
    }
    async let attendanceRead = listRead(sessionsOn) {
        try await postgrest.list(myAttendanceQuery(viewerId), what: "your attendance") { json -> (String, String?) in
            (try json.object().optString("session_id") ?? "", try json.optString("status"))
        }
    }
    async let announcementsRead = listRead(announcementsOn) {
        try await postgrest.list(announcementsQuery(isoMillis(now), seasonId), what: "announcements", FeedAnnouncementRow.init(json:))
    }
    async let riverRead = attempt { try await postgrest.list(riverQuery(seasonId), what: "results", RiverMatchRow.init(json:)) }
    async let challengesRead = listRead(challengesOn) {
        try await postgrest.list(pendingChallengesQuery(viewerId), what: "challenges", PendingChallengeRow.init(json:))
    }
    async let liveRead = listRead(tournamentsOn) {
        try await postgrest.list(liveTournamentsQuery(seasonId), what: "tournaments", FeedTournament.init(json:))
    }
    async let openRead = listRead(sessionsOn) {
        try await postgrest.list(openSessionsQuery(seasonId, status), what: "sessions", OpenSessionRow.init(json:))
    }
    async let calendarRead = listRead(sessionsOn) {
        try await postgrest.list(calendarSessionsQuery(seasonId, status), what: "sessions", CalendarSessionRow.init(json:))
    }
    async let rsvpRead = listRead(sessionsOn) {
        try await postgrest.list(myRsvpQuery(viewerId), what: "your RSVPs") { json -> (String, String?) in
            (try json.object().optString("session_id") ?? "", try json.optString("intent"))
        }
    }
    async let eventsRead = listRead(eventsOn) {
        try await postgrest.list(clubEventsQuery(clubEventsLowerBound(season, today)), what: "club events", CalendarClubEventRow.init(json:))
    }
    async let signupsRead = listRead(eventsOn) {
        try await postgrest.list(mySignupsQuery(viewerId), what: "your sign-ups") { try $0.object().optString("event_id") ?? "" }
    }
    async let calendarTournamentsRead = listRead(tournamentsOn) {
        try await postgrest.list(calendarTournamentsQuery(seasonId), what: "tournaments", CalendarTournamentRow.init(json:))
    }
    async let settingsRead = attempt { try await postgrest.maybeSingle(checkinSettingsQuery(), what: "check-in settings") { $0["value"] } }
    async let ratingRead = attempt { try await postgrest.maybeSingle(ownRatingQuery(viewerId), what: "your rating", OwnRatingRow.init(json:)) }
    async let promptRead = feePrompt(postgrest, viewer: viewer, seasonId: seasonId, sendIt: approved && feesOn)

    let settings: CheckinSettings
    switch try await settingsRead {
    case let .success(row): settings = parseCheckinSettings(row ?? nil)
    case .failure: settings = fallbackCheckinSettings
    }
    let openSessions = try await openRead.value
    let liveRows = (try await liveRead.value ?? [])
        .map { t -> FeedTournament in
            var t = t
            t.tournamentEvents = t.tournamentEvents ?? []
            return t
        }
        .filter { isUnderWay($0, today) }
    let runningIds = liveRows.flatMap { runningEvents($0).map(\.id) }
    let upcomingIds = upcomingSessionIds(openSessions ?? [], settings, now: now)

    async let participantsRead = listRead(!runningIds.isEmpty) {
        try await postgrest.list(entryParticipantsQuery(runningIds), what: "entries", EntryParticipantRow.init(json:))
    }
    async let pairsRead = listRead(!runningIds.isEmpty) {
        try await postgrest.list(entryPairsQuery(runningIds), what: "entries", EntryPairRow.init(json:))
    }
    async let countsRead = listRead(!upcomingIds.isEmpty) {
        try await postgrest.list(attendeeCountsRpc(upcomingIds), what: "check-in counts") { json -> (String, Double?) in
            (try json.object().optString("session_id") ?? "", try json.optDouble("attendees"))
        }
    }
    async let goingRead = listRead(!upcomingIds.isEmpty) { try await loadGoing(postgrest, upcomingIds) }

    let participants = try await participantsRead
    let pairs = try await pairsRead
    let entriesFailed = participants.failed || pairs.failed

    var checkedIn: [String: Int] = [:]
    for (id, attendees) in try await countsRead.value ?? [] {
        checkedIn[id] = attendees.flatMap { $0.isFinite && abs($0) < 1e15 ? Int($0) : nil } ?? 0
    }
    var attendance: [String: String?] = [:]
    for (id, s) in try await attendanceRead.value ?? [] { attendance[id] = s }
    var intents: [String: String?] = [:]
    for (id, i) in try await rsvpRead.value ?? [] { intents[id] = i }

    let inputs = FeedInputs(
        season: season,
        flags: flags,
        checkin: settings,
        openSessions: openSessions,
        calendarSessions: try await calendarRead.value,
        clubEvents: try await eventsRead.value,
        calendarTournaments: try await calendarTournamentsRead.value,
        attendance: attendance,
        intents: intents,
        signedUp: Set(try await signupsRead.value ?? []),
        pastSessionIds: try await pastRead.value ?? [],
        announcements: try await announcementsRead.value ?? [],
        river: try await riverRead.value ?? [],
        pendingChallenges: try await challengesRead.value ?? [],
        liveTournaments: entriesFailed ? [] : liveRows,
        entryParticipants: entriesFailed ? [] : participants.value ?? [],
        entryPairs: entriesFailed ? [] : pairs.value ?? [],
        checkedIn: checkedIn,
        going: tallyBySession(try await goingRead.value),
        rating: try await ratingRead.value ?? nil,
        prompt: try await promptRead,
    )
    return buildFeed(inputs, viewer: viewer, now: now)
}

/// The Pay now banner's figure: only for an approved member with fees on who is neither an exec nor exempt.
private func feePrompt(_ postgrest: Postgrest, viewer: Viewer, seasonId: String?, sendIt: Bool) async throws -> PaymentPrompt {
    let payer = FeePayer(isExec: viewer.isExec == true, feeExempt: viewer.feeExempt == true)
    if !sendIt || payer.isExec || payer.feeExempt { return .none }
    let result = try await attempt { () async throws -> PaymentPrompt in
        async let rows = postgrest.list(ownFeesQuery(viewer.id), what: "your fees", OwnFeeRow.init(json:))
        var fees: StatementSeason?
        if let seasonId {
            fees = try await postgrest.maybeSingle(seasonFeesQuery(seasonId), what: "the season", StatementSeason.init(json:))
        }
        return paymentPrompt(toPayableLines(try await rows, season: fees, status: viewer.status), payer)
    }
    return result.value ?? .none
}
