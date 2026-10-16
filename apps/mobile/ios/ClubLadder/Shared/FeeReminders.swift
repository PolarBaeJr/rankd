import Foundation

// Port of FeeReminders.kt: payableLines and paymentPrompt in
// packages/shared/src/utils/fee-reminders.ts. Keep in step with it.

struct PayableFeeLine: Equatable, Sendable {
    let feeType: String
    let paidAt: String?
    let amountCents: Int?
    /// A receipt is in and waiting for an exec.
    let pending: Bool
}

struct FeePayer: Equatable, Sendable {
    let isExec: Bool
    let feeExempt: Bool
}

/// Unpaid lines a member can pay by receipt. Execs and fee-exempt members have none.
func payableLines(_ lines: [PayableFeeLine], _ payer: FeePayer) -> [PayableFeeLine] {
    if payer.isExec || payer.feeExempt { return [] }
    return lines.filter { $0.paidAt == nil && $0.feeType != "reinstatement" }
}

enum PaymentPrompt: Equatable, Sendable {
    case none
    case owing(totalCents: Int, unknownCount: Int, count: Int)
    case submitted
}

func paymentPrompt(_ lines: [PayableFeeLine], _ payer: FeePayer) -> PaymentPrompt {
    let payable = payableLines(lines, payer)
    let awaiting = payable.filter { !$0.pending }
    if !awaiting.isEmpty {
        return .owing(
            totalCents: awaiting.reduce(0) { $0 + ($1.amountCents ?? 0) },
            unknownCount: awaiting.filter { $0.amountCents == nil }.count,
            count: awaiting.count,
        )
    }
    return payable.isEmpty ? .none : .submitted
}
