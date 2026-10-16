package com.clubladder.app.auth

import com.clubladder.app.data.Postgrest
import com.clubladder.app.data.PostgrestQuery
import com.clubladder.app.data.PostgrestResult

/**
 * The web login's check, shared by every way in (email code, passkey):
 * players_self is scoped to the caller, so no row and no error means an
 * account that never finished signing up. That session is ended on this
 * device and never kept. A read error fails OPEN, as it does on the web.
 * The session is published only after the check, so no screen ever sees an
 * unfinished account signed in. False means unfinished (already logged out).
 */
internal suspend fun keepIfFinished(
    session: StoredSession,
    api: GoTrueApi,
    sessions: SessionManager,
    postgrest: Postgrest,
): Boolean {
    val check = postgrest.getWithToken(PostgrestQuery.select("players_self", "id"), session.accessToken)
    if (check is PostgrestResult.Ok && check.rows.isEmpty()) {
        api.logout(session.accessToken)
        return false
    }
    sessions.signedIn(session)
    return true
}
