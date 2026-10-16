package com.clubladder.app.config

// Port of the Expo app's src/lib/config.ts. The two public values the app needs
// to reach Supabase, read once at start from BuildConfig. A missing value
// renders a configuration screen instead of a client pointed at nothing.

sealed interface SupabaseConfig {
    data class Ok(val url: String, val anonKey: String) : SupabaseConfig
    data class Missing(val names: List<String>) : SupabaseConfig

    companion object {
        const val URL_NAME = "badminton.supabaseUrl"
        const val ANON_KEY_NAME = "badminton.supabaseAnonKey"

        private val HTTPS_URL = Regex("^https://[^\\s/]+", RegexOption.IGNORE_CASE)
        private val TRAILING_SLASHES = Regex("/+$")

        fun read(url: String?, anonKey: String?): SupabaseConfig {
            val trimmedUrl = url?.trim() ?: ""
            val trimmedKey = anonKey?.trim() ?: ""
            val missing = mutableListOf<String>()
            // https only: the session tokens travel on every request, and a phone
            // on a club's public Wi-Fi is exactly where plain http would be read.
            if (!HTTPS_URL.containsMatchIn(trimmedUrl)) missing.add(URL_NAME)
            if (trimmedKey.isEmpty()) missing.add(ANON_KEY_NAME)
            if (missing.isNotEmpty()) return Missing(missing)
            return Ok(trimmedUrl.replace(TRAILING_SLASHES, ""), trimmedKey)
        }
    }
}
