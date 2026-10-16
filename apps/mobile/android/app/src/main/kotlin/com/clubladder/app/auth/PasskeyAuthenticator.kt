package com.clubladder.app.auth

/**
 * The phone's half of a passkey sign-in, behind an interface so the flow is
 * testable on the JVM. The real one is [CredentialManagerAuthenticator].
 */
interface PasskeyAuthenticator {
    /** [requestJson] is the server's options object, as JSON text. */
    suspend fun getAssertion(requestJson: String): AssertionResult
}

sealed interface AssertionResult {
    /** The WebAuthn AuthenticationResponseJSON, as JSON text. */
    data class Ok(val responseJson: String) : AssertionResult
    /** The member dismissed the sheet. The only outcome that says nothing. */
    data object Cancelled : AssertionResult
    /** No passkey for this site on the phone. */
    data object NoCredential : AssertionResult
    /** No provider can do passkeys on this phone (no Play services, say). */
    data object Unavailable : AssertionResult
    /** [detail] is for debugging only, never shown: the member sees one message. */
    data class Failed(val detail: String) : AssertionResult
}
