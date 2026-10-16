import XCTest
@testable import ClubLadder

// Port of FeeStatementTest.kt (the money, settlementOf, summariseFees and
// headline cases of apps/player/src/lib/__tests__/fees.test.ts).
final class FeeStatementTests: XCTestCase {
    private func line(
        key: String = "k",
        kind: FeeKind = .season,
        name: String = "Term membership",
        owedCents: Int? = 4000,
        recordedCents: Int? = 4000,
        paid: Bool = false,
        waived: Bool = false,
        paidAt: String? = nil,
        method: String? = nil,
    ) -> FeeLine {
        FeeLine(key: key, kind: kind, name: name, owedCents: owedCents, recordedCents: recordedCents, paid: paid, waived: waived, paidAt: paidAt, method: method, reference: nil)
    }

    func test_moneySaysTbdRatherThanZeroWhenNoPriceIsRecorded() {
        XCTAssertEqual("TBD", money(nil))
        XCTAssertEqual("$0.00", money(0))
        XCTAssertEqual("$40.00", money(4000))
        XCTAssertEqual("$0.05", money(5))
    }

    func test_moneyMatchesToFixedForANegativeAmount() {
        XCTAssertEqual("$-1.50", money(-150))
    }

    // Kotlin switches the JVM default to fr_CA; iOS cannot change the process
    // locale, and money() reads no locale at all, so the figure is pinned.
    func test_moneyIgnoresThePhonesLocale() {
        XCTAssertEqual("$1234.50", money(123450))
    }

    func test_isReservedMethodTrimsAndIgnoresCase() {
        XCTAssertTrue(isReservedMethod(" Waived "))
        XCTAssertFalse(isReservedMethod("e_transfer"))
        XCTAssertFalse(isReservedMethod(nil))
    }

    func test_treatsAnUnpaidRowAsNeitherPaidNorWaived() {
        XCTAssertEqual(Settlement(paid: false, waived: false), settlementOf(nil, nil))
    }

    func test_treatsAPaidRowWithNoMethodAsPaid() {
        XCTAssertEqual(Settlement(paid: true, waived: false), settlementOf("2026-01-08T20:00:00Z", nil))
    }

    func test_readsTheReservedMethodAsWaivedNotPaid() {
        XCTAssertEqual(Settlement(paid: false, waived: true), settlementOf("2026-01-08T20:00:00Z", "waived"))
    }

    func test_matchesTheReservedMethodCaseInsensitively() {
        XCTAssertTrue(settlementOf("2026-01-08T20:00:00Z", " Waived ").waived)
    }

    func test_doesNotCallARowWaivedJustBecauseTheMethodSaysSoWithNoPaidAt() {
        XCTAssertEqual(Settlement(paid: false, waived: false), settlementOf(nil, "waived"))
    }

    func test_aBrandNewMemberOwesTheSeasonFeeAndHasNoReceipts() {
        let s = summariseFees([line()], exempt: false)
        XCTAssertEqual(.owing, s.status)
        XCTAssertEqual(4000, s.totalCents)
        XCTAssertEqual(0, s.unknownCount)
        XCTAssertEqual([], s.receipts)
        XCTAssertEqual("$40.00", headlineAmount(s))
        XCTAssertEqual(HeadlineBadge(tone: .warning, label: "UNPAID"), headlineBadge(s))
    }

    func test_isAllPaidOnlyWhenSomethingWasActuallyBilledAndSettled() {
        let s = summariseFees([line(paid: true, paidAt: "2026-01-08T20:00:00Z")], exempt: false)
        XCTAssertEqual(.allPaid, s.status)
        XCTAssertEqual(.success, headlineBadge(s).tone)
        XCTAssertEqual(1, s.receipts.count)
    }

    func test_aWaivedFeeSettlesTheLineWithoutBeingCalledPaid() {
        let s = summariseFees([line(owedCents: 0, waived: true, paidAt: "2026-01-08T20:00:00Z", method: "waived")], exempt: false)
        XCTAssertEqual(.allPaid, s.status)
        XCTAssertTrue(s.outstanding.isEmpty)
        XCTAssertEqual(1, s.receipts.count)
    }

    func test_distinguishesNeverBilledFromPaidInFull() {
        XCTAssertEqual("NOTHING DUE", headlineBadge(summariseFees([], exempt: false)).label)
        XCTAssertEqual("NOT CHARGED", headlineBadge(summariseFees([line()], exempt: true)).label)
        XCTAssertEqual("ALL PAID", headlineBadge(summariseFees([line(paid: true, paidAt: "2026-01-08T20:00:00Z")], exempt: false)).label)
    }

    func test_keepsAnExemptMembersEarlierReceipts() {
        let s = summariseFees([line(paid: true, paidAt: "2026-01-08T20:00:00Z"), line(key: "b")], exempt: true)
        XCTAssertEqual(.exempt, s.status)
        XCTAssertEqual(0, s.totalCents)
        XCTAssertTrue(s.outstanding.isEmpty)
        XCTAssertEqual(1, s.receipts.count)
    }

    func test_stillChargesAnExemptMemberForAReinstatement() {
        let s = summariseFees(
            [
                line(key: "dues"),
                line(key: "ban", kind: .reinstatement, name: "Reinstatement fee", owedCents: 2000),
            ],
            exempt: true,
        )
        XCTAssertEqual(.owing, s.status)
        XCTAssertEqual(2000, s.totalCents)
        XCTAssertEqual(["ban"], s.outstanding.map(\.key))
    }

    func test_readsAsExemptOnceThatReinstatementIsSettled() {
        let s = summariseFees(
            [
                line(key: "dues"),
                line(key: "ban", kind: .reinstatement, owedCents: 2000, paid: true, paidAt: "2026-02-01T20:00:00Z"),
            ],
            exempt: true,
        )
        XCTAssertEqual(.exempt, s.status)
        XCTAssertTrue(s.outstanding.isEmpty)
    }

    func test_countsAPricelessOutstandingLineInsteadOfSummingItAsZero() {
        let s = summariseFees([line(owedCents: 4000), line(key: "b", kind: .tournament, owedCents: nil)], exempt: false)
        XCTAssertEqual(4000, s.totalCents)
        XCTAssertEqual(1, s.unknownCount)
        XCTAssertEqual("$40.00", headlineAmount(s))
    }

    func test_keepsAReceiptsRecordedAmountSeparateFromADerivedPrice() {
        let s = summariseFees(
            [line(kind: .tournament, owedCents: 1500, recordedCents: nil, paid: true, paidAt: "2026-02-01T20:00:00Z")],
            exempt: false,
        )
        XCTAssertEqual("TBD", money(s.receipts[0].recordedCents))
        XCTAssertEqual("$15.00", money(s.receipts[0].owedCents))
    }

    func test_showsTbdWhenTheOnlyThingOutstandingHasNoRecordedPrice() {
        let s = summariseFees([line(kind: .tournament, owedCents: nil)], exempt: false)
        XCTAssertEqual(0, s.totalCents)
        XCTAssertEqual(1, s.unknownCount)
        XCTAssertEqual("TBD", headlineAmount(s))
    }

    func test_ordersReceiptsNewestPaymentFirst() {
        let s = summariseFees(
            [
                line(key: "old", paid: true, paidAt: "2026-01-08T20:00:00Z"),
                line(key: "new", paid: true, paidAt: "2026-03-02T20:00:00Z"),
            ],
            exempt: false,
        )
        XCTAssertEqual(["new", "old"], s.receipts.map(\.key))
    }
}
