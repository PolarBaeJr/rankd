package com.clubladder.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class AvatarToneTest {
    @Test
    fun `takes the first letter of the first two words, upper cased`() {
        assertEquals("AL", avatarInitials("ada Lovelace King"))
        assertEquals("A", avatarInitials("Ada"))
    }

    @Test
    fun `draws a question mark for no name`() {
        assertEquals("?", avatarInitials(""))
    }

    @Test
    fun `skips the empty word a double space leaves`() {
        assertEquals("AL", avatarInitials("Ada  Lovelace"))
    }

    @Test
    fun `picks the web's tone`() {
        // "abc": ((97 * 31 + 98) * 31 + 99) = 96354, 96354 % 7 = 6, so tone 7.
        assertEquals(7, avatarTone("abc"))
        // Past 2^31: the web's `>>> 0` keeps the hash unsigned, so no negative tone.
        assertEquals(3, avatarTone("Ada Lovelace"))
        assertEquals(1, avatarTone(""))
    }
}
