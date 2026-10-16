package com.clubladder.app.shared

// Port of payableLines and paymentPrompt in
// packages/shared/src/utils/fee-reminders.ts. Keep in step with it.

data class PayableFeeLine(
    val feeType: String,
    val paidAt: String?,
    val amountCents: Long?,
    /** A receipt is in and waiting for an exec. */
    val pending: Boolean,
)

data class FeePayer(val isExec: Boolean, val feeExempt: Boolean)

/** Unpaid lines a member can pay by receipt. Execs and fee-exempt members have none. */
fun payableLines(lines: List<PayableFeeLine>, payer: FeePayer): List<PayableFeeLine> {
    if (payer.isExec || payer.feeExempt) return emptyList()
    return lines.filter { it.paidAt == null && it.feeType != "reinstatement" }
}

sealed class PaymentPrompt {
    object None : PaymentPrompt()
    data class Owing(val totalCents: Long, val unknownCount: Int, val count: Int) : PaymentPrompt()
    object Submitted : PaymentPrompt()
}

fun paymentPrompt(lines: List<PayableFeeLine>, payer: FeePayer): PaymentPrompt {
    val payable = payableLines(lines, payer)
    val awaiting = payable.filter { !it.pending }
    if (awaiting.isNotEmpty()) {
        return PaymentPrompt.Owing(
            totalCents = awaiting.sumOf { it.amountCents ?: 0L },
            unknownCount = awaiting.count { it.amountCents == null },
            count = awaiting.size,
        )
    }
    return if (payable.isNotEmpty()) PaymentPrompt.Submitted else PaymentPrompt.None
}
