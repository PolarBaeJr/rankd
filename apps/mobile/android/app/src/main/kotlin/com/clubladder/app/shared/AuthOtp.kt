package com.clubladder.app.shared

// Port of packages/shared/src/utils/auth-otp.ts. Keep in step with it; the
// reasoning behind each rule is written up there and not repeated here.
// JS `regex.test` is a search, so every match here is containsMatchIn.

/** An existing account gets a `recovery` token, an unconfirmed one `signup`. */
val SIGNIN_OTP_TYPES: List<String> = listOf("recovery", "signup")

private val NEXT_OTP_TYPE = Regex("verification type|not found|expired or is invalid", RegexOption.IGNORE_CASE)
private val UNKNOWN_ACCOUNT = Regex("signups? not allowed|otp[_ ]disabled", RegexOption.IGNORE_CASE)
private val DO_NOT_RETRY = Regex("rate|after \\d|security purposes|too many", RegexOption.IGNORE_CASE)

/** Fall through to the next token type when the code did not match. */
fun shouldTryNextOtpType(message: String?): Boolean = NEXT_OTP_TYPE.containsMatchIn(message ?: "")

/** GoTrue refusing to create an account for an address it does not know. */
fun isUnknownAccountError(message: String?, code: String? = null): Boolean {
    if (code == "otp_disabled") return true
    return UNKNOWN_ACCOUNT.containsMatchIn(message ?: "")
}

/** Whether a failed code send is worth one silent retry: a gateway blip only. */
fun shouldRetryOtpSend(message: String?, code: String?, status: Int?): Boolean {
    if (isUnknownAccountError(message, code)) return false
    val msg = (message ?: "").trim()
    if (DO_NOT_RETRY.containsMatchIn(msg)) return false
    if (status != null && status >= 500) return true
    return msg.isEmpty() || msg == "{}" || msg == "[object Object]"
}
