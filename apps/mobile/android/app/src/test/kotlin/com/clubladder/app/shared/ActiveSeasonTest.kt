package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ActiveSeasonTest {
    @Test
    fun `no active season means no filter`() {
        assertNull(activeSeasonOrFilter(null))
        assertNull(activeSeasonOrFilter(""))
    }

    @Test
    fun `includes season-less rows alongside the active season`() {
        assertEquals("season_id.eq.s1,season_id.is.null", activeSeasonOrFilter("s1"))
    }
}
