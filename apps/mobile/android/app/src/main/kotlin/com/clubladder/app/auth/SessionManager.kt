package com.clubladder.app.auth

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Why the member is back on the sign-in screen, when it is not obvious. */
enum class SignInNotice { UNKNOWN_ACCOUNT, UNFINISHED }

sealed interface AuthState {
    data object Loading : AuthState
    data class SignedOut(val notice: SignInNotice? = null) : AuthState
    data class SignedIn(val session: StoredSession) : AuthState
}

/** No session, so there is no token to use. */
class NotSignedInException : Exception("You are signed out.")

/** A refresh failed for a reason that says nothing about the session itself. */
class SessionRefreshException(message: String) : Exception(message)

/**
 * The one owner of the session. Every read of a token goes through
 * [validAccessToken], which refreshes a token close to expiry first.
 *
 * Refresh is single-flight: GoTrue rotates the refresh token on use, so two
 * refreshes racing with the same token would have the second one refused and
 * sign the member out. The mutex holder re-checks expiry after acquiring it,
 * and a new session is persisted BEFORE it is published or returned, so a
 * process killed in between never wakes up holding a spent refresh token.
 */
class SessionManager(
    private val api: GoTrueApi,
    private val store: SessionStore,
    private val nowEpochSec: () -> Long,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val _state = MutableStateFlow<AuthState>(AuthState.Loading)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    private val mutex = Mutex()

    /** Reads the stored session once, at start. */
    suspend fun load() {
        val stored = withContext(io) { store.read() }
        _state.value = if (stored != null) AuthState.SignedIn(stored) else AuthState.SignedOut()
    }

    /** A code was verified and the account checked: keep the session. */
    suspend fun signedIn(session: StoredSession) {
        mutex.withLock {
            withContext(io) { store.write(session) }
            _state.value = AuthState.SignedIn(session)
        }
    }

    suspend fun validAccessToken(): String {
        val current = currentSession() ?: throw NotSignedInException()
        if (!needsRefresh(current)) return current.accessToken
        return mutex.withLock {
            val latest = currentSession() ?: throw NotSignedInException()
            if (!needsRefresh(latest)) latest.accessToken else refreshLocked(latest).accessToken
        }
    }

    /**
     * The server refused [rejectedToken] (a PostgREST 401). Refresh once,
     * unless another caller already replaced that token while this one waited.
     */
    suspend fun forceRefresh(rejectedToken: String): String = mutex.withLock {
        val latest = currentSession() ?: throw NotSignedInException()
        if (latest.accessToken != rejectedToken) latest.accessToken else refreshLocked(latest).accessToken
    }

    /** Ends the session on THIS phone only, and says why on the sign-in screen. */
    suspend fun signOut(notice: SignInNotice? = null) {
        val session = mutex.withLock {
            val current = currentSession()
            withContext(io) { store.clear() }
            _state.value = AuthState.SignedOut(notice)
            current
        }
        if (session != null) api.logout(session.accessToken)
    }

    fun setNotice(notice: SignInNotice?) {
        if (_state.value is AuthState.SignedOut) _state.value = AuthState.SignedOut(notice)
    }

    private fun currentSession(): StoredSession? = (_state.value as? AuthState.SignedIn)?.session

    private fun needsRefresh(session: StoredSession): Boolean =
        nowEpochSec() >= session.expiresAtEpochSec - REFRESH_MARGIN_SEC

    // Caller holds the mutex.
    private suspend fun refreshLocked(session: StoredSession): StoredSession {
        when (val result = api.refresh(session.refreshToken)) {
            is GoTrueResult.Ok -> {
                withContext(io) { store.write(result.value) }
                _state.value = AuthState.SignedIn(result.value)
                return result.value
            }
            is GoTrueResult.Failed -> {
                val status = result.error.status
                // A 4xx is GoTrue saying the refresh token is spent or revoked:
                // the session is over. Anything else (offline, a gateway 5xx)
                // says nothing about it, so it is kept for the next attempt.
                if (status in 400..499) {
                    withContext(io) { store.clear() }
                    _state.value = AuthState.SignedOut()
                    throw NotSignedInException()
                }
                throw SessionRefreshException("Could not refresh your session: ${result.error.message}")
            }
        }
    }

    private companion object {
        const val REFRESH_MARGIN_SEC = 90L
    }
}
