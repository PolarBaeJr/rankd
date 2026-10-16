package com.clubladder.app.data

import com.clubladder.app.shared.GameScore
import org.junit.Assert.assertEquals
import org.junit.Test

class ChallengeActionsTest {
    private fun args(built: BuiltArgs): String = (built as BuiltArgs.Args).args.toString()
    private fun name(built: BuiltArgs): String = (built as BuiltArgs.Args).name
    private fun invalid(built: BuiltArgs): String = (built as BuiltArgs.Invalid).message

    private val form = NewChallengeForm(type = "singles", rated = true, games = "3", points = "21", opponentId = "p2")

    @Test
    fun `builds the web form's createChallenge input and leaves empty optionals out`() {
        val built = createChallengeArgs(form)
        assertEquals("createChallenge", name(built))
        assertEquals(
            """[{"type":"singles","rated_flag":true,"event_type":"rated_challenge","format":"bo3_21",""" +
                """"games_per_match":3,"points_per_game":21,"opponent_id":"p2"}]""",
            args(built),
        )
    }

    @Test
    fun `a casual one game challenge`() {
        val built = createChallengeArgs(form.copy(rated = false, games = "1", points = "15", note = "Tuesday?"))
        assertEquals(
            """[{"type":"singles","rated_flag":false,"event_type":"casual","format":"single_21",""" +
                """"games_per_match":1,"points_per_game":15,"opponent_id":"p2","note":"Tuesday?"}]""",
            args(built),
        )
    }

    @Test
    fun `sends partners only for doubles`() {
        val singles = createChallengeArgs(form.copy(partnerId = "p3", opponentPartnerId = "p4"))
        assertEquals(false, args(singles).contains("partner"))
        val doubles = createChallengeArgs(form.copy(type = "doubles", partnerId = "p3", opponentPartnerId = "p4"))
        assertEquals(true, args(doubles).contains(""""partner_id":"p3","opponent_partner_id":"p4""""))
        val half = createChallengeArgs(form.copy(type = "doubles", partnerId = "p3"))
        assertEquals(false, args(half).contains("opponent_partner_id"))
    }

    @Test
    fun `carries a schedule when one is set`() {
        val built = createChallengeArgs(form.copy(scheduledDate = "2026-10-01", scheduledTime = "18:30"))
        assertEquals(true, args(built).endsWith(""""scheduled_date":"2026-10-01","scheduled_time":"18:30"}]"""))
    }

    @Test
    fun `refuses what the web form refuses`() {
        assertEquals("Select an opponent", invalid(createChallengeArgs(form.copy(opponentId = ""))))
        assertEquals("Points per game must be between 5 and 30", invalid(createChallengeArgs(form.copy(points = "4"))))
        assertEquals("Points per game must be between 5 and 30", invalid(createChallengeArgs(form.copy(points = "31"))))
        assertEquals("Points per game must be between 5 and 30", invalid(createChallengeArgs(form.copy(points = ""))))
        assertEquals(
            "A note can be at most 500 characters",
            invalid(createChallengeArgs(form.copy(note = "x".repeat(NOTE_MAX + 1)))),
        )
    }

    @Test
    fun `the points helper quotes the deuce ceiling`() {
        assertEquals("A game is won by two clear points, or at 30.", pointsHelper("21"))
        assertEquals("A game is won by two clear points, or at 24.", pointsHelper("15"))
        assertEquals("Points per game must be between 5 and 30.", pointsHelper("3"))
    }

    @Test
    fun `id actions take the id alone`() {
        assertEquals("""["c1"]""", args(idArgs("acceptChallenge", "c1")))
        assertEquals("acceptChallenge", name(idArgs("acceptChallenge", "c1")))
    }

    @Test
    fun `submits a result with the winner worked out and a blank third game dropped`() {
        val built = submitResultArgs(
            "c1",
            listOf(GameScore("21", "15"), GameScore("21", "12"), GameScore("", "")),
            bestOfThree = true,
        )
        assertEquals("submitMatchResult", name(built))
        assertEquals(
            """["c1",{"winner_side":"a","games":[{"game_number":1,"side_a_score":21,"side_b_score":15},""" +
                """{"game_number":2,"side_a_score":21,"side_b_score":12}],"completed":true}]""",
            args(built),
        )
    }

    @Test
    fun `keeps a played third game and a one game match`() {
        val three = submitResultArgs(
            "c1",
            listOf(GameScore("21", "15"), GameScore("12", "21"), GameScore("19", "21")),
            bestOfThree = true,
        )
        assertEquals(true, args(three).contains(""""winner_side":"b""""))
        assertEquals(true, args(three).contains(""""game_number":3"""))
        val one = submitResultArgs("c1", listOf(GameScore("11", "21")), bestOfThree = false)
        assertEquals(
            """["c1",{"winner_side":"b","games":[{"game_number":1,"side_a_score":11,"side_b_score":21}],"completed":true}]""",
            args(one),
        )
    }

    @Test
    fun `refuses a result with no winner`() {
        assertEquals(
            "Enter the game scores. The winner is worked out from them.",
            invalid(submitResultArgs("c1", listOf(GameScore("21", "15"), GameScore("15", "21"), GameScore("", "")), true)),
        )
    }

    @Test
    fun `dispute sends the description before the category`() {
        val built = disputeArgs("m1", "The second game was 21-19", "score_wrong")
        assertEquals("disputeMatchResult", name(built))
        assertEquals("""["m1","The second game was 21-19","score_wrong"]""", args(built))
        assertEquals("Reason required", invalid(disputeArgs("m1", "   ", "other")))
        assertEquals("Description must be at least 10 characters", invalid(disputeArgs("m1", "too short", "other")))
        assertEquals(listOf("score_wrong", "winner_wrong", "format_wrong", "incomplete", "abuse", "other"), DISPUTE_CATEGORIES.map { it.first })
    }

    private val roster = listOf(
        ChallengeParticipant(id = "cp1", playerId = "me", teamSide = "a"),
        ChallengeParticipant(id = "cp2", playerId = "mate", teamSide = "a"),
        ChallengeParticipant(id = "cp3", playerId = "them", teamSide = "b"),
        ChallengeParticipant(id = "cp4", playerId = "them2", teamSide = "b"),
    )

    @Test
    fun `a withdrawal forfeits the member, a no-show the first player across the net`() {
        assertEquals(
            """[{"challenge_id":"c1","forfeit_player_id":"me","walkover_type":"withdrawal"}]""",
            args(walkoverArgs("c1", "withdrawal", "me", roster)),
        )
        assertEquals(
            """[{"challenge_id":"c1","forfeit_player_id":"them","walkover_type":"no_show"}]""",
            args(walkoverArgs("c1", "no_show", "me", roster)),
        )
        assertEquals(
            "Could not determine forfeit player",
            invalid(walkoverArgs("c1", "no_show", "me", roster.take(2))),
        )
    }
}
