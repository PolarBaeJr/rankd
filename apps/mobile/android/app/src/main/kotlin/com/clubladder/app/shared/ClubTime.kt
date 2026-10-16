package com.clubladder.app.shared

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

// Port of clubToday() in packages/shared/src/utils/session-window.ts, with the
// pin explained beside CLUB_PERMANENT_OFFSET_FROM there. Keep in step with it.
//
// From 2026-11-01 British Columbia stays on UTC-07:00 for good, but a phone's
// timezone data may predate that change and still say UTC-08:00 in winter. So
// past that date the offset is a constant and the zone database is not asked.

const val CLUB_TIMEZONE = "America/Vancouver"
val CLUB_PERMANENT_OFFSET_FROM: LocalDate = LocalDate.of(2026, 11, 1)
private val CLUB_PERMANENT_OFFSET: ZoneOffset = ZoneOffset.ofHours(-7)

/** Today's date on the club's clock, as YYYY-MM-DD. */
fun clubToday(now: Instant = Instant.now()): String {
    val pinned = now.atOffset(CLUB_PERMANENT_OFFSET).toLocalDate()
    if (!pinned.isBefore(CLUB_PERMANENT_OFFSET_FROM)) return pinned.toString()
    return now.atZone(ZoneId.of(CLUB_TIMEZONE)).toLocalDate().toString()
}
