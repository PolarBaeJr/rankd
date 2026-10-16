import XCTest
@testable import ClubLadder

// Port of FeeRemindersTest.kt (the payableLines and paymentPrompt blocks of fee-reminders.test.ts).
final class FeeRemindersTests: XCTestCase {
    private let member = FeePayer(isExec: false, feeExempt: false)

    private func line(_ feeType: String = "dues", paidAt: String? = nil, amountCents: Int? = 2000, pending: Bool = false) -> PayableFeeLine {
        PayableFeeLine(feeType: feeType, paidAt: paidAt, amountCents: amountCents, pending: pending)
    }

    func test_keepsUnpaidDuesEventAndTournamentLines() {
        XCTAssertEqual(3, payableLines([line(), line("event", amountCents: 1500), line("tournament")], member).count)
    }

    func test_dropsPaidLinesAndReinstatements() {
        XCTAssertTrue(payableLines([line(paidAt: "2026-09-01T00:00:00Z")], member).isEmpty)
        XCTAssertTrue(payableLines([line("reinstatement")], member).isEmpty)
    }

    func test_givesExecsAndFeeExemptMembersNothing() {
        XCTAssertTrue(payableLines([line()], FeePayer(isExec: true, feeExempt: false)).isEmpty)
        XCTAssertTrue(payableLines([line()], FeePayer(isExec: false, feeExempt: true)).isEmpty)
    }

    func test_totalsTheLinesWithNoReceiptIn() {
        XCTAssertEqual(.owing(totalCents: 3500, unknownCount: 0, count: 2), paymentPrompt([line(), line("event", amountCents: 1500)], member))
        XCTAssertEqual(.owing(totalCents: 1500, unknownCount: 0, count: 1), paymentPrompt([line(pending: true), line("event", amountCents: 1500)], member))
    }

    func test_saysSubmittedOnceEveryPayableLineHasAReceiptWaiting() {
        XCTAssertEqual(.submitted, paymentPrompt([line(pending: true)], member))
    }

    func test_countsALineWithNoPriceRatherThanAddingZeroSilently() {
        XCTAssertEqual(.owing(totalCents: 0, unknownCount: 1, count: 1), paymentPrompt([line(amountCents: nil)], member))
    }

    func test_saysNothingWhenAllIsSettledOrExempt() {
        XCTAssertEqual(PaymentPrompt.none, paymentPrompt([line(paidAt: "2026-09-01T00:00:00Z")], member))
        XCTAssertEqual(PaymentPrompt.none, paymentPrompt([line()], FeePayer(isExec: true, feeExempt: false)))
    }
}
