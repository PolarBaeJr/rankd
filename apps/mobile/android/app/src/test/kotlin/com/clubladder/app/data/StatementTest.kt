package com.clubladder.app.data

import com.clubladder.app.shared.FeeStatus
import com.clubladder.app.shared.summariseFees
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors the Expo app's src/__tests__/statement.test.ts.
class StatementTest {
    private val season = StatementSeason(
        id = "s1",
        name = "Fall 2026",
        endDate = "2026-12-10",
        competitiveFeeCents = 6000,
        recreationalFeeCents = 4000,
    )

    private fun fee(
        id: String = "f",
        feeType: String = "dues",
        seasonId: String? = null,
        tournamentId: String? = null,
        clubEventId: String? = null,
        amountCents: Long? = null,
        paidAt: String? = null,
        method: String? = null,
    ) = OwnFeeRow(id, feeType, seasonId, tournamentId, clubEventId, amountCents, paidAt, method, null, "2026-09-01T00:00:00Z")

    private val member = StatementPlayer(status = "competitive", isExec = false, feeExempt = false)

    private fun statement(
        player: StatementPlayer,
        rows: List<OwnFeeRow>,
        names: Map<String, String> = emptyMap(),
        eventNames: Map<String, String> = emptyMap(),
    ): Triple<StatementLines, com.clubladder.app.shared.OutstandingSummary, Headline> {
        val built = buildStatementLines(player, season, rows, names, eventNames)
        val summary = summariseFees(built.lines, isExempt(player))
        return Triple(built, summary, statementHeadline(summary))
    }

    @Test
    fun `a member with no dues row owes the season price for their status`() {
        val (built, summary, headline) = statement(member, emptyList())
        assertEquals("season-s1", built.seasonLine?.key)
        assertEquals(6000L, built.seasonLine?.owedCents)
        assertEquals(FeeStatus.OWING, summary.status)
        assertEquals(Headline("$60.00", "UNPAID"), headline)
    }

    @Test
    fun `a recreational member owes the recreational price`() {
        val (_, summary) = statement(member.copy(status = "recreational"), emptyList())
        assertEquals(4000L, summary.totalCents)
    }

    @Test
    fun `an exempt member gets no dues line and is not charged`() {
        val (built, summary, headline) = statement(member.copy(feeExempt = true), emptyList())
        assertNull(built.seasonLine)
        assertEquals(FeeStatus.EXEMPT, summary.status)
        assertEquals(Headline("$0.00", "NOT CHARGED"), headline)
    }

    @Test
    fun `an exec still owes a reinstatement, which is not a due`() {
        val (_, summary) = statement(member.copy(isExec = true), listOf(fee(id = "r", feeType = "reinstatement", amountCents = 2500)))
        assertEquals(FeeStatus.OWING, summary.status)
        assertEquals(2500L, summary.totalCents)
    }

    @Test
    fun `a waived dues row is settled, and its receipt says waived rather than paid`() {
        val rows = listOf(fee(id = "d", seasonId = "s1", amountCents = 0, paidAt = "2026-09-05T18:00:00Z", method = "Waived"))
        val (built, summary, headline) = statement(member, rows)
        assertTrue(built.seasonLine!!.waived)
        assertFalse(built.seasonLine.paid)
        assertEquals(FeeStatus.ALL_PAID, summary.status)
        assertEquals(listOf("d"), summary.receipts.map { it.key })
        assertEquals("ALL PAID", headline.label)
    }

    @Test
    fun `an entry with no recorded price makes the total unknown, not zero`() {
        val rows = listOf(
            fee(id = "d", seasonId = "s1", amountCents = 6000, paidAt = "2026-09-05T18:00:00Z", method = "e_transfer"),
            fee(id = "t", feeType = "tournament", tournamentId = "t1"),
        )
        val (built, summary, headline) = statement(member, rows, mapOf("t1" to "Fall Open"))
        assertEquals(listOf("Fall 2026 membership", "Fall Open"), built.lines.map { it.name })
        assertEquals(1, summary.unknownCount)
        assertEquals("TBD", headline.amount)
    }

    @Test
    fun `a tournament the member can no longer read keeps its fee under a generic name`() {
        val rows = listOf(fee(id = "t", feeType = "tournament", tournamentId = "gone", amountCents = 1500))
        val (built) = statement(member.copy(feeExempt = true), rows)
        assertEquals(listOf("Tournament entry"), built.lines.map { it.name })
    }

    @Test
    fun `no season and no rows is nothing due`() {
        val built = buildStatementLines(member, null, emptyList(), emptyMap(), emptyMap())
        assertTrue(built.lines.isEmpty())
        assertEquals(Headline("$0.00", "NOTHING DUE"), statementHeadline(summariseFees(built.lines, false)))
    }

    // localeCompare puts "alpha" before "Beta"; a plain compareTo puts every
    // capital first.
    @Test
    fun `orders entries by name the way localeCompare does`() {
        val rows = listOf(
            fee(id = "1", feeType = "tournament", tournamentId = "t1", amountCents = 100),
            fee(id = "2", feeType = "tournament", tournamentId = "t2", amountCents = 100),
            fee(id = "3", feeType = "event", clubEventId = "e1", amountCents = 100),
            fee(id = "4", feeType = "event", clubEventId = "e2", amountCents = 100),
        )
        val (built) = statement(
            member.copy(feeExempt = true),
            rows,
            mapOf("t1" to "Beta Cup", "t2" to "alpha Open"),
            mapOf("e1" to "Zumba night", "e2" to "banquet"),
        )
        assertEquals(listOf("alpha Open", "Beta Cup", "banquet", "Zumba night"), built.lines.map { it.name })
    }

    // toPayableLines, from apps/player/src/lib/member-fees.ts.
    @Test
    fun `drops dues from past seasons from the payable lines`() {
        val lines = toPayableLines(listOf(fee("old", seasonId = "s0", amountCents = 4000)), season, "recreational")
        assertEquals(listOf("dues" to 4000L), lines.map { it.feeType to it.amountCents })
    }

    @Test
    fun `adds this season's dues at the member's price when there is no row`() {
        assertEquals(6000L, toPayableLines(emptyList(), season, "competitive").single().amountCents)
        assertEquals(4000L, toPayableLines(emptyList(), season, "recreational").single().amountCents)
        assertTrue(toPayableLines(emptyList(), null, "competitive").isEmpty())
    }

    @Test
    fun `reads pending from the latest receipt only`() {
        val subs = listOf(
            OwnFeeSubmission("a", "rejected", "2026-09-02T00:00:00Z"),
            OwnFeeSubmission("b", "submitted", "2026-09-03T00:00:00Z"),
        )
        val row = fee("d", seasonId = "s1", amountCents = 4000).copy(feeSubmissions = subs)
        assertTrue(toPayableLines(listOf(row), season, "recreational").single().pending)
        val rejectedLast = row.copy(feeSubmissions = subs.reversed().map { if (it.id == "a") it.copy(submittedAt = "2026-09-04T00:00:00Z") else it })
        assertFalse(toPayableLines(listOf(rejectedLast), season, "recreational").single().pending)
        assertNull(latestSubmission(fee()))
    }
}
