package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors packages/shared/src/utils/__tests__/auth-errors.test.ts.
class AuthErrorsTest {
    @Test
    fun `turns the per-address cooldown into a code was sent with the seconds left`() {
        assertEquals(
            "A code was sent to this email moments ago. Check your inbox, or ask for a new one in 32 seconds.",
            friendlyAuthError("For security purposes, you can only request this after 32 seconds."),
        )
        assertTrue(friendlyAuthError("you can only request this after 1 second").endsWith("in 1 second."))
    }

    @Test
    fun `keeps a generic message for other rate limits`() {
        assertEquals(
            "Too many attempts. Please wait a minute before trying again.",
            friendlyAuthError("email rate limit exceeded"),
        )
    }

    @Test
    fun `maps an empty gateway body and passes anything else through`() {
        assertTrue(friendlyAuthError("{}").contains("reaching the server"))
        assertEquals("Token has expired or is invalid", friendlyAuthError("Token has expired or is invalid"))
    }

    @Test
    fun `writes no em dash`() {
        for (m in listOf("{}", "email rate limit exceeded", "after 5 seconds")) {
            assertFalse(friendlyAuthError(m).contains('\u2014'))
        }
    }

    @Test
    fun `prefers GoTrue's own code`() {
        assertEquals("AUTH-201", authErrorCode("x", "over_email_send_rate_limit"))
        assertEquals("AUTH-202", authErrorCode("x", "over_request_rate_limit"))
        assertEquals("AUTH-203", authErrorCode("x", "otp_expired"))
        assertEquals("AUTH-204", authErrorCode("x", "signup_disabled"))
        assertEquals("AUTH-206", authErrorCode("x", "flow_state_expired"))
        assertEquals("AUTH-207", authErrorCode("x", "user_banned"))
    }

    @Test
    fun `reads the message the way friendlyAuthError does when there is no code`() {
        assertEquals("AUTH-201", authErrorCode("For security purposes, you can only request this after 32 seconds."))
        assertEquals("AUTH-202", authErrorCode("email rate limit exceeded"))
        assertEquals("AUTH-203", authErrorCode("Token has expired or is invalid"))
        assertEquals("AUTH-205", authErrorCode("{}"))
        assertEquals("AUTH-205", authErrorCode("Bad Gateway", status = 502))
        assertEquals("AUTH-000", authErrorCode("Something new"))
        assertEquals("AUTH-205", authErrorCode(null))
    }

    @Test
    fun `appends the code without touching the text`() {
        assertEquals("${friendlyAuthError("{}")} (AUTH-205)", withErrorCode(friendlyAuthError("{}"), "AUTH-205"))
    }
}
