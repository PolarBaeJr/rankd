package com.clubladder.app.shared

// Port of the statement half of apps/player/src/lib/fees.ts: money,
// settlementOf, summariseFees, headlineAmount and headlineBadge. Keep in step
// with it; the reasoning behind the four statuses and the exemption rule is
// written up there.

/**
 * A price, or "TBD" when nothing records one. Integer arithmetic, never
 * String.format: a French-Canadian phone would print "40,00".
 */
fun money(cents: Long?): String {
    if (cents == null) return "TBD"
    val sign = if (cents < 0) "-" else ""
    val abs = if (cents < 0) -cents else cents
    return "$" + sign + (abs / 100) + "." + (abs % 100).toString().padStart(2, '0')
}

/** Which kind of fee a line came from. Drives the wording, not the arithmetic. */
enum class FeeKind { SEASON, TOURNAMENT, REINSTATEMENT, EVENT }

data class FeeLine(
    val key: String,
    val kind: FeeKind,
    val name: String,
    /** Cents owed; a season with no row yet owes its list price. Null when unpriced. */
    val owedCents: Long?,
    /** The row's own amount, never a fallback. What a receipt prints. */
    val recordedCents: Long?,
    val paid: Boolean,
    val waived: Boolean,
    val paidAt: String?,
    val method: String?,
    val reference: String?,
)

data class Settlement(val paid: Boolean, val waived: Boolean)

fun settlementOf(paidAt: String?, method: String?): Settlement {
    val settled = paidAt != null
    val waived = settled && isReservedMethod(method)
    return Settlement(paid = settled && !waived, waived = waived)
}

fun isSettled(line: FeeLine): Boolean = line.paid || line.waived

enum class FeeStatus { EXEMPT, NOTHING_DUE, ALL_PAID, OWING }

data class OutstandingSummary(
    val status: FeeStatus,
    /** Sum of the KNOWN amounts still owed. */
    val totalCents: Long,
    /** Unsettled lines with no price: non-zero means totalCents is a floor. */
    val unknownCount: Int,
    val outstanding: List<FeeLine>,
    /** Settled lines, newest payment first. */
    val receipts: List<FeeLine>,
)

fun summariseFees(lines: List<FeeLine>, exempt: Boolean): OutstandingSummary {
    val receipts = lines.filter(::isSettled).sortedWith { a, b -> (b.paidAt ?: "").compareTo(a.paidAt ?: "") }

    // Exemption is from dues only: a reinstatement is the price of lifting a ban.
    val chargeable = if (exempt) lines.filter { it.kind == FeeKind.REINSTATEMENT } else lines

    val outstanding = chargeable.filter { !isSettled(it) }
    val totalCents = outstanding.sumOf { it.owedCents ?: 0L }
    val unknownCount = outstanding.count { it.owedCents == null }

    val status = when {
        outstanding.isNotEmpty() -> FeeStatus.OWING
        exempt -> FeeStatus.EXEMPT
        lines.isNotEmpty() -> FeeStatus.ALL_PAID
        else -> FeeStatus.NOTHING_DUE
    }

    return OutstandingSummary(status, totalCents, unknownCount, outstanding, receipts)
}

fun headlineAmount(s: OutstandingSummary): String {
    if (s.status == FeeStatus.EXEMPT || s.status == FeeStatus.NOTHING_DUE) return "$0.00"
    if (s.totalCents == 0L && s.unknownCount > 0) return money(null)
    return money(s.totalCents)
}

enum class BadgeTone { SUCCESS, WARNING, NEUTRAL }

data class HeadlineBadge(val tone: BadgeTone, val label: String)

fun headlineBadge(s: OutstandingSummary): HeadlineBadge = when (s.status) {
    FeeStatus.EXEMPT -> HeadlineBadge(BadgeTone.NEUTRAL, "NOT CHARGED")
    FeeStatus.NOTHING_DUE -> HeadlineBadge(BadgeTone.NEUTRAL, "NOTHING DUE")
    FeeStatus.ALL_PAID -> HeadlineBadge(BadgeTone.SUCCESS, "ALL PAID")
    FeeStatus.OWING -> HeadlineBadge(BadgeTone.WARNING, "UNPAID")
}
