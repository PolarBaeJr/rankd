package com.clubladder.app.data

import com.clubladder.app.shared.AgendaEntry
import com.clubladder.app.shared.AgendaSession
import com.clubladder.app.shared.CLUB_EVENT_KIND_LABELS
import com.clubladder.app.shared.CalendarClubEventRow
import com.clubladder.app.shared.CalendarItem
import com.clubladder.app.shared.CalendarSessionRow
import com.clubladder.app.shared.CalendarTournamentRow
import com.clubladder.app.shared.CheckinSettings
import com.clubladder.app.shared.DayGroup
import com.clubladder.app.shared.DaySection
import com.clubladder.app.shared.DEFAULT_FEATURE_FLAGS
import com.clubladder.app.shared.EntrantPairRow
import com.clubladder.app.shared.EntrantRow
import com.clubladder.app.shared.FALLBACK_CHECKIN_SETTINGS
import com.clubladder.app.shared.FeePayer
import com.clubladder.app.shared.FeedTournament
import com.clubladder.app.shared.MyState
import com.clubladder.app.shared.PaymentPrompt
import com.clubladder.app.shared.RiverPerson
import com.clubladder.app.shared.TOURNAMENT_EVENT_TYPE_LABELS
import com.clubladder.app.shared.WeekStripDay
import com.clubladder.app.shared.activeSeasonOrFilter
import com.clubladder.app.shared.addDaysISO
import com.clubladder.app.shared.announcementExpiryFilter
import com.clubladder.app.shared.announcementSeasonFilter
import com.clubladder.app.shared.attendanceStreak
import com.clubladder.app.shared.buildAgenda
import com.clubladder.app.shared.buildWeekStrip
import com.clubladder.app.shared.clubEventCalendarItem
import com.clubladder.app.shared.clubEventWallClock
import com.clubladder.app.shared.clubToday
import com.clubladder.app.shared.compareCalendarItems
import com.clubladder.app.shared.countEnteredPlayers
import com.clubladder.app.shared.dayLabel
import com.clubladder.app.shared.describeMatch
import com.clubladder.app.shared.describeMyState
import com.clubladder.app.shared.featureOn
import com.clubladder.app.shared.formatRelativeTime
import com.clubladder.app.shared.formatTime
import com.clubladder.app.shared.getCheckinWindow
import com.clubladder.app.shared.groupByDay
import com.clubladder.app.shared.isAddressedTo
import com.clubladder.app.shared.isAttendanceRecorded
import com.clubladder.app.shared.isCheckinOpen
import com.clubladder.app.shared.isStillUpcoming
import com.clubladder.app.shared.isUnderWay
import com.clubladder.app.shared.isoMillis
import com.clubladder.app.shared.money
import com.clubladder.app.shared.occupiesAPlace
import com.clubladder.app.shared.paymentPrompt
import com.clubladder.app.shared.parseCheckinSettings
import com.clubladder.app.shared.parseFeatureFlags
import com.clubladder.app.shared.parseInstant
import com.clubladder.app.shared.plainAnnouncementText
import com.clubladder.app.shared.runningEvents
import com.clubladder.app.shared.seasonWeek
import com.clubladder.app.shared.sessionCalendarItem
import com.clubladder.app.shared.tallyBySession
import com.clubladder.app.shared.tournamentCalendarItems
import com.clubladder.app.shared.tournamentWhen
import com.clubladder.app.shared.underWayEyebrow
import com.clubladder.app.shared.utcToClubWallClock
import com.clubladder.app.shared.visibleTracksFor
import com.clubladder.app.shared.wallClockToUtc
import com.clubladder.app.shared.wasPresent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.putJsonArray
import java.time.Instant
import kotlin.math.roundToInt

// Port of the website's signed-in home, apps/player/src/app/feed/page.tsx, read
// straight from PostgREST on the member's own JWT as the page does. Keep in step
// with it: the reads, their order, and what each failure costs.
//
// Not ported: the month calendar (desktop only on the web), realtime (pull to
// refresh instead), the subscribe-all and add-to-calendar buttons, RSVP, the
// passkey nudge and "check in without scanning". A card that can check in offers
// only the door-code scan, which the app already has.
//
// Two differences from the page, both deliberate:
//  - A read whose feature is switched off is not sent. The web does this for the
//    schedule; here it goes for every card, since the card is dropped anyway.
//  - holdsAccess is always false (see Features.kt), and standing is isApproved,
//    as on every other tab, so a member with a pending deletion reads as in good
//    standing here. The server still refuses what it refuses.

// ---- rows ------------------------------------------------------------------

@Serializable
data class FeedSeasonRow(
    val id: String = "",
    val name: String? = null,
    @SerialName("start_date") val startDate: String? = null,
    @SerialName("end_date") val endDate: String? = null,
)

/**
 * A row of `select=*` on sessions. starts_at, ends_at and
 * require_scan_to_check_in were applied by hand on some hosts, so they are never
 * named in a select and are read as optional here.
 */
@Serializable
data class OpenSessionRow(
    override val id: String = "",
    override val name: String? = null,
    override val date: String = "",
    @SerialName("start_time") override val startTime: String? = null,
    @SerialName("end_time") override val endTime: String? = null,
    override val status: String? = null,
    @SerialName("starts_at") override val startsAt: String? = null,
    @SerialName("ends_at") override val endsAt: String? = null,
    val location: String? = null,
    val notes: String? = null,
    val track: String? = null,
) : AgendaSession

@Serializable
internal data class SettingRow(val value: JsonElement? = null)

@Serializable
internal data class SessionStatusRow(@SerialName("session_id") val sessionId: String = "", val status: String? = null)

@Serializable
internal data class SessionIntentRow(@SerialName("session_id") val sessionId: String = "", val intent: String? = null)

@Serializable
internal data class SessionIdRow(@SerialName("session_id") val sessionId: String = "")

@Serializable
internal data class EventIdRow(@SerialName("event_id") val eventId: String = "")

@Serializable
internal data class AttendeeCountRow(@SerialName("session_id") val sessionId: String = "", val attendees: Double? = null)

@Serializable
internal data class SessionDateRow(val id: String = "", val date: String = "")

@Serializable
data class FeedAnnouncementRow(
    val id: String = "",
    val title: String = "",
    val body: String = "",
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("target_audience") val targetAudience: String? = null,
    val author: JsonElement? = null,
)

@Serializable
internal data class AuthorName(@SerialName("full_name") val fullName: String? = null)

@Serializable
data class RiverParticipantRow(
    @SerialName("team_side") val teamSide: String? = null,
    @SerialName("win_flag") val winFlag: Boolean? = null,
    @SerialName("rating_delta") val ratingDelta: Double? = null,
    @SerialName("post_rating") val postRating: Double? = null,
    val player: JsonElement? = null,
)

@Serializable
data class RiverMatchRow(
    val id: String = "",
    @SerialName("played_at") val playedAt: String? = null,
    @SerialName("match_type") val matchType: String? = null,
    val format: String? = null,
    @SerialName("score_summary") val scoreSummary: String? = null,
    @SerialName("match_participants") val participants: List<RiverParticipantRow>? = null,
)

@Serializable
data class PendingChallengeRow(val id: String = "", val challenge: JsonElement? = null)

@Serializable
internal data class PendingChallengeEmbed(
    val id: String = "",
    val type: String? = null,
    val format: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    val creator: JsonElement? = null,
)

@Serializable
data class EntryParticipantRow(
    @SerialName("event_id") val eventId: String = "",
    @SerialName("player_id") val playerId: String = "",
    val status: String = "",
)

@Serializable
data class EntryPairRow(
    @SerialName("event_id") val eventId: String = "",
    @SerialName("player1_id") val player1Id: String = "",
    @SerialName("player2_id") val player2Id: String = "",
    val status: String = "",
)

@Serializable
data class OwnRatingRow(
    @SerialName("singles_elo") val singlesElo: Double? = null,
    @SerialName("doubles_elo") val doublesElo: Double? = null,
    @SerialName("singles_wins") val singlesWins: Int? = null,
    @SerialName("singles_losses") val singlesLosses: Int? = null,
    @SerialName("doubles_wins") val doublesWins: Int? = null,
    @SerialName("doubles_losses") val doublesLosses: Int? = null,
    @SerialName("singles_provisional") val singlesProvisional: Boolean? = null,
    @SerialName("doubles_provisional") val doublesProvisional: Boolean? = null,
)

// ---- queries, in the web's chain order ---------------------------------------

const val CLUB_EVENT_CALENDAR_COLUMNS = "id, title, kind, location, starts_at, ends_at, status"
const val RIVER_COLUMNS = """
      id, played_at, match_type, format, score_summary,
      match_participants(team_side, win_flag, rating_delta, post_rating,
        player:players(id, full_name, handle, avatar_url))
    """
const val PENDING_CHALLENGE_COLUMNS =
    "id, challenge:challenges(id, type, format, created_at, creator:players!challenges_created_by_fkey(id, full_name, handle, avatar_url))"
const val OWN_RATING_COLUMNS =
    "singles_elo, doubles_elo, singles_wins, singles_losses, doubles_wins, doubles_losses, singles_provisional, doubles_provisional"

/** The server's own row page and the in-list chunk query-chunks.ts uses. */
const val ROW_PAGE_SIZE = 500
const val IN_CHUNK_SIZE = 110

/** The active season with its dates. get_active_season() carries neither date. */
fun activeSeasonRowQuery(): PostgrestQuery =
    PostgrestQuery.select("seasons", "id, name, start_date, end_date").eq("active_flag", "true")

fun featureFlagsQuery(): PostgrestQuery = PostgrestQuery.select("platform_settings", "value").eq("key", "features")

fun checkinSettingsQuery(): PostgrestQuery =
    PostgrestQuery.select("platform_settings", "value").eq("key", "session_attendance")

private fun PostgrestQuery.sessionSeason(seasonId: String?): PostgrestQuery =
    if (seasonId.isNullOrEmpty()) this else or("season_id.eq.$seasonId,season_id.is.null")

private fun PostgrestQuery.tournamentSeason(seasonId: String?): PostgrestQuery =
    activeSeasonOrFilter(seasonId)?.let { or(it) } ?: this

fun openSessionsQuery(seasonId: String?, playerStatus: String?): PostgrestQuery =
    PostgrestQuery.select("sessions", "*")
        .eq("status", "open")
        .sessionSeason(seasonId)
        .isIn("track", visibleTracksFor(playerStatus))
        .order("date", ascending = true)
        .order("start_time", ascending = true, nullsLast = true)

fun calendarSessionsQuery(seasonId: String?, playerStatus: String?): PostgrestQuery =
    PostgrestQuery.select("sessions", "id, name, date, start_time, status, season_id")
        .sessionSeason(seasonId)
        .isIn("track", visibleTracksFor(playerStatus))
        .order("date", ascending = true)
        .order("start_time", ascending = true, nullsLast = true)

fun clubEventsQuery(lowerBoundIso: String): PostgrestQuery =
    PostgrestQuery.select("club_events", CLUB_EVENT_CALENDAR_COLUMNS)
        .isIn("status", listOf("published", "cancelled"))
        .gte("starts_at", lowerBoundIso)
        .order("starts_at", ascending = true)
        .limit(200)

fun calendarTournamentsQuery(seasonId: String?): PostgrestQuery =
    PostgrestQuery.select("tournaments", "id, name, start_date, end_date, status, suspended_at")
        .isIn("status", listOf("active", "completed"))
        .tournamentSeason(seasonId)
        .order("start_date", ascending = true)

fun mySignupsQuery(playerId: String): PostgrestQuery =
    PostgrestQuery.select("club_event_signups", "event_id").eq("player_id", playerId)

fun myAttendanceQuery(playerId: String): PostgrestQuery =
    PostgrestQuery.select("session_attendance", "session_id, status").eq("player_id", playerId)

fun myRsvpQuery(playerId: String): PostgrestQuery =
    PostgrestQuery.select("session_rsvp", "session_id, intent").eq("player_id", playerId)

/** One page of "going" RSVPs for a chunk of sessions. The policy on session_rsvp is USING (TRUE). */
fun goingQuery(sessionIds: List<String>, offset: Int): PostgrestQuery =
    PostgrestQuery.select("session_rsvp", "session_id")
        .isIn("session_id", sessionIds)
        .eq("intent", "going")
        .order("session_id", ascending = true)
        .offset(offset)
        .limit(ROW_PAGE_SIZE)

/** Checked-in counts per session, an aggregate: never other members' attendance rows. */
fun attendeeCountsRpc(sessionIds: List<String>): PostgrestQuery =
    PostgrestQuery.rpc(
        "get_session_attendee_counts",
        buildJsonObject { putJsonArray("p_session_ids") { sessionIds.forEach { add(JsonPrimitive(it)) } } },
    )

fun streakSessionsQuery(today: String, seasonId: String?, playerStatus: String?): PostgrestQuery =
    PostgrestQuery.select("sessions", "id, date")
        .lt("date", today)
        .sessionSeason(seasonId)
        .isIn("track", visibleTracksFor(playerStatus))
        .order("date", ascending = false)
        .limit(20)

/** Expiry and season as two separate or params, which PostgREST ANDs. */
fun announcementsQuery(nowIso: String, seasonId: String?): PostgrestQuery {
    var q = PostgrestQuery.select("announcements", "id, title, body, created_at, target_audience, author:players(full_name)")
        .eq("status", "published")
        .or(announcementExpiryFilter(nowIso))
    announcementSeasonFilter(seasonId)?.let { q = q.or(it) }
    return q.order("pinned", ascending = false).order("created_at", ascending = false).limit(3)
}

fun riverQuery(seasonId: String?): PostgrestQuery =
    PostgrestQuery.select("matches", RIVER_COLUMNS)
        .eq("result_status", "confirmed")
        .notIsNull("played_at")
        .sessionSeason(seasonId)
        .order("played_at", ascending = false)
        .limit(15)

fun pendingChallengesQuery(playerId: String): PostgrestQuery =
    PostgrestQuery.select("challenge_participants", PENDING_CHALLENGE_COLUMNS)
        .eq("player_id", playerId)
        .eq("confirmation_status", "pending")
        .limit(5)

fun liveTournamentsQuery(seasonId: String?): PostgrestQuery =
    PostgrestQuery.select("tournaments", "id, name, start_date, end_date, tournament_events(id, event_type, status)")
        .eq("status", "active")
        .isNull("suspended_at")
        .tournamentSeason(seasonId)
        .order("start_date", ascending = true)

fun entryParticipantsQuery(eventIds: List<String>): PostgrestQuery =
    PostgrestQuery.select("tournament_participants", "event_id, player_id, status").isIn("event_id", eventIds)

fun entryPairsQuery(eventIds: List<String>): PostgrestQuery =
    PostgrestQuery.select("tournament_pairs", "event_id, player1_id, player2_id, status").isIn("event_id", eventIds)

fun ownRatingQuery(playerId: String): PostgrestQuery =
    PostgrestQuery.select("ratings", OWN_RATING_COLUMNS).eq("player_id", playerId)

fun ownFeesQuery(playerId: String): PostgrestQuery =
    PostgrestQuery.select("club_fees", OWN_FEE_COLUMNS).eq("player_id", playerId).order("created_at", ascending = false)

fun seasonFeesQuery(seasonId: String): PostgrestQuery =
    PostgrestQuery.select("seasons", "id, name, end_date, competitive_fee_cents, recreational_fee_cents").eq("id", seasonId)

/** The club events window starts at the term's first day, or 60 days back with none, at club midnight. */
fun clubEventsLowerBound(season: FeedSeasonRow?, today: String): String {
    val from = season?.startDate?.take(10) ?: addDaysISO(today, -60)
    val p = from.split("-").map { it.toIntOrNull() ?: 1 }
    return isoMillis(wallClockToUtc(p[0], p.getOrElse(1) { 1 }, p.getOrElse(2) { 1 }, 0, 0))
}

// ---- what the screen shows ---------------------------------------------------

/** Where a tap goes. Web paths open in the browser, and only when the site is known. */
sealed class FeedLink {
    object MyStats : FeedLink()
    object Membership : FeedLink()
    object NewChallenge : FeedLink()
    object Challenges : FeedLink()
    data class Challenge(val id: String) : FeedLink()
    data class Web(val path: String) : FeedLink()
}

data class FeedStanding(val title: String, val body: String)

data class LiveEntryRow(val eventLabel: String, val checkedIn: Boolean, val link: FeedLink)

data class LiveTournamentCard(
    val id: String,
    val name: String,
    val eyebrow: String,
    val meta: String,
    val entries: List<LiveEntryRow>,
    /** Set when the member is in none of the running events. */
    val notEntered: String?,
    val follow: FeedLink,
)

sealed class FeedAgendaRow {
    abstract val key: String

    data class Session(
        override val key: String,
        val id: String,
        val name: String,
        val trackTag: String?,
        val timeLabel: String,
        val location: String?,
        val goingCount: Int,
        val checkedInCount: Int,
        val notes: String?,
        /** "Checked In", "Attended", "No-show" or "Excused" once attendance is on the record. */
        val stateChip: String?,
        val windowLabel: String?,
        val isNext: Boolean,
        /** Check-in is open for this member; the card offers the door-code scan. */
        val canScan: Boolean,
    ) : FeedAgendaRow()

    data class ClubEvent(
        override val key: String,
        val kindLabel: String,
        val title: String,
        val cancelled: Boolean,
        val meta: String,
        val going: Boolean,
        val link: FeedLink,
    ) : FeedAgendaRow()

    data class Tournament(override val key: String, val name: String, val whenLabel: String, val link: FeedLink) : FeedAgendaRow()
}

data class AgendaDay(val dateISO: String, val label: String, val dateLabel: String, val isToday: Boolean, val rows: List<FeedAgendaRow>)

data class FeedEmpty(val title: String, val hint: String)

data class FeedNotice(val title: String, val body: String, val meta: String)

data class RiverRow(
    val key: String,
    val at: String,
    val mine: Boolean,
    val isChallenge: Boolean,
    val sentence: String,
    val meta: String,
    val face: RiverPerson,
    /** "+14", the reader's own rows only. */
    val delta: String?,
    val deltaUp: Boolean,
    val rating: String?,
    val link: FeedLink,
)

data class YouFigure(val label: String, val value: String, val sub: String)

data class YouCard(val streak: Int?, val figures: List<YouFigure>, val note: String?, val showMyStats: Boolean)

data class Feed(
    val eyebrow: String,
    val standing: FeedStanding?,
    /** "$40.00" or "fees" when a payment is owed; null hides the banner. */
    val paymentAmount: String?,
    val liveTournaments: List<LiveTournamentCard>,
    val scheduleOn: Boolean,
    val sessionsOn: Boolean,
    val week: List<WeekStripDay>,
    val agendaDates: Set<String>,
    val upNextSub: String,
    val scheduleError: Boolean,
    val empty: FeedEmpty?,
    val agendaSoon: List<AgendaDay>,
    val agendaLater: List<AgendaDay>,
    val clubEventsError: Boolean,
    val tournamentsError: Boolean,
    val notice: FeedNotice?,
    val river: List<DaySection<RiverRow>>,
    val riverEnd: String,
    val showChallengeCta: Boolean,
    val announcementsOn: Boolean,
    val you: YouCard,
)

private const val STANDING_TAIL =
    " You can still see the schedule and the feed. RSVP and check-in open once your account is in good standing."

private val STANDING_DETAIL = mapOf(
    "pending_approval" to "Your membership is waiting for an exec to approve it. Until then you can look around, but challenges, RSVPs, check-ins and tournament entries are on hold.",
    "suspended" to "Your account is suspended, so club activity is paused. Contact an exec if you think this is a mistake.",
)

/** Everything the reads returned. A null list is a read that failed; an empty one found nothing or was not sent. */
data class FeedInputs(
    val season: FeedSeasonRow?,
    val flags: Map<String, Boolean>,
    val checkin: CheckinSettings,
    val openSessions: List<OpenSessionRow>?,
    val calendarSessions: List<CalendarSessionRow>?,
    val clubEvents: List<CalendarClubEventRow>?,
    val calendarTournaments: List<CalendarTournamentRow>?,
    val attendance: Map<String, String?>,
    val intents: Map<String, String?>,
    val signedUp: Set<String>,
    val pastSessionIds: List<String>,
    val announcements: List<FeedAnnouncementRow>,
    val river: List<RiverMatchRow>,
    val pendingChallenges: List<PendingChallengeRow>,
    /** The live tournaments already under way today, or empty when the read or the entries failed. */
    val liveTournaments: List<FeedTournament>,
    val entryParticipants: List<EntryParticipantRow>,
    val entryPairs: List<EntryPairRow>,
    val checkedIn: Map<String, Int>,
    val going: Map<String, Int>,
    val rating: OwnRatingRow?,
    val prompt: PaymentPrompt,
)

/** The open sessions that carry a card: kept until their check-in window closes. */
fun upcomingSessionIds(sessions: List<OpenSessionRow>, settings: CheckinSettings, now: Instant): List<String> =
    sessions.filter { isStillUpcoming(getCheckinWindow(it, settings).closesAt, now) }.map { it.id }

private fun countLabel(n: Int, one: String, many: String) = "$n ${if (n == 1) one else many}"

private fun delta(d: Double): String = d.roundToInt().let { if (it >= 0) "+$it" else it.toString() }

private fun toPerson(p: Person?): RiverPerson? =
    p?.id?.let { RiverPerson(it, p.fullName ?: "Someone", p.handle, p.avatarUrl) }

private fun sessionTime(s: OpenSessionRow): String {
    if (s.startTime.isNullOrEmpty()) return "Time TBC"
    val start = formatTime(s.startTime)
    return if (s.endTime.isNullOrEmpty()) start else "$start to ${formatTime(s.endTime)}"
}

private fun stateChip(status: String?): String? = when (status) {
    "checked_in" -> "Checked In"
    "present" -> "Attended"
    "no_show" -> "No-show"
    "excused" -> "Excused"
    else -> null
}

/** Pure: every string the Feed shows, from what the reads returned. */
fun buildFeed(inputs: FeedInputs, viewer: Viewer, now: Instant): Feed {
    val today = clubToday(now)
    fun on(id: String) = featureOn(inputs.flags, id)
    val sessionsOn = on("sessions")
    val eventsOn = on("events")
    val tournamentsOn = on("tournaments")
    val approved = isApproved(viewer)
    val season = inputs.season

    val week = season?.startDate?.let { seasonWeek(it, now) }
    val eyebrow = listOfNotNull(season?.name?.ifEmpty { null }, week?.let { "Week $it" })
        .joinToString(" · ").ifEmpty { "The club" }.uppercase()

    val standing = if (approved) {
        null
    } else {
        val pending = viewer.status == "pending_approval"
        FeedStanding(
            if (pending) "Waiting on approval" else "Account suspended",
            STANDING_DETAIL.getValue(if (pending) "pending_approval" else "suspended") + STANDING_TAIL,
        )
    }

    val paymentAmount = (inputs.prompt as? PaymentPrompt.Owing)?.takeIf { approved && on("fees") }?.let {
        if (it.totalCents == 0L && it.unknownCount > 0) "fees" else money(it.totalCents)
    }

    // Live tournament cards.
    val live = if (tournamentsOn) inputs.liveTournaments else emptyList()
    val liveCards = live.map { t ->
        val running = runningEvents(t)
        val eventIds = running.map { it.id }.toSet()
        val mine = running.mapNotNull { e ->
            val solo = inputs.entryParticipants.firstOrNull { it.eventId == e.id && it.playerId == viewer.id && occupiesAPlace(it.status) }
            val pair = inputs.entryPairs.firstOrNull {
                it.eventId == e.id && (it.player1Id == viewer.id || it.player2Id == viewer.id) && occupiesAPlace(it.status)
            }
            val status = solo?.status ?: pair?.status ?: return@mapNotNull null
            LiveEntryRow(
                TOURNAMENT_EVENT_TYPE_LABELS[e.eventType] ?: e.eventType,
                status == "checked_in",
                FeedLink.Web("/tournaments/${t.id}/events/${e.id}"),
            )
        }
        val entered = countEnteredPlayers(
            inputs.entryParticipants.filter { it.eventId in eventIds }.map { EntrantRow(it.playerId, it.status) },
            inputs.entryPairs.filter { it.eventId in eventIds }.map { EntrantPairRow(it.player1Id, it.player2Id, it.status) },
        )
        val meta = listOfNotNull(
            dayLabel(t.startDate.take(10), today),
            if (entered > 0) countLabel(entered, "PLAYER", "PLAYERS") else null,
        ).joinToString(" · ")
        val notEntered = if (mine.isNotEmpty()) {
            null
        } else if (running.size == 1) {
            "The ${TOURNAMENT_EVENT_TYPE_LABELS[running[0].eventType] ?: running[0].eventType} is on now. You are not entered. The draw is open to watch."
        } else {
            "${running.size} events are on now. You are not entered. The draws are open to watch."
        }
        LiveTournamentCard(t.id, t.name, underWayEyebrow(running), meta, mine, notEntered, FeedLink.Web("/tournaments/${t.id}"))
    }

    // The schedule.
    val openSessions = inputs.openSessions.orEmpty()
    val clubEvents = inputs.clubEvents.orEmpty()
    val calendarTournaments = inputs.calendarTournaments.orEmpty()
    val agenda = buildAgenda(
        sessions = openSessions,
        clubEvents = clubEvents,
        tournaments = calendarTournaments,
        now = now,
        todayISO = today,
        checkinSettings = inputs.checkin,
        liveTournamentIds = live.map { it.id }.toSet(),
    )
    val upcoming = agenda.flatMap { day -> day.sessions.mapNotNull { (it as? AgendaEntry.Session)?.session } }
    val hasCard = upcoming.map { it.id }.toSet()
    fun state(id: String) = describeMyState(inputs.attendance[id], inputs.intents[id])
    fun isMine(id: String) = state(id).let { it == MyState.GOING || it == MyState.CHECKED_IN || it == MyState.ATTENDED }
    val myUpcoming = upcoming.count { isMine(it.id) }
    val eventCount = agenda.sumOf { day -> day.sessions.count { it is AgendaEntry.ClubEvent } }
    val nextSessionId = (upcoming.firstOrNull { it.date >= today } ?: upcoming.firstOrNull())?.id

    val calendarItems: List<CalendarItem> = (
        inputs.calendarSessions.orEmpty().map { sessionCalendarItem(it, isMine(it.id), it.id in hasCard) } +
            clubEvents.mapNotNull { clubEventCalendarItem(it, it.id in inputs.signedUp) } +
            calendarTournaments.flatMap { tournamentCalendarItems(it) }
        ).sortedWith(compareCalendarItems)

    fun row(entry: AgendaEntry<OpenSessionRow>): FeedAgendaRow = when (entry) {
        is AgendaEntry.ClubEvent -> {
            val e = entry.event
            val time = parseInstant(e.startsAt)?.let { clubEventWallClock(it).time }
            FeedAgendaRow.ClubEvent(
                key = entry.key,
                kindLabel = CLUB_EVENT_KIND_LABELS[e.kind] ?: "Club event",
                title = e.title,
                cancelled = e.status == "cancelled",
                meta = listOfNotNull(time?.let { formatTime(it) }, e.location?.ifEmpty { null }).joinToString(" · "),
                going = e.id in inputs.signedUp,
                link = FeedLink.Web("/events/${e.id}"),
            )
        }
        is AgendaEntry.Tournament ->
            FeedAgendaRow.Tournament(entry.key, entry.tournament.name, tournamentWhen(entry.tournament, today), FeedLink.Web("/tournaments/${entry.tournament.id}"))
        is AgendaEntry.Session -> {
            val s = entry.session
            val canCheckIn = isCheckinOpen(s, now, inputs.checkin)
            val status = inputs.attendance[s.id]
            val intent = inputs.intents[s.id]
            val recorded = isAttendanceRecorded(status)
            var windowLabel: String? = null
            if (!canCheckIn && s.date >= today) {
                val opensAt = getCheckinWindow(s, inputs.checkin).opensAt
                windowLabel = if (opensAt != null && now.isBefore(opensAt)) {
                    "Opens at " + formatTime(utcToClubWallClock(opensAt).substring(11))
                } else {
                    "Check-in closed"
                }
            }
            val showWindow = windowLabel != null && !recorded && !canCheckIn && intent != "declined" && approved
            FeedAgendaRow.Session(
                key = entry.key,
                id = s.id,
                name = s.name ?: "Practice Session",
                trackTag = s.track?.takeIf { it.isNotEmpty() && it != "all" }?.uppercase(),
                timeLabel = sessionTime(s),
                location = s.location?.ifEmpty { null },
                goingCount = inputs.going[s.id] ?: 0,
                checkedInCount = inputs.checkedIn[s.id] ?: 0,
                notes = s.notes?.ifEmpty { null },
                stateChip = stateChip(status),
                windowLabel = if (showWindow) windowLabel else null,
                isNext = s.id == nextSessionId,
                canScan = canCheckIn && approved && intent != "declined" && !recorded,
            )
        }
    }

    fun day(group: DayGroup<AgendaEntry<OpenSessionRow>>) =
        AgendaDay(group.dateISO, group.heading.label, group.heading.dateLabel, group.heading.isToday, group.sessions.map(::row))

    val cutoff = addDaysISO(today, 14)
    val soonAll = agenda.filter { it.dateISO < cutoff }
    val soon = if (soonAll.size >= 3) soonAll else agenda.take(3)
    val later = agenda.drop(soon.size)

    val upNextParts = listOfNotNull(
        if (upcoming.isNotEmpty()) countLabel(upcoming.size, "session", "sessions") + " coming up" else null,
        if (myUpcoming > 0) "you're in for $myUpcoming" else null,
        if (eventCount > 0) countLabel(eventCount, "club event", "club events") else null,
    )
    val upNextSub = if (upNextParts.isEmpty()) "Nothing on the calendar." else upNextParts.joinToString(" · ") + "."

    val scheduleError = inputs.openSessions == null || inputs.calendarSessions == null
    val empty = if (scheduleError || agenda.isNotEmpty()) {
        null
    } else if (!sessionsOn) {
        FeedEmpty("Nothing coming up", "Club events and tournaments show up here when the exec posts them.")
    } else if (season != null) {
        FeedEmpty(
            "No sessions yet",
            "Nothing has been posted for ${season.name} yet. New practices show up here as soon as the exec adds them. Watch announcements.",
        )
    } else {
        FeedEmpty("No season is running", "Sessions appear here once the exec opens a new term. Watch announcements for the start date.")
    }

    // Club activity.
    val announcementsOn = on("announcements")
    val notice = if (!announcementsOn) {
        null
    } else {
        inputs.announcements.firstOrNull { isAddressedTo(it.targetAudience, viewer.status, viewer.eligibilityFlag) }?.let { a ->
            val author = pickOne(a.author, AuthorName.serializer())?.fullName
            val by = if (author != null) "Posted by $author" else "Posted by the club"
            FeedNotice(a.title, plainAnnouncementText(a.body), "$by · ${formatRelativeTime(a.createdAt, now)}")
        }
    }

    val myStatsOn = on("my_stats")
    val matchRows = inputs.river.mapNotNull { m ->
        val rows = m.participants.orEmpty()
        val winners = rows.filter { it.winFlag == true }.mapNotNull { toPerson(pickOne(it.player, Person.serializer())) }
        val losers = rows.filter { it.winFlag == false }.mapNotNull { toPerson(pickOne(it.player, Person.serializer())) }
        val sentence = describeMatch(winners, losers, viewer.id) ?: return@mapNotNull null
        val playedAt = m.playedAt ?: return@mapNotNull null
        val mineRow = rows.firstOrNull { pickOne(it.player, Person.serializer())?.id == viewer.id }
        val mine = mineRow != null
        val face = (if (mine) (if (mineRow?.winFlag == true) losers.firstOrNull() else winners.firstOrNull()) else winners.firstOrNull())
            ?: return@mapNotNull null
        val meta = listOf(
            if (m.matchType == "doubles") "Doubles" else "Singles",
            m.scoreSummary?.ifEmpty { null } ?: m.format?.let { formatLabel(it) }.orEmpty(),
            formatRelativeTime(playedAt, now),
        ).filter { it.isNotEmpty() }.joinToString(" · ")
        val d = if (mine) mineRow?.ratingDelta else null
        RiverRow(
            key = "match-${m.id}",
            at = playedAt,
            mine = mine,
            isChallenge = false,
            sentence = sentence,
            meta = meta,
            face = face,
            delta = d?.let(::delta),
            deltaUp = (d ?: 0.0) >= 0,
            rating = if (mine) mineRow?.postRating?.let { it.roundToInt().toString() } else null,
            link = if (mine && myStatsOn) FeedLink.MyStats else FeedLink.Web("/leaderboard/${face.id}"),
        )
    }
    val challengeRows = if (!on("challenges")) {
        emptyList()
    } else {
        inputs.pendingChallenges.mapNotNull { pc ->
            val c = pickOne(pc.challenge, PendingChallengeEmbed.serializer()) ?: return@mapNotNull null
            val creator = toPerson(pickOne(c.creator, Person.serializer())) ?: return@mapNotNull null
            val at = c.createdAt?.ifEmpty { null } ?: return@mapNotNull null
            RiverRow(
                key = "challenge-${pc.id}",
                at = at,
                mine = true,
                isChallenge = true,
                sentence = "${creator.name} wants to play you",
                meta = listOf("Challenge", c.format?.let { formatLabel(it) }.orEmpty()).filter { it.isNotEmpty() }.joinToString(" · "),
                face = creator,
                delta = null,
                deltaUp = true,
                rating = null,
                link = if (approved) FeedLink.Challenge(c.id) else FeedLink.Challenges,
            )
        }
    }
    val river = groupByDay(matchRows + challengeRows, now) { it.at }

    // You.
    val r = inputs.rating
    val played = (r?.singlesWins ?: 0) + (r?.singlesLosses ?: 0) + (r?.doublesWins ?: 0) + (r?.doublesLosses ?: 0)
    fun figure(label: String, elo: Double?, provisional: Boolean?, wins: Int?, losses: Int?) = YouFigure(
        label,
        elo?.roundToInt()?.toString() ?: "None",
        (if (provisional == true) "Provisional · " else "") + "${wins ?: 0}W · ${losses ?: 0}L",
    )
    val you = YouCard(
        streak = if (sessionsOn) attendanceStreak(inputs.pastSessionIds, inputs.attendance.filterValues { wasPresent(it) }.keys) else null,
        figures = if (played > 0) {
            listOf(
                figure("Singles", r?.singlesElo, r?.singlesProvisional, r?.singlesWins, r?.singlesLosses),
                figure("Doubles", r?.doublesElo, r?.doublesProvisional, r?.doublesWins, r?.doublesLosses),
            )
        } else {
            emptyList()
        },
        note = if (played == 0) {
            "No rated matches yet. Your singles and doubles ratings start level and move the first time a result is confirmed."
        } else {
            null
        },
        showMyStats = myStatsOn,
    )

    return Feed(
        eyebrow = eyebrow,
        standing = standing,
        paymentAmount = paymentAmount,
        liveTournaments = liveCards,
        scheduleOn = sessionsOn || eventsOn || tournamentsOn,
        sessionsOn = sessionsOn,
        week = buildWeekStrip(calendarItems, today),
        agendaDates = agenda.map { it.dateISO }.toSet(),
        upNextSub = upNextSub,
        scheduleError = scheduleError,
        empty = empty,
        agendaSoon = soon.map(::day),
        agendaLater = later.map(::day),
        clubEventsError = inputs.clubEvents == null,
        tournamentsError = inputs.calendarTournaments == null,
        notice = notice,
        river = river,
        riverEnd = week?.let { "End of week $it" } ?: "End of the feed",
        showChallengeCta = approved && on("challenges"),
        announcementsOn = announcementsOn,
        you = you,
    )
}

// ---- the loader ------------------------------------------------------------

/** One read, its failure caught so it costs only its own card. Cancellation is never swallowed. */
private suspend fun <T> attempt(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    Result.failure(e)
}

/** Every "going" RSVP for these sessions: in-lists chunked, each chunk paged until a short page. */
private suspend fun loadGoing(postgrest: Postgrest, ids: List<String>): List<String> = coroutineScope {
    ids.chunked(IN_CHUNK_SIZE).map { batch ->
        async {
            val out = mutableListOf<String>()
            var offset = 0
            while (true) {
                val page = postgrest.list(goingQuery(batch, offset), SessionIdRow.serializer(), "who is going")
                out += page.map { it.sessionId }
                if (page.size < ROW_PAGE_SIZE) break
                offset += ROW_PAGE_SIZE
            }
            out
        }
    }.awaitAll().flatten()
}

/**
 * Three rounds, as the page runs them: the season and the switches; then every
 * read the page makes at once; then the tournament entries and the counts,
 * which need the first two. Only a failed season read is not shown: the page
 * treats it as "no season" too.
 */
suspend fun loadFeed(postgrest: Postgrest, viewer: Viewer, now: Instant = Instant.now()): Feed = coroutineScope {
    val today = clubToday(now)
    val seasonRead = async { attempt { postgrest.maybeSingle(activeSeasonRowQuery(), FeedSeasonRow.serializer(), "the season") } }
    val flagsRead = async { attempt { postgrest.maybeSingle(featureFlagsQuery(), SettingRow.serializer(), "the club switches") } }
    val season = seasonRead.await().getOrNull()
    val flags = flagsRead.await().fold({ parseFeatureFlags(it?.value) }, { DEFAULT_FEATURE_FLAGS })
    fun on(id: String) = featureOn(flags, id)
    val sessionsOn = on("sessions")
    val eventsOn = on("events")
    val tournamentsOn = on("tournaments")
    val approved = isApproved(viewer)
    val seasonId = season?.id
    val status = viewer.status

    suspend fun <T> skipped(): Result<List<T>> = Result.success(emptyList())

    val pastRead = async {
        if (sessionsOn) attempt { postgrest.list(streakSessionsQuery(today, seasonId, status), SessionDateRow.serializer(), "past sessions") } else skipped()
    }
    val attendanceRead = async {
        if (sessionsOn) attempt { postgrest.list(myAttendanceQuery(viewer.id), SessionStatusRow.serializer(), "your attendance") } else skipped()
    }
    val announcementsRead = async {
        if (on("announcements")) {
            attempt { postgrest.list(announcementsQuery(isoMillis(now), seasonId), FeedAnnouncementRow.serializer(), "announcements") }
        } else {
            skipped()
        }
    }
    val riverRead = async { attempt { postgrest.list(riverQuery(seasonId), RiverMatchRow.serializer(), "results") } }
    val challengesRead = async {
        if (on("challenges")) {
            attempt { postgrest.list(pendingChallengesQuery(viewer.id), PendingChallengeRow.serializer(), "challenges") }
        } else {
            skipped()
        }
    }
    val liveRead = async {
        if (tournamentsOn) attempt { postgrest.list(liveTournamentsQuery(seasonId), FeedTournament.serializer(), "tournaments") } else skipped()
    }
    val openRead = async {
        if (sessionsOn) attempt { postgrest.list(openSessionsQuery(seasonId, status), OpenSessionRow.serializer(), "sessions") } else skipped()
    }
    val calendarRead = async {
        if (sessionsOn) attempt { postgrest.list(calendarSessionsQuery(seasonId, status), CalendarSessionRow.serializer(), "sessions") } else skipped()
    }
    val rsvpRead = async {
        if (sessionsOn) attempt { postgrest.list(myRsvpQuery(viewer.id), SessionIntentRow.serializer(), "your RSVPs") } else skipped()
    }
    val eventsRead = async {
        if (eventsOn) {
            attempt { postgrest.list(clubEventsQuery(clubEventsLowerBound(season, today)), CalendarClubEventRow.serializer(), "club events") }
        } else {
            skipped()
        }
    }
    val signupsRead = async {
        if (eventsOn) attempt { postgrest.list(mySignupsQuery(viewer.id), EventIdRow.serializer(), "your sign-ups") } else skipped()
    }
    val calendarTournamentsRead = async {
        if (tournamentsOn) {
            attempt { postgrest.list(calendarTournamentsQuery(seasonId), CalendarTournamentRow.serializer(), "tournaments") }
        } else {
            skipped()
        }
    }
    val settingsRead = async {
        attempt { postgrest.maybeSingle(checkinSettingsQuery(), SettingRow.serializer(), "check-in settings") }
            .fold({ parseCheckinSettings(it?.value) }, { FALLBACK_CHECKIN_SETTINGS })
    }
    val ratingRead = async { attempt { postgrest.maybeSingle(ownRatingQuery(viewer.id), OwnRatingRow.serializer(), "your rating") } }
    val promptRead = async {
        val payer = FeePayer(viewer.isExec == true, viewer.feeExempt == true)
        if (!approved || !on("fees") || payer.isExec || payer.feeExempt) {
            PaymentPrompt.None
        } else {
            attempt {
                coroutineScope {
                    val rows = async { postgrest.list(ownFeesQuery(viewer.id), OwnFeeRow.serializer(), "your fees") }
                    val fees = seasonId?.let { postgrest.maybeSingle(seasonFeesQuery(it), StatementSeason.serializer(), "the season") }
                    paymentPrompt(toPayableLines(rows.await(), fees, viewer.status), payer)
                }
            }.getOrDefault(PaymentPrompt.None)
        }
    }

    val settings = settingsRead.await()
    val openSessions = openRead.await().getOrNull()
    val liveRows = liveRead.await().getOrNull().orEmpty()
        .map { it.copy(tournamentEvents = it.tournamentEvents.orEmpty()) }
        .filter { isUnderWay(it, today) }
    val runningIds = liveRows.flatMap { t -> runningEvents(t).map { it.id } }
    val upcomingIds = upcomingSessionIds(openSessions.orEmpty(), settings, now)

    val participantsRead = async {
        if (runningIds.isEmpty()) skipped() else attempt { postgrest.list(entryParticipantsQuery(runningIds), EntryParticipantRow.serializer(), "entries") }
    }
    val pairsRead = async {
        if (runningIds.isEmpty()) skipped() else attempt { postgrest.list(entryPairsQuery(runningIds), EntryPairRow.serializer(), "entries") }
    }
    val countsRead = async {
        if (upcomingIds.isEmpty()) {
            emptyMap()
        } else {
            attempt { postgrest.list(attendeeCountsRpc(upcomingIds), AttendeeCountRow.serializer(), "check-in counts") }
                .getOrNull().orEmpty()
                .associate { it.sessionId to (it.attendees?.takeIf { a -> a.isFinite() }?.toInt() ?: 0) }
        }
    }
    val goingRead = async { if (upcomingIds.isEmpty()) emptyMap() else tallyBySession(attempt { loadGoing(postgrest, upcomingIds) }.getOrNull()) }

    val participants = participantsRead.await()
    val pairs = pairsRead.await()
    val entriesFailed = participants.isFailure || pairs.isFailure

    val inputs = FeedInputs(
        season = season,
        flags = flags,
        checkin = settings,
        openSessions = openSessions,
        calendarSessions = calendarRead.await().getOrNull(),
        clubEvents = eventsRead.await().getOrNull(),
        calendarTournaments = calendarTournamentsRead.await().getOrNull(),
        attendance = attendanceRead.await().getOrNull().orEmpty().associate { it.sessionId to it.status },
        intents = rsvpRead.await().getOrNull().orEmpty().associate { it.sessionId to it.intent },
        signedUp = signupsRead.await().getOrNull().orEmpty().map { it.eventId }.toSet(),
        pastSessionIds = pastRead.await().getOrNull().orEmpty().map { it.id },
        announcements = announcementsRead.await().getOrNull().orEmpty(),
        river = riverRead.await().getOrNull().orEmpty(),
        pendingChallenges = challengesRead.await().getOrNull().orEmpty(),
        liveTournaments = if (entriesFailed) emptyList() else liveRows,
        entryParticipants = if (entriesFailed) emptyList() else participants.getOrNull().orEmpty(),
        entryPairs = if (entriesFailed) emptyList() else pairs.getOrNull().orEmpty(),
        checkedIn = countsRead.await(),
        going = goingRead.await(),
        rating = ratingRead.await().getOrNull(),
        prompt = promptRead.await(),
    )
    buildFeed(inputs, viewer, now)
}
