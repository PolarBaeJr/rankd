package com.clubladder.app.data

import com.clubladder.app.shared.GameScore
import com.clubladder.app.shared.tallyGames
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The arguments the website's challenge actions take, built exactly as the
// website's own forms build them: new-challenge-client.tsx for
// createChallenge, [id]/actions.tsx for the rest. Field names are the zod
// schemas' (packages/shared/src/validators/schemas.ts). Pure, so the bodies are
// tested down to the byte.

sealed interface BuiltArgs {
    data class Args(val name: String, val args: JsonArray) : BuiltArgs
    data class Invalid(val message: String) : BuiltArgs
}

data class NewChallengeForm(
    val type: String,
    val rated: Boolean,
    /** "1" or "3": the web form's own values, held as text. */
    val games: String,
    /** Digits only, as typed. */
    val points: String,
    val opponentId: String,
    val partnerId: String = "",
    val opponentPartnerId: String = "",
    /** YYYY-MM-DD, or empty. */
    val scheduledDate: String = "",
    /** HH:MM, or empty. */
    val scheduledTime: String = "",
    val note: String = "",
)

const val NOTE_MAX = 500

fun pointsInvalid(points: String): Boolean {
    val n = points.toIntOrNull() ?: return true
    return n < 5 || n > 30
}

/** The deuce ceiling the form's helper line quotes: a game to P is won at P + 9 at the latest. */
fun pointsHelper(points: String): String =
    if (pointsInvalid(points)) {
        "Points per game must be between 5 and 30."
    } else {
        "A game is won by two clear points, or at ${(points.toIntOrNull()?.takeIf { it != 0 } ?: 21) + 9}."
    }

fun createChallengeArgs(form: NewChallengeForm): BuiltArgs {
    if (form.opponentId.isEmpty()) return BuiltArgs.Invalid("Select an opponent")
    if (pointsInvalid(form.points)) return BuiltArgs.Invalid("Points per game must be between 5 and 30")
    if (form.note.length > NOTE_MAX) return BuiltArgs.Invalid("A note can be at most $NOTE_MAX characters")
    val games = form.games.toIntOrNull()?.takeIf { it != 0 } ?: 3
    val doubles = form.type == "doubles"
    val input = buildJsonObject {
        put("type", form.type)
        put("rated_flag", form.rated)
        put("event_type", if (form.rated) "rated_challenge" else "casual")
        put("format", if (games > 1) "bo3_21" else "single_21")
        put("games_per_match", games)
        put("points_per_game", form.points.toIntOrNull()?.takeIf { it != 0 } ?: 21)
        put("opponent_id", form.opponentId)
        if (doubles && form.partnerId.isNotEmpty()) put("partner_id", form.partnerId)
        if (doubles && form.opponentPartnerId.isNotEmpty()) put("opponent_partner_id", form.opponentPartnerId)
        if (form.note.isNotEmpty()) put("note", form.note)
        if (form.scheduledDate.isNotEmpty()) put("scheduled_date", form.scheduledDate)
        if (form.scheduledTime.isNotEmpty()) put("scheduled_time", form.scheduledTime)
    }
    return BuiltArgs.Args("createChallenge", JsonArray(listOf(input)))
}

fun idArgs(name: String, id: String): BuiltArgs = BuiltArgs.Args(name, JsonArray(listOf(JsonPrimitive(id))))

/**
 * The submit dialog's scores. The winner is derived from ALL the games; a
 * blank third game in a best of three is then dropped, since it means the
 * match ended 2-0.
 */
fun submitResultArgs(challengeId: String, games: List<GameScore>, bestOfThree: Boolean): BuiltArgs {
    val winner = tallyGames(games).winner
        ?: return BuiltArgs.Invalid("Enter the game scores. The winner is worked out from them.")
    val entered = games.withIndex().filter { (i, g) -> !bestOfThree || i < 2 || g.sideA != "" || g.sideB != "" }
    val input = buildJsonObject {
        put("winner_side", winner.toString())
        put(
            "games",
            buildJsonArray {
                for ((i, g) in entered) {
                    add(
                        buildJsonObject {
                            put("game_number", i + 1)
                            put("side_a_score", g.sideA.toIntOrNull() ?: 0)
                            put("side_b_score", g.sideB.toIntOrNull() ?: 0)
                        },
                    )
                }
            },
        )
        put("completed", true)
    }
    return BuiltArgs.Args("submitMatchResult", JsonArray(listOf(JsonPrimitive(challengeId), input)))
}

/** The dispute dialog's reasons, in the web's order. */
val DISPUTE_CATEGORIES = listOf(
    "score_wrong" to "Score is wrong",
    "winner_wrong" to "Winner is wrong",
    "format_wrong" to "Wrong format",
    "incomplete" to "Match was incomplete",
    "abuse" to "Abuse/fraud",
    "other" to "Other",
)

const val DISPUTE_MIN = 10

/** disputeMatchResult(matchId, reason, category): the description before the category. */
fun disputeArgs(matchId: String, description: String, category: String): BuiltArgs {
    if (description.trim().isEmpty()) return BuiltArgs.Invalid("Reason required")
    if (description.length < DISPUTE_MIN) return BuiltArgs.Invalid("Description must be at least 10 characters")
    return BuiltArgs.Args(
        "disputeMatchResult",
        JsonArray(listOf(JsonPrimitive(matchId), JsonPrimitive(description), JsonPrimitive(category))),
    )
}

/**
 * Withdrawal: the member forfeits themselves. No-show: the first participant on
 * the other side. The server re-checks both.
 */
fun walkoverArgs(
    challengeId: String,
    type: String,
    viewerId: String,
    participants: List<ChallengeParticipant>,
): BuiltArgs {
    val forfeit = if (type == "withdrawal") {
        viewerId
    } else {
        val myTeam = participants.firstOrNull { it.playerId == viewerId }?.teamSide
        participants.firstOrNull { it.playerId != viewerId && it.teamSide != myTeam }?.playerId
    }
    if (forfeit.isNullOrEmpty()) return BuiltArgs.Invalid("Could not determine forfeit player")
    val input = buildJsonObject {
        put("challenge_id", challengeId)
        put("forfeit_player_id", forfeit)
        put("walkover_type", type)
    }
    return BuiltArgs.Args("reportWalkover", JsonArray(listOf(input)))
}
