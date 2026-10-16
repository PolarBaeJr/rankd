package com.clubladder.app.config

// The club website's base URL: the player site that serves the passkey routes,
// NOT the Supabase URL. Optional and public. Missing or not https reads as
// null, and the app then simply offers no passkey sign-in: email codes still
// work, so this is never a configuration error.

object SiteConfig {
    const val URL_NAME = "badminton.siteUrl"

    private val HTTPS_URL = Regex("^https://[^\\s/]+", RegexOption.IGNORE_CASE)
    private val TRAILING_SLASHES = Regex("/+$")

    fun read(raw: String?): String? {
        val trimmed = raw?.trim() ?: ""
        // https only, as for Supabase: the passkey verify reply carries the
        // session tokens.
        if (!HTTPS_URL.containsMatchIn(trimmed)) return null
        return trimmed.replace(TRAILING_SLASHES, "")
    }
}
