import Foundation

// Port of the statement half of apps/player/src/lib/fees.ts, via
// FeeStatement.kt: money, settlementOf, summariseFees, headlineAmount and
// headlineBadge. Keep in step with it; the reasoning behind the four statuses
// and the exemption rule is written up there.

/// A price, or "TBD" when nothing records one. Integer arithmetic, never
/// String(format:): a French-Canadian phone would print "40,00".
func money(_ cents: Int?) -> String {
    guard let cents else { return "TBD" }
    let sign = cents < 0 ? "-" : ""
    let abs = cents < 0 ? -cents : cents
    let fraction = String(abs % 100)
    return "$" + sign + String(abs / 100) + "." + (fraction.count < 2 ? "0" + fraction : fraction)
}

/// Which kind of fee a line came from. Drives the wording, not the arithmetic.
enum FeeKind: Sendable {
    case season, tournament, reinstatement, event
}

struct FeeLine: Equatable, Sendable {
    var key: String
    var kind: FeeKind
    var name: String
    /// Cents owed; a season with no row yet owes its list price. Nil when unpriced.
    var owedCents: Int?
    /// The row's own amount, never a fallback. What a receipt prints.
    var recordedCents: Int?
    var paid: Bool
    var waived: Bool
    var paidAt: String?
    var method: String?
    var reference: String?
}

struct Settlement: Equatable, Sendable {
    let paid: Bool
    let waived: Bool
}

func settlementOf(_ paidAt: String?, _ method: String?) -> Settlement {
    let settled = paidAt != nil
    let waived = settled && isReservedMethod(method)
    return Settlement(paid: settled && !waived, waived: waived)
}

func isSettled(_ line: FeeLine) -> Bool { line.paid || line.waived }

enum FeeStatus: Sendable {
    case exempt, nothingDue, allPaid, owing
}

struct OutstandingSummary: Equatable, Sendable {
    let status: FeeStatus
    /// Sum of the KNOWN amounts still owed.
    let totalCents: Int
    /// Unsettled lines with no price: non-zero means totalCents is a floor.
    let unknownCount: Int
    let outstanding: [FeeLine]
    /// Settled lines, newest payment first.
    let receipts: [FeeLine]
}

func summariseFees(_ lines: [FeeLine], exempt: Bool) -> OutstandingSummary {
    // Stable, newest payment first, as Kotlin's sortedWith is.
    let receipts = lines.filter(isSettled).enumerated()
        .sorted { a, b in
            let pa = a.element.paidAt ?? ""
            let pb = b.element.paidAt ?? ""
            return pa != pb ? pa > pb : a.offset < b.offset
        }
        .map(\.element)

    // Exemption is from dues only: a reinstatement is the price of lifting a ban.
    let chargeable = exempt ? lines.filter { $0.kind == .reinstatement } : lines

    let outstanding = chargeable.filter { !isSettled($0) }
    let totalCents = outstanding.reduce(0) { $0 + ($1.owedCents ?? 0) }
    let unknownCount = outstanding.filter { $0.owedCents == nil }.count

    let status: FeeStatus
    if !outstanding.isEmpty {
        status = .owing
    } else if exempt {
        status = .exempt
    } else if !lines.isEmpty {
        status = .allPaid
    } else {
        status = .nothingDue
    }

    return OutstandingSummary(status: status, totalCents: totalCents, unknownCount: unknownCount, outstanding: outstanding, receipts: receipts)
}

func headlineAmount(_ s: OutstandingSummary) -> String {
    if s.status == .exempt || s.status == .nothingDue { return "$0.00" }
    if s.totalCents == 0 && s.unknownCount > 0 { return money(nil) }
    return money(s.totalCents)
}

enum BadgeTone: Sendable {
    case success, warning, neutral
}

struct HeadlineBadge: Equatable, Sendable {
    let tone: BadgeTone
    let label: String
}

func headlineBadge(_ s: OutstandingSummary) -> HeadlineBadge {
    switch s.status {
    case .exempt: return HeadlineBadge(tone: .neutral, label: "NOT CHARGED")
    case .nothingDue: return HeadlineBadge(tone: .neutral, label: "NOTHING DUE")
    case .allPaid: return HeadlineBadge(tone: .success, label: "ALL PAID")
    case .owing: return HeadlineBadge(tone: .warning, label: "UNPAID")
    }
}
