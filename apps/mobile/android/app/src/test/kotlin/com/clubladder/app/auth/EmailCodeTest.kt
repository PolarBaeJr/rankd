package com.clubladder.app.auth

import com.clubladder.app.config.SupabaseConfig
import com.clubladder.app.data.Postgrest
import com.clubladder.app.net.FakeTransport
import com.clubladder.app.net.HttpRequest
import com.clubladder.app.net.HttpResponse
import com.clubladder.app.net.ok
import com.clubladder.app.net.status
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class EmailCodeTest {
    private val config = SupabaseConfig.Ok(FakeTransport.BASE_URL, "anon")
    private val now = 1_800_000_000L
    private val session = """{"access_token":"a","refresh_token":"r","expires_in":3600,"user":{"id":"u1","email":"m@example.invalid"}}"""

    private class Harness(val code: EmailCode, val transport: FakeTransport, val sessions: SessionManager, val pauses: MutableList<Long>)

    private suspend fun TestScope.harness(respond: suspend (HttpRequest) -> HttpResponse): Harness {
        val transport = FakeTransport(respond)
        val api = GoTrueApi(config, transport) { now }
        val sessions = SessionManager(api, MemorySessionStore(), { now }, UnconfinedTestDispatcher(testScheduler))
        sessions.load()
        val pauses = mutableListOf<Long>()
        val code = EmailCode(api, sessions, Postgrest(config, transport, sessions)) { pauses.add(it) }
        return Harness(code, transport, sessions, pauses)
    }

    private fun HttpRequest.path() = url.substringAfter(FakeTransport.BASE_URL)

    @Test
    fun `retries a gateway 503 once`() = runTest {
        var sends = 0
        val h = harness {
            sends += 1
            if (sends == 1) status(503, "{}") else ok("{}")
        }
        assertEquals(SendCodeResult.Sent, h.code.send("m@example.invalid"))
        assertEquals(2, h.transport.requests.size)
        assertEquals(listOf(900L), h.pauses)
    }

    @Test
    fun `sends create_user false so an unknown address is never enrolled`() = runTest {
        val h = harness { ok("{}") }
        h.code.send("m@example.invalid")
        assertTrue(h.transport.requests[0].body!!.contains("\"create_user\":false"))
        assertEquals("/auth/v1/otp", h.transport.requests[0].path())
    }

    @Test
    fun `does not retry a rate limit`() = runTest {
        val h = harness { status(429, """{"msg":"Email rate limit exceeded"}""") }
        val result = h.code.send("m@example.invalid")
        assertEquals(1, h.transport.requests.size)
        assertEquals(
            SendCodeResult.Failed("Too many attempts. Please wait a minute before trying again. (AUTH-202)"),
            result,
        )
    }

    @Test
    fun `never shows the JVM's own text for a request with no response`() = runTest {
        val h = harness { HttpResponse(0, "", "Unable to resolve host \"project.example.invalid\"") }
        val expected = "Could not reach the club server. Check your connection and try again. (AUTH-205)"
        assertEquals(SendCodeResult.Failed(expected), h.code.send("m@example.invalid"))
        assertEquals(VerifyCodeResult.Failed(expected), h.code.verify("m@example.invalid", "123456"))
    }

    @Test
    fun `reads otp_disabled as an unknown account`() = runTest {
        val h = harness { status(422, """{"code":"otp_disabled","msg":"Signups not allowed for otp"}""", "2024-01-01") }
        assertEquals(SendCodeResult.UnknownAccount, h.code.send("m@example.invalid"))
        assertEquals(1, h.transport.requests.size)
    }

    @Test
    fun `tries the signup type after recovery says expired or invalid`() = runTest {
        val h = harness { req ->
            when {
                req.path() == "/auth/v1/verify" && req.body!!.contains("\"recovery\"") ->
                    status(403, """{"code":"otp_expired","msg":"Token has expired or is invalid"}""", "2024-01-01")
                req.path() == "/auth/v1/verify" -> ok(session)
                else -> ok("""[{"id":"p1"}]""")
            }
        }
        assertEquals(VerifyCodeResult.SignedIn, h.code.verify("m@example.invalid", "123456"))
        assertEquals(2, h.transport.requests.count { it.path() == "/auth/v1/verify" })
        assertEquals("a", (h.sessions.state.value as AuthState.SignedIn).session.accessToken)
    }

    @Test
    fun `stops at a rate limit on the first type`() = runTest {
        val h = harness { status(429, """{"msg":"Request rate limit reached"}""") }
        val result = h.code.verify("m@example.invalid", "123456")
        assertTrue(result is VerifyCodeResult.Failed)
        assertEquals(1, h.transport.requests.size)
    }

    @Test
    fun `ends the session of an account with no player row, on this device only`() = runTest {
        val h = harness { req ->
            when {
                req.path() == "/auth/v1/verify" -> ok(session)
                req.path().startsWith("/rest/v1/players_self") -> ok("[]")
                else -> ok("")
            }
        }
        assertEquals(VerifyCodeResult.Unfinished, h.code.verify("m@example.invalid", "123456"))
        assertEquals("/auth/v1/logout?scope=local", h.transport.requests.last().path())
        assertEquals("Bearer a", h.transport.requests.last().headers["Authorization"])
        assertTrue(h.sessions.state.value is AuthState.SignedOut)
    }

    @Test
    fun `fails open when the player row cannot be read`() = runTest {
        val h = harness { req ->
            if (req.path() == "/auth/v1/verify") ok(session) else status(500, """{"message":"boom"}""")
        }
        assertEquals(VerifyCodeResult.SignedIn, h.code.verify("m@example.invalid", "123456"))
        assertTrue(h.sessions.state.value is AuthState.SignedIn)
    }
}
