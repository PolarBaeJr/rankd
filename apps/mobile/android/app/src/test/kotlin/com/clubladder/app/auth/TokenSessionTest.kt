package com.clubladder.app.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TokenSessionTest {
    private val now = 1_800_000_000L

    // 'u?>' encodes to base64url with a '-' or '_' and needs padding, so the
    // payload exercises both the URL alphabet and the unpadded form.
    private val access = testJwt("""{"sub":"u1","email":"m@example.invalid","note":"u?>"}""")

    private fun reply(accessToken: String = access, extra: String = """"expires_at":1800003600""") =
        """{"access_token":"$accessToken","refresh_token":"r",$extra,"token_type":"bearer"}"""

    @Test
    fun `reads the user from the token's sub and email claims`() {
        assertEquals(
            StoredSession(access, "r", 1_800_003_600L, "u1", "m@example.invalid"),
            parseTokenSession(reply(), now),
        )
    }

    @Test
    fun `prefers expires_at, and counts expires_in from now without it`() {
        assertEquals(1_800_003_600L, parseTokenSession(reply(extra = """"expires_at":1800003600,"expires_in":10"""), now)!!.expiresAtEpochSec)
        assertEquals(now + 3600, parseTokenSession(reply(extra = """"expires_in":3600"""), now)!!.expiresAtEpochSec)
    }

    @Test
    fun `leaves the email out when the token has none`() {
        val token = testJwt("""{"sub":"u1"}""")
        assertNull(parseTokenSession(reply(token), now)!!.email)
    }

    @Test
    fun `refuses a token with no sub`() {
        assertNull(parseTokenSession(reply(testJwt("""{"email":"m@example.invalid"}""")), now))
    }

    @Test
    fun `refuses a token that is not a JWT`() {
        assertNull(parseTokenSession(reply("not-a-jwt"), now))
        assertNull(parseTokenSession(reply("a.!!!.c"), now))
        assertNull(parseTokenSession(reply("a.bm90IGpzb24.c"), now))
    }

    @Test
    fun `refuses a body that is not a session`() {
        assertNull(parseTokenSession("not json", now))
        assertNull(parseTokenSession("[]", now))
        assertNull(parseTokenSession("""{"error":"Passkey sign-in failed"}""", now))
        assertNull(parseTokenSession("""{"access_token":"$access","refresh_token":"r"}""", now))
    }
}
