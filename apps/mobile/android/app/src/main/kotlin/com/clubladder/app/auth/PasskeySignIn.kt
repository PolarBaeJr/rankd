package com.clubladder.app.auth

import com.clubladder.app.data.Postgrest
import com.clubladder.app.shared.withErrorCode

sealed interface PasskeySignInResult {
    data object SignedIn : PasskeySignInResult
    /** The account has no player row: it never finished signing up on the website. */
    data object Unfinished : PasskeySignInResult
    data object Cancelled : PasskeySignInResult
    data object NoPasskey : PasskeySignInResult
    /** Passkeys cannot work here right now (server or phone); offer the email code. */
    data object Unavailable : PasskeySignInResult
    data class Failed(val message: String) : PasskeySignInResult
}

/**
 * Options, assertion, verify, then the same unfinished-account check as the
 * email code. The verify reply is an ordinary Supabase session, kept exactly
 * as an email code's is, so refresh and sign-out need nothing new.
 */
class PasskeySignIn(
    private val api: PasskeyApi,
    private val gotrue: GoTrueApi,
    private val sessions: SessionManager,
    private val postgrest: Postgrest,
    private val nowEpochSec: () -> Long,
) {
    suspend fun signIn(authenticator: PasskeyAuthenticator): PasskeySignInResult {
        // Fresh options on EVERY attempt, never cached: the server claims the
        // challenge before verifying, so any attempt (a failure, even a cancel
        // after the fetch) has burned it, and a retry with the old token fails.
        val options = when (val result = api.options()) {
            is PasskeyOptions.Ok -> result
            PasskeyOptions.Unavailable -> return PasskeySignInResult.Unavailable
            is PasskeyOptions.Failed -> return PasskeySignInResult.Failed(result.message)
        }
        val assertion = when (val result = authenticator.getAssertion(options.requestJson)) {
            is AssertionResult.Ok -> result.responseJson
            AssertionResult.Cancelled -> return PasskeySignInResult.Cancelled
            AssertionResult.NoCredential -> return PasskeySignInResult.NoPasskey
            AssertionResult.Unavailable -> return PasskeySignInResult.Unavailable
            is AssertionResult.Failed -> return PasskeySignInResult.Failed(PasskeyApi.FAILED)
        }
        val body = when (val result = api.verify(assertion, options.challengeToken)) {
            is PasskeyVerify.Ok -> result.body
            is PasskeyVerify.Failed -> return PasskeySignInResult.Failed(result.message)
        }
        val session = parseTokenSession(body, nowEpochSec())
            ?: return PasskeySignInResult.Failed(
                withErrorCode("The sign-in server sent a reply this app could not read.", "AUTH-208"),
            )
        return if (keepIfFinished(session, gotrue, sessions, postgrest)) {
            PasskeySignInResult.SignedIn
        } else {
            PasskeySignInResult.Unfinished
        }
    }
}
