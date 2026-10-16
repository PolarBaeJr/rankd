package com.clubladder.app.auth

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.LocalDate
import java.time.format.DateTimeParseException

/**
 * A failed auth call, read the way @supabase/auth-js reads one (handleError in
 * its fetch.ts), so the shared auth rules see the message and code they were
 * written against. Status 0 is a request that never got a response.
 */
data class GoTrueError(val message: String, val code: String?, val status: Int) {
    companion object {
        private val API_VERSION_WITH_CODES: LocalDate = LocalDate.of(2024, 1, 1)
        private val json = Json { isLenient = false }

        fun network(message: String): GoTrueError = GoTrueError(message, null, 0)

        fun from(status: Int, body: String, apiVersionHeader: String?, statusText: String): GoTrueError {
            if (status == 0) return network(body)
            // Only an object or array counts: the parser reads a bare word such
            // as an HTML page's text as a string rather than refusing it.
            val parsed: JsonElement? = try {
                json.parseToJsonElement(body).takeIf { it is JsonObject || it is JsonArray }
            } catch (e: IllegalArgumentException) {
                null
            }
            if (parsed == null) {
                // A gateway page rather than GoTrue: nothing to read but the status.
                return GoTrueError(statusText.ifBlank { "HTTP $status" }, null, status)
            }
            val obj = parsed as? JsonObject
            val message = listOf("msg", "message", "error_description", "error")
                .firstNotNullOfOrNull { key -> obj?.stringOrNull(key)?.takeIf { it.isNotEmpty() } }
                ?: parsed.toString()
            val code = when {
                obj == null -> null
                apiVersionAtLeast(apiVersionHeader) && obj.stringOrNull("code") != null -> obj.stringOrNull("code")
                else -> obj.stringOrNull("error_code")
            }
            return GoTrueError(message, code, status)
        }

        private fun apiVersionAtLeast(header: String?): Boolean {
            if (header.isNullOrBlank()) return false
            return try {
                !LocalDate.parse(header.trim()).isBefore(API_VERSION_WITH_CODES)
            } catch (e: DateTimeParseException) {
                false
            }
        }

        private fun JsonObject.stringOrNull(key: String): String? {
            val value = this[key] as? JsonPrimitive ?: return null
            return if (value.isString) value.content else null
        }
    }
}
