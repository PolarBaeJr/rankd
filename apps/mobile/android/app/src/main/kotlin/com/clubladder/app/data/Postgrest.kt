package com.clubladder.app.data

import com.clubladder.app.auth.SessionManager
import com.clubladder.app.config.SupabaseConfig
import com.clubladder.app.net.HttpRequest
import com.clubladder.app.net.HttpResponse
import com.clubladder.app.net.HttpTransport
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

sealed interface PostgrestResult {
    data class Ok(val rows: JsonArray) : PostgrestResult
    data class Failed(val message: String, val status: Int) : PostgrestResult
}

/** A failed read, carried to the screen as an error and never as an empty list. */
class ReadException(message: String) : Exception(message)

// coerceInputValues: PostgREST sends a NULL column as an explicit null, which
// would otherwise fail a whole list over one non-null field that has a default.
val postgrestJson = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
}

/**
 * PostgREST with the member's own JWT, so RLS is the gate exactly as it is for
 * the website's browser client. A 401 refreshes the session once and retries
 * once: a token can expire between the expiry check and the server reading it.
 */
class Postgrest(
    private val config: SupabaseConfig.Ok,
    private val transport: HttpTransport,
    private val sessions: SessionManager,
) {
    suspend fun run(query: PostgrestQuery): PostgrestResult {
        val token = sessions.validAccessToken()
        val first = send(query, token)
        if (first.status != 401) return resultOf(first)
        return resultOf(send(query, sessions.forceRefresh(token)))
    }

    /** With a token that is not (yet) the session's, for the check right after a code. */
    suspend fun getWithToken(query: PostgrestQuery, accessToken: String): PostgrestResult =
        resultOf(send(query, accessToken))

    /** Rows decoded as [T], or a [ReadException] prefixed with [what]. */
    suspend fun <T> list(query: PostgrestQuery, serializer: KSerializer<T>, what: String): List<T> =
        when (val result = run(query)) {
            is PostgrestResult.Ok -> postgrestJson.decodeFromJsonElement(ListSerializer(serializer), result.rows)
            is PostgrestResult.Failed -> throw ReadException("Could not read $what: ${result.message}")
        }

    /** postgrest-js maybeSingle: no row is null, one is the row, more is an error. */
    suspend fun <T> maybeSingle(query: PostgrestQuery, serializer: KSerializer<T>, what: String): T? {
        val rows = list(query, serializer, what)
        if (rows.size > 1) throw ReadException("Could not read $what: more than one row came back.")
        return rows.firstOrNull()
    }

    private suspend fun send(query: PostgrestQuery, token: String): HttpResponse {
        val withBody = query.method == "POST"
        return transport.send(
            HttpRequest(
                method = query.method,
                url = config.url + query.pathAndQuery(),
                headers = PostgrestQuery.headers(config.anonKey, token, withBody),
                body = if (withBody) query.body ?: "{}" else null,
            ),
        )
    }

    private fun resultOf(response: HttpResponse): PostgrestResult {
        if (!response.isSuccess) return PostgrestResult.Failed(errorMessage(response), response.status)
        val parsed: JsonElement = try {
            postgrestJson.parseToJsonElement(response.body)
        } catch (e: IllegalArgumentException) {
            return PostgrestResult.Failed("the server sent a reply this app could not read", response.status)
        }
        return when (parsed) {
            is JsonArray -> PostgrestResult.Ok(parsed)
            // A single-object RPC result, read as a one-row list.
            is JsonObject -> PostgrestResult.Ok(JsonArray(listOf(parsed)))
            else -> PostgrestResult.Failed("the server sent a reply this app could not read", response.status)
        }
    }

    private fun errorMessage(response: HttpResponse): String {
        if (response.status == 0) return response.body
        val message = try {
            ((postgrestJson.parseToJsonElement(response.body) as? JsonObject)?.get("message") as? JsonPrimitive)
                ?.takeIf { it.isString }?.content
        } catch (e: IllegalArgumentException) {
            null
        }
        return message ?: response.statusText.ifBlank { "HTTP ${response.status}" }
    }
}
