package com.clubladder.app.data

import com.clubladder.app.auth.SessionManager
import com.clubladder.app.net.HttpRequest
import com.clubladder.app.net.HttpResponse
import com.clubladder.app.net.HttpTransport
import com.clubladder.app.shared.withErrorCode
import kotlinx.serialization.SerialName
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject

// The club website's /api/app routes (apps/player/src/app/api/app/). Every
// write the app makes goes through them, so it runs the website's own server
// action with the website's own gates and side effects; nothing here writes to
// PostgREST directly.
//
// The app will reach websites that do not serve these routes yet. Such a
// website answers with a redirect to /login, a 404, or an HTML page, and every
// one of those reads as NET-003, never as a parse error. Redirects are never
// followed for the same reason.

@Serializable
data class Standing(val ok: Boolean, val detail: String = "")

@Serializable
data class ChallengeRules(
    val maxActive: Int,
    val expiryHours: Int,
    val eloRange: Int = 9999,
    val ladderRange: Int = 50,
)

@Serializable
data class ChallengeQuota(val used: Int, val max: Int, val full: Boolean, val ratio: Double)

/** One /challenges/new opponent. A null Elo is a member who hides their rating. */
@Serializable
data class Opponent(
    val id: String,
    @SerialName("full_name") val fullName: String = "",
    val handle: String? = null,
    @SerialName("singles_elo") val singlesElo: Double? = null,
    @SerialName("doubles_elo") val doublesElo: Double? = null,
)

@Serializable
data class ChallengeContext(
    val playerId: String,
    val standing: Standing,
    val feature: String,
    val featureMessage: String? = null,
    val rules: ChallengeRules,
    val quota: ChallengeQuota,
    val opponents: List<Opponent> = emptyList(),
) {
    val featureOn: Boolean get() = feature == "on"

    /** The web shows the create entry points only in good standing, feature on, quota not full. */
    val canIssue: Boolean get() = standing.ok && featureOn && !quota.full
}

sealed interface AppResult<out T> {
    data class Ok<T>(val value: T) : AppResult<T>
    data class Failed(val message: String) : AppResult<Nothing>
}

sealed interface ActionOutcome {
    /** The action ran. [data] is its return value, when it has one. */
    data class Ok(val data: JsonElement?) : ActionOutcome

    /** The website said no, in a sentence for the member (a rule, not a fault). */
    data class Refused(val message: String) : ActionOutcome

    /** The request did not get an answer the app can trust. Nothing is retried. */
    data class Failed(val message: String) : ActionOutcome
}

/**
 * Bearer only: the member's access token, and never the Supabase anon key,
 * which is for Supabase alone. A 401 refreshes the session once and retries
 * once, as PostgREST reads do; a POST that got no answer (status 0) or a 5xx
 * is NEVER retried, because the write may have landed.
 */
class AppApi(
    private val siteUrl: String,
    private val transport: HttpTransport,
    private val sessions: SessionManager,
) {
    suspend fun context(): AppResult<ChallengeContext> {
        val response = send("GET", CONTEXT_PATH, null)
        failureOf(response)?.let { return AppResult.Failed(it) }
        val obj = parseObject(response.body) ?: return AppResult.Failed(NEEDS_NEWER_SITE)
        return try {
            AppResult.Ok(postgrestJson.decodeFromJsonElement(ChallengeContext.serializer(), obj))
        } catch (e: SerializationException) {
            AppResult.Failed(NEEDS_NEWER_SITE)
        } catch (e: IllegalArgumentException) {
            AppResult.Failed(NEEDS_NEWER_SITE)
        }
    }

    suspend fun action(name: String, args: JsonArray): ActionOutcome {
        val body = buildJsonObject { put("args", args) }.toString()
        val response = send("POST", "$ACTIONS_PATH/$name", body)
        failureOf(response)?.let { return ActionOutcome.Failed(it) }
        val obj = parseObject(response.body) ?: return ActionOutcome.Failed(NEEDS_NEWER_SITE)
        val ok = (obj["ok"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
            ?: return ActionOutcome.Failed(UNREADABLE)
        if (ok) return ActionOutcome.Ok(obj["data"]?.takeIf { it !is JsonNull })
        val error = stringOf(obj["error"])?.takeIf { it.isNotBlank() } ?: "Something went wrong"
        val code = stringOf(obj["code"])?.takeIf { it.isNotBlank() }
        val ref = stringOf(obj["ref"])?.takeIf { it.isNotBlank() }
        val tag = when {
            code != null && ref != null -> " ($code.$ref)"
            code != null -> " ($code)"
            else -> ""
        }
        return ActionOutcome.Refused(error + tag)
    }

    private suspend fun send(method: String, path: String, body: String?): HttpResponse {
        val token = sessions.validAccessToken()
        val first = transport.send(request(method, path, body, token))
        if (first.status != 401) return first
        return transport.send(request(method, path, body, sessions.forceRefresh(token)))
    }

    private fun request(method: String, path: String, body: String?, token: String) = HttpRequest(
        method = method,
        url = siteUrl + path,
        headers = buildMap {
            put("Authorization", "Bearer $token")
            put("Accept", "application/json")
            if (body != null) put("Content-Type", "application/json")
        },
        body = body,
        followRedirects = false,
    )

    /** The message for a reply that is not a readable 200, or null when it is one. */
    private fun failureOf(response: HttpResponse): String? = when {
        response.status == 0 ->
            withErrorCode("Could not reach the club website. Check your connection and try again.", "NET-001")
        response.status in 300..399 || response.status == 404 -> NEEDS_NEWER_SITE
        response.status == 401 ->
            withErrorCode("The club website could not confirm it is you. Sign out and back in.", "AUTH-101")
        response.status == 429 -> withErrorCode("Too many attempts. Wait a minute and try again.", "AUTH-202")
        response.status >= 500 ->
            withErrorCode("The club website is not answering. Try again in a moment.", "NET-002")
        response.status != 200 ->
            stringOf(parseObject(response.body)?.get("error"))?.takeIf { it.isNotBlank() }
                ?: "The club website refused this request (HTTP ${response.status})."
        else -> null
    }

    private fun parseObject(text: String): JsonObject? = try {
        postgrestJson.parseToJsonElement(text) as? JsonObject
    } catch (e: SerializationException) {
        null
    } catch (e: IllegalArgumentException) {
        null
    }

    private fun stringOf(element: JsonElement?): String? =
        (element as? JsonPrimitive)?.takeIf { it.isString }?.content

    companion object {
        const val CONTEXT_PATH = "/api/app/challenges/context"
        const val ACTIONS_PATH = "/api/app/actions"
        val NEEDS_NEWER_SITE = withErrorCode("This needs a newer version of the club website.", "NET-003")
        const val UNREADABLE = "The club website sent a reply this app could not read."
    }
}
