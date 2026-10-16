package com.clubladder.app.auth

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import java.util.Base64

/** What the app keeps between launches. Only the user's id and email: nothing else is read. */
@Serializable
data class StoredSession(
    val accessToken: String,
    val refreshToken: String,
    val expiresAtEpochSec: Long,
    val userId: String,
    val email: String? = null,
)

private val sessionJson = Json { ignoreUnknownKeys = true }

/**
 * A GoTrue session response (verify, or the refresh grant). expires_at is
 * absent on some GoTrue versions, in which case expires_in counts from now, as
 * auth-js does. Null when the body is not a session.
 */
fun parseSession(body: String, nowEpochSec: Long): StoredSession? {
    val obj = try {
        sessionJson.parseToJsonElement(body).jsonObject
    } catch (e: IllegalArgumentException) {
        return null
    }
    val accessToken = obj.string("access_token") ?: return null
    val refreshToken = obj.string("refresh_token") ?: return null
    val user = obj["user"] as? JsonObject ?: return null
    val userId = user.string("id") ?: return null
    val expiresAt = (obj["expires_at"] as? JsonPrimitive)?.longOrNull
        ?: (obj["expires_in"] as? JsonPrimitive)?.longOrNull?.let { nowEpochSec + it }
        ?: return null
    return StoredSession(accessToken, refreshToken, expiresAt, userId, user.string("email"))
}

/**
 * The passkey verify reply: a GoTrue session with no user object, so the user
 * id is the access token's `sub` claim and the email its optional `email`.
 * The JWT is read, not verified: it came over TLS from our own server, and
 * every request it is used on is checked by the server that signed it. Null
 * when the body is not a session or the token is not a readable JWT.
 */
fun parseTokenSession(body: String, nowEpochSec: Long): StoredSession? {
    val obj = try {
        sessionJson.parseToJsonElement(body).jsonObject
    } catch (e: IllegalArgumentException) {
        return null
    }
    val accessToken = obj.string("access_token") ?: return null
    val refreshToken = obj.string("refresh_token") ?: return null
    val claims = jwtClaims(accessToken) ?: return null
    val userId = claims.string("sub")?.takeIf { it.isNotEmpty() } ?: return null
    val expiresAt = (obj["expires_at"] as? JsonPrimitive)?.longOrNull
        ?: (obj["expires_in"] as? JsonPrimitive)?.longOrNull?.let { nowEpochSec + it }
        ?: return null
    return StoredSession(accessToken, refreshToken, expiresAt, userId, claims.string("email"))
}

// java.util.Base64, never android.util.Base64: the JVM tests run against the
// stub android.jar with isReturnDefaultValues, where the Android one returns
// null and every test would pass or fail for the wrong reason. JWTs are
// base64url without padding, which the URL decoder accepts.
private fun jwtClaims(token: String): JsonObject? {
    val parts = token.split('.')
    if (parts.size != 3) return null
    return try {
        val payload = String(Base64.getUrlDecoder().decode(parts[1]), Charsets.UTF_8)
        sessionJson.parseToJsonElement(payload) as? JsonObject
    } catch (e: IllegalArgumentException) {
        null
    }
}

private fun JsonObject.string(key: String): String? {
    val value = this[key] as? JsonPrimitive ?: return null
    return if (value.isString) value.content else null
}
