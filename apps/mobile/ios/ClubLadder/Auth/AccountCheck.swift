import Foundation

/// The web login's check, shared by every way in (email code, passkey):
/// players_self is scoped to the caller, so no row and no error means an
/// account that never finished signing up. That session is ended on this
/// device and never kept. A read error fails OPEN, as it does on the web.
/// The session is published only after the check, so no screen ever sees an
/// unfinished account signed in. False means unfinished (already logged out).
func keepIfFinished(
    _ session: StoredSession,
    api: GoTrueApi,
    sessions: SessionManager,
    postgrest: Postgrest,
) async throws -> Bool {
    let check = try await postgrest.getWithToken(PostgrestQuery.select("players_self", "id"), accessToken: session.accessToken)
    if case let .ok(rows) = check, rows.isEmpty {
        await api.logout(session.accessToken)
        return false
    }
    try await sessions.signedIn(session)
    return true
}
