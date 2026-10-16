package com.clubladder.app.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GoTrueErrorTest {
    @Test
    fun `prefers msg over message`() {
        assertEquals("first", GoTrueError.from(400, """{"msg":"first","message":"second"}""", null, "").message)
        assertEquals("second", GoTrueError.from(400, """{"message":"second","error":"third"}""", null, "").message)
        assertEquals("desc", GoTrueError.from(400, """{"error_description":"desc","error":"x"}""", null, "").message)
    }

    // The gateway's empty 503 body is how "{}" reaches friendlyAuthError.
    @Test
    fun `falls back to the raw JSON when nothing names the failure`() {
        val e = GoTrueError.from(503, "{}", null, "Service Unavailable")
        assertEquals("{}", e.message)
        assertEquals(503, e.status)
    }

    @Test
    fun `says the status for a gateway page that is not JSON`() {
        assertEquals("HTTP 503", GoTrueError.from(503, "<html>down</html>", null, "").message)
        assertEquals("Bad Gateway", GoTrueError.from(502, "<html/>", null, "Bad Gateway").message)
    }

    @Test
    fun `reads code only from an API version that has one, else error_code`() {
        val body = """{"code":"otp_disabled","error_code":"legacy","msg":"Signups not allowed for otp"}"""
        assertEquals("otp_disabled", GoTrueError.from(422, body, "2024-01-01", "").code)
        assertEquals("legacy", GoTrueError.from(422, body, "2023-12-31", "").code)
        assertEquals("legacy", GoTrueError.from(422, body, null, "").code)
        assertNull(GoTrueError.from(422, """{"code":42}""", "2024-01-01", "").code)
    }

    @Test
    fun `keeps a network failure as status 0`() {
        val e = GoTrueError.from(0, "Unable to resolve host", null, "")
        assertEquals(0, e.status)
        assertEquals("Unable to resolve host", e.message)
    }
}
