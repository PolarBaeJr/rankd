package com.clubladder.app.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors packages/shared/src/utils/__tests__/auth-otp.test.ts.
class AuthOtpTest {
    @Test
    fun `tries the existing-account type first on sign-in`() {
        assertEquals(listOf("recovery", "signup"), SIGNIN_OTP_TYPES)
    }

    @Test
    fun `falls through only on a type mismatch`() {
        assertTrue(shouldTryNextOtpType("Invalid email verification type"))
        assertFalse(shouldTryNextOtpType("Email rate limit exceeded"))
    }

    @Test
    fun `falls through on GoTrue's expired-or-invalid answer`() {
        assertTrue(shouldTryNextOtpType("Token has expired or is invalid"))
    }

    // JS regex.test is a search. A port using Regex.matches would need the
    // whole string to match and never fall through on GoTrue's full sentence.
    @Test
    fun `matches anywhere in the message, as a JS regex test does`() {
        assertTrue(shouldTryNextOtpType("Error: token has EXPIRED OR IS INVALID, request another"))
        assertTrue(isUnknownAccountError("GoTrue says: Signups not allowed for otp today"))
    }

    @Test
    fun `recognises GoTrue refusing to create an account`() {
        assertTrue(isUnknownAccountError("x", "otp_disabled"))
        assertTrue(isUnknownAccountError("Signups not allowed for otp"))
        assertTrue(isUnknownAccountError("otp_disabled"))
    }

    @Test
    fun `leaves every other failure to the generic handler`() {
        assertFalse(isUnknownAccountError(null))
        assertFalse(isUnknownAccountError(""))
        assertFalse(isUnknownAccountError("Token has expired or is invalid"))
    }

    @Test
    fun `retries a gateway blip`() {
        assertTrue(shouldRetryOtpSend("{}", null, 503))
        assertTrue(shouldRetryOtpSend("", null, null))
        assertTrue(shouldRetryOtpSend("[object Object]", null, null))
    }

    @Test
    fun `never retries an unknown account`() {
        assertFalse(shouldRetryOtpSend("Signups not allowed for otp", "otp_disabled", 422))
    }

    @Test
    fun `never retries a rate limit, which would only push it further`() {
        assertFalse(shouldRetryOtpSend("Email rate limit exceeded", null, 429))
        assertFalse(shouldRetryOtpSend("For security purposes, you can only request this after 30 seconds.", null, null))
    }

    // The TS helper also takes a null error; the Kotlin one is only ever called
    // with an error in hand, so that case has no counterpart here.
    @Test
    fun `does not retry an ordinary failure`() {
        assertFalse(shouldRetryOtpSend("Unable to validate email address", null, 400))
    }
}
