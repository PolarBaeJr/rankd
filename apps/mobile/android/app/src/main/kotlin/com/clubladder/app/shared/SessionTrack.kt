package com.clubladder.app.shared

// Port of packages/shared/src/utils/session-track.ts. Keep in step with it.
// players.status and sessions.track share two words and are not one enum: an
// allowlist of the two track statuses, everything else sees every track.

/** The `session_group` enum, verbatim. */
val SESSION_TRACKS: List<String> = listOf("competitive", "recreational", "all")

/** The tracks a member of this status is shown; always a subset of SESSION_TRACKS. */
fun visibleTracksFor(status: String?): List<String> {
    if (status == "competitive" || status == "recreational") return listOf(status, "all")
    return SESSION_TRACKS.toList()
}
