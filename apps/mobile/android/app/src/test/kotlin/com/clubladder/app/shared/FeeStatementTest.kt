package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

// Mirrors the money, settlementOf, summariseFees and headline cases of
// apps/player/src/lib/__tests__/fees.test.ts.
class FeeStatementTest {
    private fun line(
        key: String = "k",
        kind: FeeKind = FeeKind.SEASON,
        name: String = "Term membership",
        owedCents: Long? = 4000,
        recordedCents: Long? = 4000,
        paid: Boolean = false,
        waived: Boolean = false,
        paidAt: String? = null,
        method: String? = null,
    ) = FeeLine(key, kind, name, owedCents, recordedCents, paid, waived, paidAt, method, null)

    @Test
    fun `money says TBD rather than zero when no price is recorded`() {
        assertEquals("TBD", money(null))
        assertEquals("$0.00", money(0))
        assertEquals("$40.00", money(4000))
        assertEquals("$0.05", money(5))
    }

    @Test
    fun `money matches toFixed for a negative amount`() {
        assertEquals("$-1.50", money(-150))
    }

    // String.format would write "40,00" on a French-Canadian phone.
    @Test
    fun `money ignores the phone's locale`() {
        val previous = Locale.getDefault()
        try {
            Locale.setDefault(Locale.CANADA_FRENCH)
            assertEquals("$1234.50", money(123450))
        } finally {
            Locale.setDefault(previous)
        }
    }

    @Test
    fun `isReservedMethod trims and ignores case`() {
        assertTrue(isReservedMethod(" Waived "))
        assertFalse(isReservedMethod("e_transfer"))
        assertFalse(isReservedMethod(null))
    }

    @Test
    fun `treats an unpaid row as neither paid nor waived`() {
        assertEquals(Settlement(paid = false, waived = false), settlementOf(null, null))
    }

    @Test
    fun `treats a paid row with no method as paid`() {
        assertEquals(Settlement(paid = true, waived = false), settlementOf("2026-01-08T20:00:00Z", null))
    }

    @Test
    fun `reads the reserved method as waived, not paid`() {
        assertEquals(Settlement(paid = false, waived = true), settlementOf("2026-01-08T20:00:00Z", "waived"))
    }

    @Test
    fun `matches the reserved method case-insensitively`() {
        assertTrue(settlementOf("2026-01-08T20:00:00Z", " Waived ").waived)
    }

    @Test
    fun `does not call a row waived just because the method says so with no paid_at`() {
        assertEquals(Settlement(paid = false, waived = false), settlementOf(null, "waived"))
    }

    @Test
    fun `a brand-new member owes the season fee and has no receipts`() {
        val s = summariseFees(listOf(line()), exempt = false)
        assertEquals(FeeStatus.OWING, s.status)
        assertEquals(4000L, s.totalCents)
        assertEquals(0, s.unknownCount)
        assertEquals(emptyList<FeeLine>(), s.receipts)
        assertEquals("$40.00", headlineAmount(s))
        assertEquals(HeadlineBadge(BadgeTone.WARNING, "UNPAID"), headlineBadge(s))
    }

    @Test
    fun `is all-paid only when something was actually billed and settled`() {
        val s = summariseFees(listOf(line(paid = true, paidAt = "2026-01-08T20:00:00Z")), exempt = false)
        assertEquals(FeeStatus.ALL_PAID, s.status)
        assertEquals(BadgeTone.SUCCESS, headlineBadge(s).tone)
        assertEquals(1, s.receipts.size)
    }

    @Test
    fun `a waived fee settles the line without being called paid`() {
        val s = summariseFees(
            listOf(line(waived = true, owedCents = 0, paidAt = "2026-01-08T20:00:00Z", method = "waived")),
            exempt = false,
        )
        assertEquals(FeeStatus.ALL_PAID, s.status)
        assertTrue(s.outstanding.isEmpty())
        assertEquals(1, s.receipts.size)
    }

    @Test
    fun `distinguishes never-billed from paid-in-full`() {
        assertEquals("NOTHING DUE", headlineBadge(summariseFees(emptyList(), exempt = false)).label)
        assertEquals("NOT CHARGED", headlineBadge(summariseFees(listOf(line()), exempt = true)).label)
        assertEquals(
            "ALL PAID",
            headlineBadge(summariseFees(listOf(line(paid = true, paidAt = "2026-01-08T20:00:00Z")), exempt = false)).label,
        )
    }

    @Test
    fun `keeps an exempt member's earlier receipts`() {
        val s = summariseFees(listOf(line(paid = true, paidAt = "2026-01-08T20:00:00Z"), line(key = "b")), exempt = true)
        assertEquals(FeeStatus.EXEMPT, s.status)
        assertEquals(0L, s.totalCents)
        assertTrue(s.outstanding.isEmpty())
        assertEquals(1, s.receipts.size)
    }

    @Test
    fun `still charges an exempt member for a reinstatement`() {
        val s = summariseFees(
            listOf(
                line(key = "dues"),
                line(key = "ban", kind = FeeKind.REINSTATEMENT, name = "Reinstatement fee", owedCents = 2000),
            ),
            exempt = true,
        )
        assertEquals(FeeStatus.OWING, s.status)
        assertEquals(2000L, s.totalCents)
        assertEquals(listOf("ban"), s.outstanding.map { it.key })
    }

    @Test
    fun `reads as exempt once that reinstatement is settled`() {
        val s = summariseFees(
            listOf(
                line(key = "dues"),
                line(key = "ban", kind = FeeKind.REINSTATEMENT, owedCents = 2000, paid = true, paidAt = "2026-02-01T20:00:00Z"),
            ),
            exempt = true,
        )
        assertEquals(FeeStatus.EXEMPT, s.status)
        assertTrue(s.outstanding.isEmpty())
    }

    @Test
    fun `counts a priceless outstanding line instead of summing it as zero`() {
        val s = summariseFees(
            listOf(line(owedCents = 4000), line(key = "b", kind = FeeKind.TOURNAMENT, owedCents = null)),
            exempt = false,
        )
        assertEquals(4000L, s.totalCents)
        assertEquals(1, s.unknownCount)
        assertEquals("$40.00", headlineAmount(s))
    }

    @Test
    fun `keeps a receipt's recorded amount separate from a derived price`() {
        val s = summariseFees(
            listOf(
                line(
                    kind = FeeKind.TOURNAMENT,
                    owedCents = 1500,
                    recordedCents = null,
                    paid = true,
                    paidAt = "2026-02-01T20:00:00Z",
                ),
            ),
            exempt = false,
        )
        assertEquals("TBD", money(s.receipts[0].recordedCents))
        assertEquals("$15.00", money(s.receipts[0].owedCents))
    }

    @Test
    fun `shows TBD when the only thing outstanding has no recorded price`() {
        val s = summariseFees(listOf(line(kind = FeeKind.TOURNAMENT, owedCents = null)), exempt = false)
        assertEquals(0L, s.totalCents)
        assertEquals(1, s.unknownCount)
        assertEquals("TBD", headlineAmount(s))
    }

    @Test
    fun `orders receipts newest payment first`() {
        val s = summariseFees(
            listOf(
                line(key = "old", paid = true, paidAt = "2026-01-08T20:00:00Z"),
                line(key = "new", paid = true, paidAt = "2026-03-02T20:00:00Z"),
            ),
            exempt = false,
        )
        assertEquals(listOf("new", "old"), s.receipts.map { it.key })
    }
}
