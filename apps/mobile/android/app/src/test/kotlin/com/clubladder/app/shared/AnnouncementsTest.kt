package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors apps/player/src/lib/__tests__/announcement-visibility.test.ts (less the
// unread count) and the strip cases of announcement-markdown.test.ts.
class AnnouncementsTest {
    @Test
    fun `keeps rows with no expiry and rows that have not expired`() {
        assertEquals(
            "expires_at.is.null,expires_at.gt.2026-08-11T00:00:00.000Z",
            announcementExpiryFilter("2026-08-11T00:00:00.000Z"),
        )
    }

    @Test
    fun `uses the two-column season shape and drops it between terms`() {
        val filter = announcementSeasonFilter("season-1")
        assertEquals("all_seasons.eq.true,season_id.eq.season-1", filter)
        assertFalse(filter!!.contains("season_id.is.null"))
        assertNull(announcementSeasonFilter(null))
        assertNull(announcementSeasonFilter(""))
    }

    @Test
    fun `matches the audience against the viewer`() {
        assertTrue(isAddressedTo("all", "competitive", false))
        assertTrue(isAddressedTo("all", "recreational", false))
        assertTrue(isAddressedTo("competitive", "competitive", false))
        assertFalse(isAddressedTo("competitive", "recreational", false))
        assertTrue(isAddressedTo("recreational", "recreational", false))
        assertTrue(isAddressedTo("eligible_only", "recreational", true))
        assertFalse(isAddressedTo("eligible_only", "recreational", false))
        assertFalse(isAddressedTo("eligible_only", "competitive", false))
        assertFalse(isAddressedTo("varsity", "competitive", false))
        assertFalse(isAddressedTo(null, "competitive", false))
        assertFalse(isAddressedTo(null, null, false))
    }

    @Test
    fun `strips inline markers and keeps the words`() {
        assertEquals("Courts closed on Friday", plainAnnouncementText("**Courts closed** on *Friday*"))
        assertEquals("lined and gone", plainAnnouncementText("__lined__ and ~~gone~~"))
        assertEquals("type npm test here", plainAnnouncementText("type `npm test` here"))
    }

    @Test
    fun `strips line-leading markers`() {
        assertEquals("Heading", plainAnnouncementText("## Heading"))
        assertEquals("One\nThree", plainAnnouncementText("# One\n### Three"))
        assertEquals("a\nb", plainAnnouncementText("- a\n* b"))
        assertEquals("quoted", plainAnnouncementText("> quoted"))
    }

    @Test
    fun `leaves single underscores and unclosed markers alone`() {
        assertEquals("read some_file_name.pdf", plainAnnouncementText("read some_file_name.pdf"))
        assertEquals("_this_", plainAnnouncementText("_this_"))
        assertEquals("**unclosed", plainAnnouncementText("**unclosed"))
        assertEquals("*a\n*b", plainAnnouncementText("*a\n*b"))
    }
}
