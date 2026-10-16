import Foundation

// Port of Statement.kt (the Expo app's src/lib/statement.ts), built the way
// /membership builds it (apps/player/src/app/membership/member-section.tsx)
// from the same rows and the same ledger rules, so the phone and the website
// print one figure. Keep in step with both.

/// The member's own fee rows, as apps/player/src/lib/member-fees.ts reads them.
let ownFeeColumns =
    "id, fee_type, season_id, tournament_id, club_event_id, amount_cents, paid_at, method, reference, created_at, " +
    "fee_submissions(id, status, reference, reject_reason, submitted_at)"

struct OwnFeeRow: Equatable, Sendable {
    var id: String
    var feeType: String
    var seasonId: String? = nil
    var tournamentId: String? = nil
    var clubEventId: String? = nil
    var amountCents: Int? = nil
    var paidAt: String? = nil
    var method: String? = nil
    var reference: String? = nil
    var createdAt: String = ""
    var feeSubmissions: [OwnFeeSubmission]? = nil
}

struct OwnFeeSubmission: Equatable, Sendable {
    var id: String = ""
    var status: String = ""
    var submittedAt: String = ""
}

extension OwnFeeSubmission {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.optString("id") ?? ""
        status = try row.optString("status") ?? ""
        submittedAt = try row.optString("submitted_at") ?? ""
    }
}

/// The most recent receipt sent for a fee, or nil.
func latestSubmission(_ row: OwnFeeRow?) -> OwnFeeSubmission? {
    (row?.feeSubmissions ?? []).enumerated()
        .sorted { a, b in a.element.submittedAt == b.element.submittedAt ? a.offset < b.offset : a.element.submittedAt > b.element.submittedAt }
        .first?.element
}

/// Port of toPayableLines in apps/player/src/lib/member-fees.ts: the rows as
/// payable lines, dues from other seasons left out, plus this season's dues at
/// the member's price when there is no dues row yet.
func toPayableLines(_ rows: [OwnFeeRow], season: StatementSeason?, status: String?) -> [PayableFeeLine] {
    var lines = rows
        .filter { $0.feeType != "dues" || (season != nil && $0.seasonId == season?.id) }
        .map { PayableFeeLine(feeType: $0.feeType, paidAt: $0.paidAt, amountCents: $0.amountCents, pending: latestSubmission($0)?.status == "submitted") }
    if let season, !rows.contains(where: { $0.feeType == "dues" && $0.seasonId == season.id }) {
        lines.append(PayableFeeLine(feeType: "dues", paidAt: nil, amountCents: seasonFeeFor(status, season), pending: false))
    }
    return lines
}

extension OwnFeeRow {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        feeType = try row.reqString("fee_type")
        seasonId = try row.optString("season_id")
        tournamentId = try row.optString("tournament_id")
        clubEventId = try row.optString("club_event_id")
        amountCents = try row.optInt("amount_cents")
        paidAt = try row.optString("paid_at")
        method = try row.optString("method")
        reference = try row.optString("reference")
        createdAt = try row.optString("created_at") ?? ""
        feeSubmissions = try row.optValue("fee_submissions")?.arrayValue?.map(OwnFeeSubmission.init(json:))
    }
}

struct StatementSeason: Equatable, Sendable {
    var id: String
    var name: String
    var endDate: String? = nil
    var competitiveFeeCents: Int
    var recreationalFeeCents: Int
}

extension StatementSeason {
    init(json: JSONValue) throws {
        let row = try json.object()
        id = try row.reqString("id")
        name = try row.reqString("name")
        endDate = try row.optString("end_date")
        competitiveFeeCents = try row.reqInt("competitive_fee_cents")
        recreationalFeeCents = try row.reqInt("recreational_fee_cents")
    }
}

struct StatementPlayer: Equatable, Sendable {
    var status: String?
    var isExec: Bool?
    var feeExempt: Bool?
}

/// Competitive pays the competitive price, everybody else the recreational one.
func seasonFeeFor(_ status: String?, _ season: StatementSeason) -> Int {
    status == "competitive" ? season.competitiveFeeCents : season.recreationalFeeCents
}

func isExempt(_ player: StatementPlayer) -> Bool { player.isExec == true || player.feeExempt == true }

struct StatementLines: Equatable, Sendable {
    let lines: [FeeLine]
    let seasonLine: FeeLine?
}

/// localeCompare's order: "alpha" before "Beta", which a plain comparison gets
/// wrong. Stable, as Kotlin's sortedWith is.
private func byName(_ lines: [FeeLine]) -> [FeeLine] {
    let english = Locale(identifier: "en")
    return lines.enumerated()
        .sorted { a, b in
            let order = a.element.name.compare(b.element.name, options: [], range: nil, locale: english)
            return order == .orderedSame ? a.offset < b.offset : order == .orderedAscending
        }
        .map(\.element)
}

/// Every line of the statement, in the web's order: this season's dues, then
/// tournament entries and club events by name, then reinstatements. A member
/// with no dues row still owes the season's price, keyed on the season; an
/// exempt member gets no dues line at all.
func buildStatementLines(
    player: StatementPlayer,
    season: StatementSeason?,
    feeRows: [OwnFeeRow],
    tournamentNames: [String: String],
    eventNames: [String: String],
) -> StatementLines {
    var lines: [FeeLine] = []
    var seasonLine: FeeLine?

    if let season, !isExempt(player) {
        let clubFee = feeRows.first { $0.feeType == "dues" && $0.seasonId == season.id }
        let settlement = settlementOf(clubFee?.paidAt, clubFee?.method)
        let owed: Int? = clubFee?.paidAt != nil ? clubFee?.amountCents : (clubFee?.amountCents ?? seasonFeeFor(player.status, season))
        let line = FeeLine(
            key: clubFee?.id ?? "season-\(season.id)",
            kind: .season,
            name: "\(season.name) membership",
            owedCents: owed,
            recordedCents: clubFee?.amountCents,
            paid: settlement.paid,
            waived: settlement.waived,
            paidAt: clubFee?.paidAt,
            method: clubFee?.method,
            reference: clubFee?.reference,
        )
        seasonLine = line
        lines.append(line)
    }

    func fromRow(_ fee: OwnFeeRow, _ kind: FeeKind, _ name: String) -> FeeLine {
        let settlement = settlementOf(fee.paidAt, fee.method)
        return FeeLine(
            key: fee.id,
            kind: kind,
            name: name,
            owedCents: fee.amountCents,
            recordedCents: fee.amountCents,
            paid: settlement.paid,
            waived: settlement.waived,
            paidAt: fee.paidAt,
            method: fee.method,
            reference: fee.reference,
        )
    }

    lines += byName(feeRows
        .filter { $0.feeType == "tournament" && !($0.tournamentId ?? "").isEmpty }
        .map { fromRow($0, .tournament, tournamentNames[$0.tournamentId ?? ""] ?? "Tournament entry") })
    lines += byName(feeRows
        .filter { $0.feeType == "event" && !($0.clubEventId ?? "").isEmpty }
        .map { fromRow($0, .event, eventNames[$0.clubEventId ?? ""] ?? "Club event") })
    lines += feeRows
        .filter { $0.feeType == "reinstatement" }
        .map { fromRow($0, .reinstatement, "Reinstatement fee") }

    return StatementLines(lines: lines, seasonLine: seasonLine)
}

struct Headline: Equatable, Sendable {
    let amount: String
    let label: String
}

/// The figure and the word beside it: the web's headlineAmount and headlineBadge.
func statementHeadline(_ s: OutstandingSummary) -> Headline { Headline(amount: headlineAmount(s), label: headlineBadge(s).label) }

struct Statement: Equatable, Sendable {
    let season: StatementSeason?
    let summary: OutstandingSummary
}

/// The screen's statement from the reads. Pure, so the debug preview runs the same rules.
func buildStatement(viewer: Viewer, season: StatementSeason?, feeRows: [OwnFeeRow], tournamentNames: [String: String], eventNames: [String: String]) -> Statement {
    let player = StatementPlayer(status: viewer.status, isExec: viewer.isExec, feeExempt: viewer.feeExempt)
    let built = buildStatementLines(player: player, season: season, feeRows: feeRows, tournamentNames: tournamentNames, eventNames: eventNames)
    return Statement(season: season, summary: summariseFees(built.lines, exempt: isExempt(player)))
}

/// Distinct, in first-seen order, as Kotlin's distinct() keeps them.
private func distinct(_ values: [String]) -> [String] {
    var seen = Set<String>()
    return values.filter { seen.insert($0).inserted }
}

func loadStatement(_ postgrest: Postgrest, viewer: Viewer) async throws -> Statement {
    // RLS says "yours only" on club_fees as well as the explicit filter.
    async let feesRead = postgrest.list(
        PostgrestQuery.select("club_fees", ownFeeColumns)
            .eq("player_id", viewer.id)
            .order("created_at", ascending: false),
        what: "your fees",
        OwnFeeRow.init(json:),
    )
    async let activeRead = loadActiveSeason(postgrest)
    let feeRows = try await feesRead
    let activeId = try await activeRead?.id

    // get_active_season() has no end_date, which the statement's season needs.
    var season: StatementSeason?
    if let activeId {
        season = try await postgrest.maybeSingle(
            PostgrestQuery.select("seasons", "id, name, end_date, competitive_fee_cents, recreational_fee_cents").eq("id", activeId),
            what: "the season",
            StatementSeason.init(json:),
        )
    }

    let tournamentIds = distinct(feeRows.filter { $0.feeType == "tournament" }.compactMap(\.tournamentId))
    let eventIds = distinct(feeRows.filter { $0.feeType == "event" }.compactMap(\.clubEventId))
    async let tournamentsRead: [(String, String)] = tournamentIds.isEmpty ? [] : postgrest.list(
        PostgrestQuery.select("tournaments", "id, name").isIn("id", tournamentIds),
        what: "tournament names",
    ) { json in
        let row = try json.object()
        return (try row.reqString("id"), try row.optString("name") ?? "")
    }
    async let eventsRead: [(String, String)] = eventIds.isEmpty ? [] : postgrest.list(
        PostgrestQuery.select("club_events", "id, title").isIn("id", eventIds),
        what: "event names",
    ) { json in
        let row = try json.object()
        return (try row.reqString("id"), try row.optString("title") ?? "")
    }
    // associate: a repeated id keeps the last name.
    let tournamentNames = Dictionary(try await tournamentsRead, uniquingKeysWith: { _, last in last })
    let eventNames = Dictionary(try await eventsRead, uniquingKeysWith: { _, last in last })

    return buildStatement(viewer: viewer, season: season, feeRows: feeRows, tournamentNames: tournamentNames, eventNames: eventNames)
}
