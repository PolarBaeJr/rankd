package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors the payableLines and paymentPrompt blocks of
// packages/shared/src/utils/__tests__/fee-reminders.test.ts.
class FeeRemindersTest {
    private val member = FeePayer(isExec = false, feeExempt = false)

    private fun line(feeType: String = "dues", paidAt: String? = null, amountCents: Long? = 2000, pending: Boolean = false) =
        PayableFeeLine(feeType, paidAt, amountCents, pending)

    @Test
    fun `keeps unpaid dues, event and tournament lines`() {
        assertEquals(3, payableLines(listOf(line(), line("event", amountCents = 1500), line("tournament")), member).size)
    }

    @Test
    fun `drops paid lines and reinstatements`() {
        assertTrue(payableLines(listOf(line(paidAt = "2026-09-01T00:00:00Z")), member).isEmpty())
        assertTrue(payableLines(listOf(line("reinstatement")), member).isEmpty())
    }

    @Test
    fun `gives execs and fee-exempt members nothing`() {
        assertTrue(payableLines(listOf(line()), FeePayer(isExec = true, feeExempt = false)).isEmpty())
        assertTrue(payableLines(listOf(line()), FeePayer(isExec = false, feeExempt = true)).isEmpty())
    }

    @Test
    fun `totals the lines with no receipt in`() {
        assertEquals(PaymentPrompt.Owing(3500, 0, 2), paymentPrompt(listOf(line(), line("event", amountCents = 1500)), member))
        assertEquals(PaymentPrompt.Owing(1500, 0, 1), paymentPrompt(listOf(line(pending = true), line("event", amountCents = 1500)), member))
    }

    @Test
    fun `says submitted once every payable line has a receipt waiting`() {
        assertEquals(PaymentPrompt.Submitted, paymentPrompt(listOf(line(pending = true)), member))
    }

    @Test
    fun `counts a line with no price rather than adding zero silently`() {
        assertEquals(1, (paymentPrompt(listOf(line(amountCents = null)), member) as PaymentPrompt.Owing).unknownCount)
    }

    @Test
    fun `says nothing when all is settled or exempt`() {
        assertEquals(PaymentPrompt.None, paymentPrompt(listOf(line(paidAt = "2026-09-01T00:00:00Z")), member))
        assertEquals(PaymentPrompt.None, paymentPrompt(listOf(line()), FeePayer(isExec = true, feeExempt = false)))
    }
}
