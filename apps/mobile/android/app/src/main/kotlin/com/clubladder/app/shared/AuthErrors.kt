package com.clubladder.app.shared

import java.math.BigInteger

// Port of packages/shared/src/utils/auth-errors.ts. Keep in step with it. The
// registry codes are plain strings here; the TS side types them as ErrorCode.

private val AFTER_SECONDS = Regex("after (\\d+) seconds?", RegexOption.IGNORE_CASE)
private val RATE_LIMITED = Regex("rate|security purposes|too many", RegexOption.IGNORE_CASE)
private val EXPIRED_OR_INVALID = Regex("token has expired or is invalid", RegexOption.IGNORE_CASE)

private fun isEmptyBody(msg: String): Boolean = msg.isEmpty() || msg == "{}" || msg == "[object Object]"

/** A raw GoTrue message turned into something a member can act on. */
fun friendlyAuthError(message: String?): String {
    val msg = (message ?: "").trim()
    if (isEmptyBody(msg)) {
        return "Something went wrong reaching the server. Please try again in a moment."
    }
    val wait = AFTER_SECONDS.find(msg)
    if (wait != null) {
        val n = BigInteger(wait.groupValues[1])
        val plural = if (n == BigInteger.ONE) "" else "s"
        return "A code was sent to this email moments ago. Check your inbox, or ask for a new one in $n second$plural."
    }
    if (RATE_LIMITED.containsMatchIn(msg)) {
        return "Too many attempts. Please wait a minute before trying again."
    }
    return msg
}

private val AUTH_CODES = mapOf(
    "over_email_send_rate_limit" to "AUTH-201",
    "over_request_rate_limit" to "AUTH-202",
    "otp_expired" to "AUTH-203",
    "otp_disabled" to "AUTH-204",
    "signup_disabled" to "AUTH-204",
    "bad_oauth_state" to "AUTH-206",
    "bad_oauth_callback" to "AUTH-206",
    "flow_state_expired" to "AUTH-206",
    "flow_state_not_found" to "AUTH-206",
    "bad_code_verifier" to "AUTH-206",
    "user_banned" to "AUTH-207",
)

/** The registry code for an auth failure, so a banner can say which one it was. */
fun authErrorCode(message: String?, code: String? = null, status: Int? = null): String {
    val mapped = if (code.isNullOrEmpty()) null else AUTH_CODES[code]
    if (mapped != null) return mapped
    if (status != null && status >= 500) return "AUTH-205"
    val msg = (message ?: "").trim()
    if (isEmptyBody(msg)) return "AUTH-205"
    if (AFTER_SECONDS.containsMatchIn(msg)) return "AUTH-201"
    if (RATE_LIMITED.containsMatchIn(msg)) return "AUTH-202"
    if (EXPIRED_OR_INVALID.containsMatchIn(msg)) return "AUTH-203"
    return "AUTH-000"
}

/** A banner's text with the code after it, for the member to quote. */
fun withErrorCode(message: String, code: String): String = "$message ($code)"
