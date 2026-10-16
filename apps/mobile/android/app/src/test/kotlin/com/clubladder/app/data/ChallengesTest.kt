package com.clubladder.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class ChallengesTest {
    private fun rows(json: String): List<ChallengeListItem> =
        toListItems(postgrestJson.decodeFromString(kotlinx.serialization.builtins.ListSerializer(MyChallengeRow.serializer()), json))

    private fun row(id: String, status: String, createdBy: String, confirmation: String, createdAt: String, type: String = "singles") =
        """{"id":"r$id","confirmation_status":"$confirmation","challenge":{"id":"$id","created_by":"$createdBy",""" +
            """"type":"$type","format":"bo3_21","rated_flag":true,"status":"$status","created_at":"$createdAt"}}"""

    @Test
    fun `reads the list with the web page's select`() {
        assertEquals(
            "/rest/v1/challenge_participants?select=id%2Cconfirmation_status%2Cchallenge%3Achallenges%28id%2Ccreated_by%2C" +
                "type%2Cformat%2Crated_flag%2Cstatus%2Ccreated_at%2Cexpires_at%2Cscheduled_date%2Cscheduled_time%2C" +
                "creator%3Aplayers%21challenges_created_by_fkey%28id%2Cfull_name%2Chandle%2Cavatar_url%29%2C" +
                "challenge_participants%28id%2Cplayer_id%2Crole%2Cteam_side%2Cplayer%3Aplayers%28id%2Cfull_name%2Chandle%29%29%29" +
                "&player_id=eq.p1&limit=200",
            myChallengesQuery("p1").pathAndQuery(),
        )
    }

    @Test
    fun `reads one challenge and its match by id`() {
        assertEquals(true, challengeDetailQuery("c1").pathAndQuery().startsWith("/rest/v1/challenges?select=id%2Ctype%2Cformat%2Cgames_per_match"))
        assertEquals(true, challengeDetailQuery("c1").pathAndQuery().endsWith("&id=eq.c1"))
        assertEquals(
            "/rest/v1/matches?select=id%2Cresult_status%2Cscore_summary%2Csubmitted_by%2Cmatch_participants%28id%2C" +
                "rating_delta%2Cplayer%3Aplayers%28full_name%29%29%2Cmatch_games%28id%2Cgame_number%2Cside_a_score%2C" +
                "side_b_score%29&challenge_id=eq.c1",
            matchForChallengeQuery("c1").pathAndQuery(),
        )
    }

    @Test
    fun `reads to-one embeds as an object or a one-row array, newest first`() {
        val items = rows(
            """[
            {"id":"r1","confirmation_status":"accepted","challenge":{"id":"c1","created_by":"me","status":"accepted",
              "created_at":"2026-09-01T10:00:00+00:00","creator":{"id":"me","full_name":"Member One"},
              "challenge_participants":[{"id":"x","player_id":"me","team_side":"a","player":[{"id":"me","full_name":"Member One"}]}]}},
            {"id":"r2","confirmation_status":"pending","challenge":[{"id":"c2","created_by":"them","status":"proposed",
              "created_at":"2026-09-02T10:00:00+00:00","creator":[{"id":"them","full_name":"Member Two"}]}]},
            {"id":"r3","confirmation_status":"pending","challenge":null}
            ]""",
        )
        assertEquals(listOf("c2", "c1"), items.map { it.challenge.id })
        assertEquals("Member Two", items[0].challenge.creatorPerson?.fullName)
        assertEquals("Member One", items[1].challenge.creatorPerson?.fullName)
        assertEquals("Member One", items[1].challenge.participants[0].person?.fullName)
    }

    @Test
    fun `partitions as the web does`() {
        val items = rows(
            "[" + listOf(
                row("in", "proposed", "them", "pending", "2026-09-05T00:00:00Z"),
                row("partial", "partially_confirmed", "them", "pending", "2026-09-04T00:00:00Z"),
                row("mine", "proposed", "me", "accepted", "2026-09-03T00:00:00Z"),
                row("acc", "accepted", "me", "accepted", "2026-09-02T00:00:00Z"),
                row("exp", "expired", "them", "pending", "2026-09-01T00:00:00Z"),
            ).joinToString(",") + "]",
        )
        val parts = partitionChallenges(items, "me")
        assertEquals(listOf("in", "partial"), parts.incoming.map { it.challenge.id })
        assertEquals(listOf("partial", "acc"), parts.active.map { it.challenge.id })
        assertEquals(listOf("mine", "acc"), parts.outgoing.map { it.challenge.id })
        assertEquals(listOf("exp"), parts.archived.map { it.challenge.id })
    }

    @Test
    fun `archive lists singles first, newest first within each`() {
        val items = rows(
            "[" + listOf(
                row("d-new", "completed", "me", "accepted", "2026-09-05T00:00:00Z", "doubles"),
                row("s-old", "rejected", "me", "accepted", "2026-09-01T00:00:00Z"),
                row("s-new", "cancelled", "me", "accepted", "2026-09-04T00:00:00Z"),
            ).joinToString(",") + "]",
        )
        assertEquals(listOf("s-new", "s-old", "d-new"), sortArchived(items).map { it.challenge.id })
    }

    private val now = Instant.parse("2026-09-27T12:00:00Z").toEpochMilli()
    private fun inMinutes(m: Long) = Instant.ofEpochMilli(now + m * 60_000L).toString()

    @Test
    fun `labels the reply window`() {
        assertEquals(ExpiryState(ExpiryKind.URGENT, 0, "59m left"), expiryState(inMinutes(59), "proposed", now))
        assertEquals(ExpiryState(ExpiryKind.URGENT, 11, "11h left"), expiryState(inMinutes(11 * 60 + 30), "proposed", now))
        assertEquals(ExpiryState(ExpiryKind.OPEN, 47, "47h left"), expiryState(inMinutes(47 * 60), "partially_confirmed", now))
        assertEquals(ExpiryState(ExpiryKind.OPEN, 72, "3d left"), expiryState(inMinutes(72 * 60), "proposed", now))
        assertEquals("Expired", expiryState(inMinutes(-5), "proposed", now).label)
        assertNull(expiryState(inMinutes(60), "accepted", now).label)
        assertNull(expiryState(null, "proposed", now).label)
    }

    @Test
    fun `says how long ago, then the club date`() {
        assertEquals("just now", formatRelativeTime(inMinutes(0), now))
        assertEquals("5m ago", formatRelativeTime(inMinutes(-5), now))
        assertEquals("3h ago", formatRelativeTime(inMinutes(-180), now))
        assertEquals("2d ago", formatRelativeTime(inMinutes(-2 * 24 * 60), now))
        assertEquals("Sep 1, 2026", formatRelativeTime("2026-09-01T18:00:00Z", now))
    }

    @Test
    fun `names the shape a challenge was made with`() {
        assertEquals("Best of 3 to 15", shapeLabel("bo3_21", 3, 15))
        assertEquals("1 Game to 11", shapeLabel("single_21", 1, 11))
        assertEquals("Best of 3 to 21", shapeLabel("bo3_21", null, null))
        assertEquals("custom", shapeLabel("custom", null, 21))
    }

    @Test
    fun `only the creator and the roster may see a challenge`() {
        val c = ChallengeDetail(id = "c1", createdBy = "me", participants = listOf(ChallengeParticipant(playerId = "them")))
        assertEquals(true, viewerMaySeeChallenge(c, "me"))
        assertEquals(true, viewerMaySeeChallenge(c, "them"))
        assertEquals(false, viewerMaySeeChallenge(c, "else"))
        assertEquals(false, viewerMaySeeChallenge(c, ""))
        assertEquals(false, viewerMaySeeChallenge(null, "me"))
    }
}
