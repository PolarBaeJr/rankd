package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors packages/shared/src/utils/__tests__/session-track.test.ts.
class SessionTrackTest {
    private val playerStatuses = listOf("competitive", "recreational", "pending_approval", "suspended")

    @Test
    fun `returns only session_group values for every known status`() {
        for (status in playerStatuses) {
            for (track in visibleTracksFor(status)) assertTrue("$track from $status", track in SESSION_TRACKS)
        }
    }

    @Test
    fun `stays inside the vocabulary for a status this build has never seen`() {
        for (status in listOf("alumni", "inactive", "", "ALL", null)) {
            for (track in visibleTracksFor(status)) assertTrue("$track from $status", track in SESSION_TRACKS)
        }
    }

    @Test
    fun `shows a member with no assigned track every track there is`() {
        for (status in listOf("pending_approval", "suspended")) {
            assertEquals(SESSION_TRACKS.sorted(), visibleTracksFor(status).sorted())
        }
    }

    @Test
    fun `narrows a member who has a track to their own nights and the club-wide ones`() {
        assertEquals(listOf("competitive", "all"), visibleTracksFor("competitive"))
        assertEquals(listOf("recreational", "all"), visibleTracksFor("recreational"))
    }

    @Test
    fun `never withholds the club-wide nights from anyone`() {
        for (status in playerStatuses + listOf("alumni", null)) assertTrue(visibleTracksFor(status).contains("all"))
    }

    @Test
    fun `pins the session_group vocabulary against the enum`() {
        assertEquals(listOf("competitive", "recreational", "all"), SESSION_TRACKS)
    }

    @Test
    fun `hands back a list the caller may keep`() {
        val first = visibleTracksFor("pending_approval")
        val second = visibleTracksFor("pending_approval")
        assertNotSame(first, second)
        assertEquals(first, second)
    }
}
