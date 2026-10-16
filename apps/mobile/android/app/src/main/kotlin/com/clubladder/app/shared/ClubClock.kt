package com.clubladder.app.shared

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

// Port of packages/shared/src/utils/session-window.ts (wallClockToUtc, the
// check-in window) and club-events.ts (utcToClubWallClock, clubEventWallClock),
// plus formatTime and formatRelativeTime from helpers.ts. Keep in step with them.
//
// The same two-era rule as clubToday in ClubTime.kt: from 2026-11-01 the club
// offset is a constant UTC-07:00 and the zone database is not asked. Before that
// date every tzdata release agrees about Vancouver, so the zone rules are used.
// The web's clubDate (the over-a-week fallback of formatRelativeTime) asks Intl
// without the pin; this port pins it, so past the cutover it is the more correct
// of the two.

private val PINNED_OFFSET: ZoneOffset = ZoneOffset.ofHours(-7)
private val CLUB_ZONE_RULES = ZoneId.of(CLUB_TIMEZONE).rules
private val ISO_MILLIS: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
private val EN_US_MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** An instant as JS toISOString prints it, milliseconds always included. What PostgREST is sent. */
fun isoMillis(at: Instant): String = ISO_MILLIS.format(at)

/** A timestamp as PostgREST returns it, or a bare date read as UTC midnight as JS does. Null when unreadable. */
fun parseInstant(iso: String?): Instant? {
    if (iso.isNullOrBlank()) return null
    runCatching { return OffsetDateTime.parse(iso.replace(' ', 'T')).toInstant() }
    runCatching { return Instant.parse(iso) }
    runCatching { return LocalDate.parse(iso).atStartOfDay().toInstant(ZoneOffset.UTC) }
    return null
}

/**
 * A club wall-clock time as a UTC instant. Day overflow rolls, as Date.UTC does:
 * day + 1 is the next-day-midnight bound. Before the pin this is the two-pass
 * technique the web uses, with the same tie-breaks at the historical DST edges.
 */
fun wallClockToUtc(year: Int, month: Int, day: Int, hour: Int, minute: Int): Instant {
    val naive = LocalDateTime.of(year, month, 1, 0, 0)
        .plusDays((day - 1).toLong())
        .plusHours(hour.toLong())
        .plusMinutes(minute.toLong())
    val naiveUtc = naive.toInstant(ZoneOffset.UTC)
    if (!naive.toLocalDate().isBefore(CLUB_PERMANENT_OFFSET_FROM)) return naiveUtc.plusSeconds(7 * 3600)
    val offset1 = CLUB_ZONE_RULES.getOffset(naiveUtc).totalSeconds.toLong()
    val offset2 = CLUB_ZONE_RULES.getOffset(naiveUtc.minusSeconds(offset1)).totalSeconds.toLong()
    return naiveUtc.minusSeconds(offset2)
}

private fun clubLocal(at: Instant): LocalDateTime {
    val pinned = at.atOffset(PINNED_OFFSET).toLocalDateTime()
    if (!pinned.toLocalDate().isBefore(CLUB_PERMANENT_OFFSET_FROM)) return pinned
    return at.atZone(ZoneId.of(CLUB_TIMEZONE)).toLocalDateTime()
}

private fun pad2(n: Int) = n.toString().padStart(2, '0')

/** A stored instant as the club wall clock, `YYYY-MM-DDTHH:MM`. */
fun utcToClubWallClock(at: Instant): String {
    val local = clubLocal(at)
    return local.toLocalDate().toString() + "T" + pad2(local.hour) + ":" + pad2(local.minute)
}

data class ClubWallClock(val date: String, val time: String)

/** The club date and time a stored instant falls on, e.g. 2026-11-02 and 00:30. */
fun clubEventWallClock(at: Instant): ClubWallClock {
    val wall = utcToClubWallClock(at)
    return ClubWallClock(wall.substring(0, 10), wall.substring(11, 16))
}

val CLUB_EVENT_KIND_LABELS = mapOf(
    "social" to "Social",
    "workshop" to "Workshop",
    "clinic" to "Clinic",
    "outing" to "Outing",
    "agm" to "AGM",
    "other" to "Other",
)

const val CLUB_EVENT_DEFAULT_DURATION_MINUTES = 120

/** "18:30:00" (or "18:30") to "6:30 PM". For Postgres TIME columns. */
fun formatTime(time: String): String {
    val parts = time.split(":")
    val hour = parts[0].toIntOrNull() ?: 0
    val minute = parts.getOrNull(1)?.toIntOrNull() ?: 0
    val period = if (hour >= 12) "PM" else "AM"
    val hour12 = if (hour % 12 == 0) 12 else hour % 12
    return "$hour12:${pad2(minute)} $period"
}

/** An instant's club date in the en-US short form, "Aug 1, 2026". */
fun clubDate(at: Instant): String {
    val date = clubLocal(at).toLocalDate()
    return EN_US_MONTHS[date.monthValue - 1] + " " + date.dayOfMonth + ", " + date.year
}

/** "just now", "5m ago", "3h ago", "2d ago", then the club date. The web reads the clock itself; here it is passed. */
fun formatRelativeTime(iso: String, now: Instant): String {
    val then = parseInstant(iso) ?: return iso
    val diff = now.toEpochMilli() - then.toEpochMilli()
    val minutes = Math.floorDiv(diff, 60_000L)
    val hours = Math.floorDiv(diff, 3_600_000L)
    val days = Math.floorDiv(diff, 86_400_000L)
    if (minutes < 1) return "just now"
    if (minutes < 60) return "${minutes}m ago"
    if (hours < 24) return "${hours}h ago"
    if (days < 7) return "${days}d ago"
    return clubDate(then)
}

/** The fields the check-in window reads. startsAt/endsAt win when the row carries them. */
interface SessionWindowFields {
    val date: String
    val startTime: String?
    val endTime: String?
    val status: String?
    val startsAt: String?
    val endsAt: String?
}

data class CheckinSettings(val defaultDurationMinutes: Double, val opensMinutesBefore: Double?)

/** What the web renders with when the settings row cannot be read (constants.ts). */
val FALLBACK_CHECKIN_SETTINGS = CheckinSettings(60.0, 30.0)

/** JS Number() on a JSON value: undefined is NaN, null and "" are 0. */
private fun jsNumber(element: JsonElement?): Double = when (element) {
    null -> Double.NaN
    is JsonNull -> 0.0
    is JsonPrimitive -> when {
        element.isString -> element.content.trim().let { if (it.isEmpty()) 0.0 else it.toDoubleOrNull() ?: Double.NaN }
        element.booleanOrNull != null -> if (element.booleanOrNull == true) 1.0 else 0.0
        else -> element.doubleOrNull ?: Double.NaN
    }
    else -> Double.NaN
}

/**
 * The platform_settings 'session_attendance' value, coerced as the database
 * coerces it: duration falls back to 120 and a missing opening edge is null.
 * Deliberately not FALLBACK_CHECKIN_SETTINGS; see the web's comment.
 */
fun parseCheckinSettings(value: JsonElement?): CheckinSettings {
    val row = value as? JsonObject
    val duration = jsNumber(row?.get("default_duration_minutes"))
    val opensRaw = row?.get("checkin_opens_minutes_before")
    val opens = jsNumber(opensRaw)
    return CheckinSettings(
        defaultDurationMinutes = if (duration.isFinite()) duration else 120.0,
        opensMinutesBefore = if (opensRaw == null || opensRaw is JsonNull || !opens.isFinite()) null else opens,
    )
}

data class CheckinWindow(val opensAt: Instant?, val closesAt: Instant)

private data class DateParts(val y: Int, val m: Int, val d: Int)

private fun dateParts(date: String): DateParts {
    val p = date.split("-")
    return DateParts(p.getOrNull(0)?.toIntOrNull() ?: 0, p.getOrNull(1)?.toIntOrNull() ?: 1, p.getOrNull(2)?.toIntOrNull() ?: 1)
}

private fun timeParts(time: String): Pair<Int, Int> {
    val p = time.split(":")
    return (p[0].toIntOrNull() ?: 0) to (p.getOrNull(1)?.toIntOrNull() ?: 0)
}

private fun plusMinutes(at: Instant, minutes: Double): Instant = at.plusMillis((minutes * 60_000).toLong())

private fun resolveStart(session: SessionWindowFields): Instant {
    parseInstant(session.startsAt)?.let { return it }
    val (y, m, d) = dateParts(session.date)
    val (h, min) = timeParts(session.startTime?.ifEmpty { null } ?: "00:00")
    return wallClockToUtc(y, m, d, h, min)
}

/** Same rules as session_checkin_open: end_time, else start plus the duration, else the next club midnight. */
fun getCheckinWindow(session: SessionWindowFields, settings: CheckinSettings = FALLBACK_CHECKIN_SETTINGS): CheckinWindow {
    val startAt = resolveStart(session)
    val closesAt = if (parseInstant(session.startsAt) != null) {
        parseInstant(session.endsAt) ?: plusMinutes(startAt, settings.defaultDurationMinutes)
    } else {
        val (y, m, d) = dateParts(session.date)
        when {
            !session.endTime.isNullOrEmpty() -> timeParts(session.endTime!!).let { (h, min) -> wallClockToUtc(y, m, d, h, min) }
            !session.startTime.isNullOrEmpty() -> plusMinutes(startAt, settings.defaultDurationMinutes)
            else -> wallClockToUtc(y, m, d + 1, 0, 0)
        }
    }
    val opensAt = settings.opensMinutesBefore?.let { plusMinutes(startAt, -it) }
    return CheckinWindow(opensAt, closesAt)
}

fun isCheckinOpen(session: SessionWindowFields, now: Instant, settings: CheckinSettings = FALLBACK_CHECKIN_SETTINGS): Boolean {
    if (session.status != null && session.status != "open") return false
    val window = getCheckinWindow(session, settings)
    if (window.opensAt != null && now.isBefore(window.opensAt)) return false
    return now.isBefore(window.closesAt)
}
