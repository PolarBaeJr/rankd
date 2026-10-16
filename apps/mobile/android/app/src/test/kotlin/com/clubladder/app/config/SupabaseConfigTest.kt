package com.clubladder.app.config

import org.junit.Assert.assertEquals
import org.junit.Test

// Mirrors the Expo app's src/__tests__/config.test.ts.
class SupabaseConfigTest {
    private val url = SupabaseConfig.URL_NAME
    private val key = SupabaseConfig.ANON_KEY_NAME

    @Test
    fun `accepts an https URL and a key, trimming a trailing slash`() {
        assertEquals(
            SupabaseConfig.Ok("https://db.example.invalid", "k"),
            SupabaseConfig.read(" https://db.example.invalid/ ", "k"),
        )
    }

    @Test
    fun `keeps a path prefix`() {
        assertEquals(
            SupabaseConfig.Ok("https://example.invalid/supabase", "k"),
            SupabaseConfig.read("https://example.invalid/supabase", "k"),
        )
    }

    @Test
    fun `names both values when both are missing`() {
        assertEquals(SupabaseConfig.Missing(listOf(url, key)), SupabaseConfig.read(null, null))
        assertEquals(SupabaseConfig.Missing(listOf(url, key)), SupabaseConfig.read("", ""))
    }

    @Test
    fun `refuses plain http, which would carry the session tokens in the clear`() {
        assertEquals(SupabaseConfig.Missing(listOf(url)), SupabaseConfig.read("http://example.invalid", "k"))
    }

    @Test
    fun `treats a blank key as missing`() {
        assertEquals(SupabaseConfig.Missing(listOf(key)), SupabaseConfig.read("https://example.invalid", "   "))
    }

    @Test
    fun `accepts an upper-case scheme, as the JS regex's i flag does`() {
        assertEquals(SupabaseConfig.Ok("HTTPS://example.invalid", "k"), SupabaseConfig.read("HTTPS://example.invalid", "k"))
    }
}
