package com.clubladder.app.data

import com.clubladder.app.shared.CLUB_PERMANENT_OFFSET_FROM
import com.clubladder.app.shared.CLUB_TIMEZONE
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

// The member's challenges, read the way the website reads them. The list is
// apps/player/src/app/challenges/page.tsx, the detail
// apps/player/src/app/challenges/[id]/page.tsx, and the pure rules below are
// ports of apps/player/src/lib/challenge-rules.ts,
// apps/player/src/lib/challenge-visibility.ts and
// packages/shared/src/utils/{tags,helpers}.ts. Keep in step with them.
//
// Reads only. Every write goes through AppApi to the website's own actions.

/** The list page's select, verbatim, so both apps read the same rows. */
const val MY_CHALLENGES_SELECT =
    "id, confirmation_status, challenge:challenges(id, created_by, type, format, rated_flag, status, created_at, " +
        "expires_at, scheduled_date, scheduled_time, creator:players!challenges_created_by_fkey(id, full_name, " +
        "handle, avatar_url), challenge_participants(id, player_id, role, team_side, player:players(id, full_name, " +
        "handle)))"

/** The detail page's challenge, with named columns rather than `*` and no ratings embed. */
const val CHALLENGE_DETAIL_SELECT =
    "id, type, format, games_per_match, points_per_game, rated_flag, status, created_by, created_at, expires_at, " +
        "scheduled_date, scheduled_time, note, creator:players!challenges_created_by_fkey(full_name), " +
        "challenge_participants(id, player_id, role, team_side, confirmation_status, " +
        "player:players(id, full_name, handle, avatar_url))"

/** The detail page's match select, verbatim. */
const val MATCH_FOR_CHALLENGE_SELECT =
    "id, result_status, score_summary, submitted_by, match_participants(id, rating_delta, " +
        "player:players(full_name)), match_games(id, game_number, side_a_score, side_b_score)"

@Serializable
data class Person(
    val id: String? = null,
    @SerialName("full_name") val fullName: String? = null,
    val handle: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
)

@Serializable
data class ChallengeParticipant(
    val id: String = "",
    @SerialName("player_id") val playerId: String = "",
    val role: String? = null,
    @SerialName("team_side") val teamSide: String? = null,
    @SerialName("confirmation_status") val confirmationStatus: String? = null,
    val player: JsonElement? = null,
) {
    val person: Person? get() = pickOne(player, Person.serializer())
}

@Serializable
data class ChallengeSummary(
    val id: String,
    @SerialName("created_by") val createdBy: String = "",
    val type: String = "",
    val format: String = "",
    @SerialName("rated_flag") val ratedFlag: Boolean = false,
    val status: String = "",
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("scheduled_date") val scheduledDate: String? = null,
    @SerialName("scheduled_time") val scheduledTime: String? = null,
    val creator: JsonElement? = null,
    @SerialName("challenge_participants") val participants: List<ChallengeParticipant> = emptyList(),
) {
    val creatorPerson: Person? get() = pickOne(creator, Person.serializer())
}

@Serializable
internal data class MyChallengeRow(
    val id: String,
    @SerialName("confirmation_status") val confirmationStatus: String = "",
    val challenge: JsonElement? = null,
)

/** One card on the list: the viewer's participant row and its challenge. */
data class ChallengeListItem(val rowId: String, val confirmationStatus: String, val challenge: ChallengeSummary)

@Serializable
data class ChallengeDetail(
    val id: String,
    val type: String = "",
    val format: String = "",
    @SerialName("games_per_match") val gamesPerMatch: Int? = null,
    @SerialName("points_per_game") val pointsPerGame: Int? = null,
    @SerialName("rated_flag") val ratedFlag: Boolean = false,
    val status: String = "",
    @SerialName("created_by") val createdBy: String = "",
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("scheduled_date") val scheduledDate: String? = null,
    @SerialName("scheduled_time") val scheduledTime: String? = null,
    val note: String? = null,
    val creator: JsonElement? = null,
    @SerialName("challenge_participants") val participants: List<ChallengeParticipant> = emptyList(),
)

@Serializable
data class MatchParticipant(
    val id: String = "",
    @SerialName("rating_delta") val ratingDelta: Double? = null,
    val player: JsonElement? = null,
) {
    val person: Person? get() = pickOne(player, Person.serializer())
}

@Serializable
data class MatchGame(
    val id: String = "",
    @SerialName("game_number") val gameNumber: Int = 0,
    @SerialName("side_a_score") val sideAScore: Int = 0,
    @SerialName("side_b_score") val sideBScore: Int = 0,
)

@Serializable
data class ChallengeMatch(
    val id: String,
    @SerialName("result_status") val resultStatus: String? = null,
    @SerialName("score_summary") val scoreSummary: String? = null,
    @SerialName("submitted_by") val submittedBy: String? = null,
    @SerialName("match_participants") val participants: List<MatchParticipant> = emptyList(),
    @SerialName("match_games") val games: List<MatchGame> = emptyList(),
)

data class ChallengeWithMatch(val challenge: ChallengeDetail, val match: ChallengeMatch?)

/** helpers.ts pickOne: a to-one embed can arrive as an object, a one-row array, or null. */
fun <T> pickOne(element: JsonElement?, serializer: KSerializer<T>): T? {
    val obj = when (element) {
        is JsonObject -> element
        is JsonArray -> element.firstOrNull() as? JsonObject
        else -> null
    } ?: return null
    return try {
        postgrestJson.decodeFromJsonElement(serializer, obj)
    } catch (e: SerializationException) {
        null
    } catch (e: IllegalArgumentException) {
        null
    }
}

fun myChallengesQuery(playerId: String): PostgrestQuery =
    PostgrestQuery.select("challenge_participants", MY_CHALLENGES_SELECT).eq("player_id", playerId).limit(200)

fun challengeDetailQuery(id: String): PostgrestQuery =
    PostgrestQuery.select("challenges", CHALLENGE_DETAIL_SELECT).eq("id", id)

fun matchForChallengeQuery(challengeId: String): PostgrestQuery =
    PostgrestQuery.select("matches", MATCH_FOR_CHALLENGE_SELECT).eq("challenge_id", challengeId)

/** Newest first on the embedded created_at, as the page sorts once the rows are in hand. */
internal fun toListItems(rows: List<MyChallengeRow>): List<ChallengeListItem> =
    rows.mapNotNull { row ->
        pickOne(row.challenge, ChallengeSummary.serializer())?.let { ChallengeListItem(row.id, row.confirmationStatus, it) }
    }.sortedByDescending { epochMillis(it.challenge.createdAt) ?: Long.MIN_VALUE }

suspend fun loadMyChallenges(postgrest: Postgrest, playerId: String): List<ChallengeListItem> =
    toListItems(postgrest.list(myChallengesQuery(playerId), MyChallengeRow.serializer(), "your challenges"))

/** challenge-visibility.ts: the creator, or somebody on the participant list. */
fun viewerMaySeeChallenge(challenge: ChallengeDetail?, viewerId: String?): Boolean {
    if (challenge == null || viewerId.isNullOrEmpty()) return false
    if (challenge.createdBy == viewerId) return true
    return challenge.participants.any { it.playerId == viewerId }
}

/** Null when there is no such challenge or it is not the viewer's to see: the web's 404. */
suspend fun loadChallenge(postgrest: Postgrest, id: String, viewerId: String): ChallengeWithMatch? {
    val challenge = postgrest.maybeSingle(challengeDetailQuery(id), ChallengeDetail.serializer(), "this challenge")
    if (!viewerMaySeeChallenge(challenge, viewerId)) return null
    val match = postgrest.maybeSingle(matchForChallengeQuery(id), ChallengeMatch.serializer(), "the match result")
    return ChallengeWithMatch(challenge!!, match)
}

// ---------------------------------------------------------------------------
// Sections (challenge-rules.ts partitionChallenges)
// ---------------------------------------------------------------------------

val TERMINAL_STATUSES = setOf("completed", "walkover_confirmed", "rejected", "cancelled", "expired")

data class ChallengePartition(
    val incoming: List<ChallengeListItem>,
    val active: List<ChallengeListItem>,
    val outgoing: List<ChallengeListItem>,
    val archived: List<ChallengeListItem>,
)

/** A partially confirmed challenge the viewer has not answered sits in both incoming and active, as on the web. */
fun partitionChallenges(rows: List<ChallengeListItem>, viewerId: String): ChallengePartition {
    fun live(r: ChallengeListItem) = r.challenge.status !in TERMINAL_STATUSES
    return ChallengePartition(
        incoming = rows.filter { live(it) && it.challenge.createdBy != viewerId && it.confirmationStatus == "pending" },
        active = rows.filter { it.challenge.status in setOf("accepted", "partially_confirmed") },
        outgoing = rows.filter { live(it) && it.challenge.createdBy == viewerId },
        archived = rows.filter { it.challenge.status in TERMINAL_STATUSES },
    )
}

/** The Archived section: singles first, then newest first within each. */
fun sortArchived(rows: List<ChallengeListItem>): List<ChallengeListItem> =
    rows.sortedWith(
        compareBy<ChallengeListItem> { if (it.challenge.type == "singles") 0 else 1 }
            .thenByDescending { epochMillis(it.challenge.createdAt) ?: Long.MIN_VALUE },
    )

// ---------------------------------------------------------------------------
// Expiry (challenge-rules.ts expiryState)
// ---------------------------------------------------------------------------

enum class ExpiryKind { NONE, EXPIRED, URGENT, OPEN }

data class ExpiryState(val kind: ExpiryKind, val hoursLeft: Long?, val label: String?)

private val EXPIRABLE_STATUSES = setOf("proposed", "partially_confirmed")
private const val URGENT_HOURS = 12
private const val HOUR_MS = 3_600_000L

fun expiryState(expiresAt: String?, status: String, now: Long = System.currentTimeMillis()): ExpiryState {
    val none = ExpiryState(ExpiryKind.NONE, null, null)
    if (expiresAt == null || status !in EXPIRABLE_STATUSES) return none
    val deadline = epochMillis(expiresAt) ?: return none
    val msLeft = deadline - now
    // Truncated toward zero, like Math.trunc: with 90 minutes left, "1h".
    val hoursLeft = msLeft / HOUR_MS
    if (msLeft <= 0) return ExpiryState(ExpiryKind.EXPIRED, hoursLeft, "Expired")
    if (msLeft < HOUR_MS) {
        val minutes = maxOf(1L, msLeft / 60_000L)
        return ExpiryState(ExpiryKind.URGENT, hoursLeft, "${minutes}m left")
    }
    if (hoursLeft < URGENT_HOURS) return ExpiryState(ExpiryKind.URGENT, hoursLeft, "${hoursLeft}h left")
    if (hoursLeft < 48) return ExpiryState(ExpiryKind.OPEN, hoursLeft, "${hoursLeft}h left")
    return ExpiryState(ExpiryKind.OPEN, hoursLeft, "${hoursLeft / 24}d left")
}

// ---------------------------------------------------------------------------
// Labels (packages/shared tags.ts and constants.ts)
// ---------------------------------------------------------------------------

val CHALLENGE_STATUS_LABEL = mapOf(
    "proposed" to "Proposed",
    "partially_confirmed" to "Partial",
    "accepted" to "Accepted",
    "completed" to "Completed",
    "walkover_confirmed" to "Walkover",
    "walkover_pending" to "Walkover review",
    "disputed" to "Disputed",
    "rejected" to "Rejected",
    "cancelled" to "Cancelled",
    "expired" to "Expired",
)

/** The web's .tag colour classes, by name: gold, win, red, or plain. */
enum class TagTone { PLAIN, GOLD, WIN, RED }

val CHALLENGE_STATUS_TONE = mapOf(
    "proposed" to TagTone.GOLD,
    "partially_confirmed" to TagTone.GOLD,
    "accepted" to TagTone.WIN,
    "walkover_pending" to TagTone.RED,
    "disputed" to TagTone.RED,
)

val PARTICIPANT_CONFIRM_TONE = mapOf(
    "accepted" to TagTone.WIN,
    "rejected" to TagTone.RED,
    "pending" to TagTone.GOLD,
)

val MATCH_FORMAT_LABELS = mapOf(
    "bo3_21" to "Best of 3 to 21",
    "single_21" to "1 Game to 21",
    "single_15" to "1 Game to 15",
    "single_11" to "1 Game to 11",
)

fun formatLabel(format: String): String = MATCH_FORMAT_LABELS[format] ?: format

/**
 * The shape the challenge was actually created with, when it carries one:
 * "Best of 3 to 15". The enum label only when the custom columns are empty,
 * since the enum alone says 21 for every custom target.
 */
fun shapeLabel(format: String, gamesPerMatch: Int?, pointsPerGame: Int?): String {
    if (gamesPerMatch == null || pointsPerGame == null) return formatLabel(format)
    return if (gamesPerMatch <= 1) "1 Game to $pointsPerGame" else "Best of $gamesPerMatch to $pointsPerGame"
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

fun epochMillis(timestamp: String?): Long? {
    if (timestamp.isNullOrBlank()) return null
    return try {
        OffsetDateTime.parse(timestamp).toInstant().toEpochMilli()
    } catch (e: DateTimeParseException) {
        try {
            Instant.parse(timestamp).toEpochMilli()
        } catch (e2: DateTimeParseException) {
            null
        }
    }
}

private val CLUB_DATE = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)

/** helpers.ts formatRelativeTime, with clubDate for anything a week old or more. */
fun formatRelativeTime(timestamp: String, now: Long = System.currentTimeMillis()): String {
    val then = epochMillis(timestamp) ?: return ""
    val diff = now - then
    val minutes = Math.floorDiv(diff, 60_000L)
    val hours = Math.floorDiv(diff, HOUR_MS)
    val days = Math.floorDiv(diff, 86_400_000L)
    if (minutes < 1) return "just now"
    if (minutes < 60) return "${minutes}m ago"
    if (hours < 24) return "${hours}h ago"
    if (days < 7) return "${days}d ago"
    val instant = Instant.ofEpochMilli(then)
    val pinned = instant.atOffset(ZoneOffset.ofHours(-7))
    val date = if (!pinned.toLocalDate().isBefore(CLUB_PERMANENT_OFFSET_FROM)) {
        pinned.toLocalDate()
    } else {
        instant.atZone(ZoneId.of(CLUB_TIMEZONE)).toLocalDate()
    }
    return CLUB_DATE.format(date)
}
