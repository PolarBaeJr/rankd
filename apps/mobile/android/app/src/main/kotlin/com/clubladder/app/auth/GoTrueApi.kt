package com.clubladder.app.auth

import com.clubladder.app.config.SupabaseConfig
import com.clubladder.app.net.HttpRequest
import com.clubladder.app.net.HttpResponse
import com.clubladder.app.net.HttpTransport
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

sealed interface GoTrueResult<out T> {
    data class Ok<T>(val value: T) : GoTrueResult<T>
    data class Failed(val error: GoTrueError) : GoTrueResult<Nothing>
}

/**
 * The four GoTrue calls the app makes, on the wire exactly as auth-js makes
 * them (GoTrueClient.ts), so the server cannot tell the two clients apart.
 */
class GoTrueApi(
    private val config: SupabaseConfig.Ok,
    private val transport: HttpTransport,
    private val nowEpochSec: () -> Long,
) {
    /**
     * Email a code to an EXISTING account. create_user false is the guard: left
     * out, GoTrue mints an account for whatever address is typed. Accounts are
     * created on the website, where the waivers are.
     */
    suspend fun sendOtp(email: String): GoTrueError? {
        val body = buildJsonObject {
            put("email", email)
            putJsonObject("data") {}
            put("create_user", false)
            putJsonObject("gotrue_meta_security") {}
        }
        val response = post("/auth/v1/otp", body.toString(), config.anonKey)
        return if (response.isSuccess) null else errorOf(response)
    }

    suspend fun verifyOtp(email: String, token: String, type: String): GoTrueResult<StoredSession> {
        val body = buildJsonObject {
            put("email", email)
            put("token", token)
            put("type", type)
            putJsonObject("gotrue_meta_security") {}
        }
        return sessionFrom(post("/auth/v1/verify", body.toString(), config.anonKey))
    }

    suspend fun refresh(refreshToken: String): GoTrueResult<StoredSession> {
        val body = buildJsonObject { put("refresh_token", refreshToken) }
        return sessionFrom(post("/auth/v1/token?grant_type=refresh_token", body.toString(), config.anonKey))
    }

    /** Ends this device's session only (scope=local). Best effort: the caller signs out either way. */
    suspend fun logout(accessToken: String) {
        post("/auth/v1/logout?scope=local", null, accessToken)
    }

    private fun sessionFrom(response: HttpResponse): GoTrueResult<StoredSession> {
        if (!response.isSuccess) return GoTrueResult.Failed(errorOf(response))
        val session = parseSession(response.body, nowEpochSec())
            ?: return GoTrueResult.Failed(
                GoTrueError("The sign-in server sent a reply this app could not read.", null, response.status),
            )
        return GoTrueResult.Ok(session)
    }

    private fun errorOf(response: HttpResponse): GoTrueError =
        GoTrueError.from(response.status, response.body, response.apiVersion, response.statusText)

    private suspend fun post(path: String, body: String?, bearer: String): HttpResponse =
        transport.send(
            HttpRequest(
                method = "POST",
                url = config.url + path,
                headers = mapOf(
                    "apikey" to config.anonKey,
                    "Authorization" to "Bearer $bearer",
                    "Content-Type" to "application/json;charset=UTF-8",
                    "X-Supabase-Api-Version" to "2024-01-01",
                ),
                body = body,
            ),
        )
}
