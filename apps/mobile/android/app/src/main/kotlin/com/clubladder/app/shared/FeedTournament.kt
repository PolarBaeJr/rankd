package com.clubladder.app.shared

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Port of apps/player/src/lib/feed-tournament.ts and of occupiesAPlace and
// countEnteredPlayers in tournament-index.ts. Keep in step with them. The date
// bound in isUnderWay is the load-bearing half: nothing walks a finished event
// back to completed, so a status-only test would show a stale "UNDER WAY".

@Serializable
data class FeedEvent(
    val id: String = "",
    @SerialName("event_type") val eventType: String = "",
    val status: String = "",
)

@Serializable
data class FeedTournament(
    val id: String = "",
    val name: String = "",
    @SerialName("start_date") val startDate: String = "",
    @SerialName("end_date") val endDate: String? = null,
    @SerialName("tournament_events") val tournamentEvents: List<FeedEvent>? = null,
)

val TOURNAMENT_EVENT_TYPE_LABELS = mapOf(
    "mens_singles" to "Men's Singles",
    "womens_singles" to "Women's Singles",
    "open_singles" to "Open Singles",
    "mens_doubles" to "Men's Doubles",
    "womens_doubles" to "Women's Doubles",
    "mixed_doubles" to "Mixed Doubles",
    "open_doubles" to "Open Doubles",
)

/** Neither taking entries nor finished. A deny-list, so a new mid-lifecycle status counts as running. */
fun isRunningEvent(event: FeedEvent): Boolean = event.status != "registration" && event.status != "completed"

/** Drawn or being played, as opposed to merely open for check-in. */
fun isPlayingEvent(event: FeedEvent): Boolean =
    event.status == "pool_generated" || event.status == "pool_live" || event.status == "bracket_generated" || event.status == "live"

/** The last club day the tournament can be "on": end_date, else start_date. */
fun lastDayOf(startDate: String, endDate: String?): String = (endDate ?: startDate).take(10)

fun isUnderWay(t: FeedTournament, todayKey: String): Boolean {
    if (lastDayOf(t.startDate, t.endDate) < todayKey) return false
    return t.tournamentEvents.orEmpty().any(::isRunningEvent)
}

/** The running events, in the order the query returned them. */
fun runningEvents(t: FeedTournament): List<FeedEvent> = t.tournamentEvents.orEmpty().filter(::isRunningEvent)

fun underWayEyebrow(events: List<FeedEvent>): String = if (events.any(::isPlayingEvent)) "UNDER WAY" else "CHECK-IN OPEN"

/** Still holding a place in the draw, as the server's capacity check counts it. */
fun occupiesAPlace(status: String): Boolean = status != "withdrawn" && status != "disqualified"

data class EntrantRow(val playerId: String, val status: String)
data class EntrantPairRow(val player1Id: String, val player2Id: String, val status: String)

/** People entered, counted once each across singles and doubles. */
fun countEnteredPlayers(participants: List<EntrantRow>, pairs: List<EntrantPairRow>): Int {
    val players = HashSet<String>()
    for (p in participants) if (occupiesAPlace(p.status)) players += p.playerId
    for (p in pairs) {
        if (occupiesAPlace(p.status)) {
            players += p.player1Id
            players += p.player2Id
        }
    }
    return players.size
}
