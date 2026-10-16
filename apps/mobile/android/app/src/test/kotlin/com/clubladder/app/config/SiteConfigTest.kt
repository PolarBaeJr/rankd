package com.clubladder.app.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SiteConfigTest {
    @Test
    fun `accepts an https URL, trimming space and trailing slashes`() {
        assertEquals("https://site.example.invalid", SiteConfig.read(" https://site.example.invalid// "))
    }

    @Test
    fun `accepts an upper-case scheme, as the Supabase URL does`() {
        assertEquals("HTTPS://site.example.invalid", SiteConfig.read("HTTPS://site.example.invalid"))
    }

    @Test
    fun `reads a missing or blank value as no website, not an error`() {
        assertNull(SiteConfig.read(null))
        assertNull(SiteConfig.read(""))
        assertNull(SiteConfig.read("   "))
    }

    @Test
    fun `refuses plain http, which would carry the session tokens in the clear`() {
        assertNull(SiteConfig.read("http://site.example.invalid"))
    }
}
