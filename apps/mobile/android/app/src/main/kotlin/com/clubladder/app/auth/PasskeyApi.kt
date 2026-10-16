package com.clubladder.app.auth

import com.clubladder.app.net.HttpRequest
import com.clubladder.app.net.HttpResponse
import com.clubladder.app.net.HttpTransport
import com.clubladder.app.shared.withErrorCode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The player website's two native-app passkey routes, on the wire exactly as
// apps/player/src/app/api/passkey/app/login/{options,verify}/route.ts expect
// them. Nothing here logs the options, the assertion or the tokens.

sealed interface PasskeyOptions {
    /** [requestJson] goes to Credential Manager as is; [challengeToken] back to verify unchanged. */
    data class Ok(val requestJson: String, val challengeToken: String) : PasskeyOptions
    /** 503: the server has no passkey secret. Not a fault, just no passkeys here. */
    data object Unavailable : PasskeyOptions
    data class Failed(val message: String) : PasskeyOptions
}

sealed interface PasskeyVerify {
    /** The raw 200 body. Reading it into a session is the caller's job, so a bad one has one message. */
    data class Ok(val body: String) : PasskeyVerify
    data class Failed(val message: String) : PasskeyVerify
}

/**
 * Only Content-Type and Accept go to the website: never the Supabase anon key
 * or a bearer, which are for Supabase alone.
 */
class PasskeyApi(private val siteUrl: String, private val transport: HttpTransport) {
    /**
     * The server ignores the body, but one is sent: a POST with no body goes
     * out with no Content-Length on some stacks, and an edge can refuse that.
     * The options object is passed through as the server wrote it, never
     * decoded into a class, so a field this app does not know (hints,
     * extensions) still reaches Credential Manager.
     */
    suspend fun options(): PasskeyOptions {
        val response = post("/api/passkey/app/login/options", "{}")
        if (response.status == 503) return PasskeyOptions.Unavailable
        if (!response.isSuccess) return PasskeyOptions.Failed(errorMessage(response.status, verify = false))
        val obj = parseObject(response.body) ?: return PasskeyOptions.Failed(FAILED)
        val options = obj["options"] as? JsonObject ?: return PasskeyOptions.Failed(FAILED)
        val token = (obj["challengeToken"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (token.isNullOrEmpty()) return PasskeyOptions.Failed(FAILED)
        return PasskeyOptions.Ok(options.toString(), token)
    }

    /**
     * The credential goes as a JSON OBJECT, not a string holding one: the
     * route's schema wants an object with an id, and a string would be a
     * silent 400. Anything that is not an object is refused here, unsent.
     */
    suspend fun verify(credentialJson: String, challengeToken: String): PasskeyVerify {
        val credential = parseObject(credentialJson) ?: return PasskeyVerify.Failed(FAILED)
        val body = buildJsonObject {
            put("credential", credential)
            put("challengeToken", challengeToken)
        }
        val response = post("/api/passkey/app/login/verify", body.toString())
        if (!response.isSuccess) return PasskeyVerify.Failed(errorMessage(response.status, verify = true))
        return PasskeyVerify.Ok(response.body)
    }

    // Every server failure is the same "Passkey sign-in failed" by design, so
    // the status is all there is to go on. A verify 500 is the server failing
    // to mint the session after a good signature: a fresh attempt is the
    // answer, as it is for a 400, so it reads as a passkey failure.
    private fun errorMessage(status: Int, verify: Boolean): String = when {
        status == 0 -> withErrorCode("Could not reach the club website. Check your connection and try again.", "AUTH-205")
        status == 429 -> withErrorCode("Too many attempts. Wait a minute and try again.", "AUTH-202")
        status >= 500 && !(verify && status == 500) ->
            withErrorCode("The sign-in service did not answer. Try again in a moment.", "AUTH-205")
        else -> FAILED
    }

    private fun parseObject(text: String): JsonObject? = try {
        Json.parseToJsonElement(text) as? JsonObject
    } catch (e: IllegalArgumentException) {
        null
    }

    private suspend fun post(path: String, body: String): HttpResponse =
        transport.send(
            HttpRequest(
                method = "POST",
                url = siteUrl + path,
                headers = mapOf(
                    "Content-Type" to "application/json",
                    "Accept" to "application/json",
                ),
                body = body,
            ),
        )

    companion object {
        val FAILED = withErrorCode("Signing in with your passkey did not work. Try again, or use an email code.", "AUTH-208")
    }
}
