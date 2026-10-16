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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PasskeySignInTest {
    private val site = "https://site.example.invalid"
    private val config = SupabaseConfig.Ok(FakeTransport.BASE_URL, "anon")
    private val now = 1_800_000_000L
    private val access = testJwt("""{"sub":"u1","email":"m@example.invalid"}""")
    private val session = """{"access_token":"$access","refresh_token":"r","expires_in":3600,"expires_at":1800003600,"token_type":"bearer"}"""
    private val assertion = """{"id":"cred-1","type":"public-key","response":{}}"""
    private val optionsJson = """{"challenge":"c","rpId":"example.invalid"}"""

    private class Harness(val signIn: PasskeySignIn, val transport: FakeTransport, val sessions: SessionManager, val store: MemorySessionStore)

    private suspend fun TestScope.harness(respond: suspend (HttpRequest) -> HttpResponse): Harness {
        val transport = FakeTransport(respond)
        val gotrue = GoTrueApi(config, transport) { now }
        val store = MemorySessionStore()
        val sessions = SessionManager(gotrue, store, { now }, UnconfinedTestDispatcher(testScheduler))
        sessions.load()
        val signIn = PasskeySignIn(PasskeyApi(site, transport), gotrue, sessions, Postgrest(config, transport, sessions)) { now }
        return Harness(signIn, transport, sessions, store)
    }

    private val HttpRequest.path get() = url.substringAfter(site).substringAfter(FakeTransport.BASE_URL)

    /** Options hand out tok1, tok2, ... so a retry can be told from the first attempt. */
    private fun routes(
        verify: (HttpRequest) -> HttpResponse = { ok(session) },
        playerRow: (HttpRequest) -> HttpResponse = { ok("""[{"id":"p1"}]""") },
    ): suspend (HttpRequest) -> HttpResponse {
        var issued = 0
        return { req ->
            when {
                req.path == "/api/passkey/app/login/options" -> {
                    issued += 1
                    ok("""{"options":$optionsJson,"challengeToken":"tok$issued"}""")
                }
                req.path == "/api/passkey/app/login/verify" -> verify(req)
                req.path.startsWith("/rest/v1/players_self") -> playerRow(req)
                else -> ok("")
            }
        }
    }

    private fun HttpRequest.challengeToken() =
        (Json.parseToJsonElement(body!!).jsonObject["challengeToken"] as JsonPrimitive).content

    private fun FakeTransport.verifies() = requests.filter { it.url == "$site/api/passkey/app/login/verify" }

    @Test
    fun `signs in with the session the website returns`() = runTest {
        val h = harness(routes())
        val authenticator = FakeAuthenticator(AssertionResult.Ok(assertion))
        assertEquals(PasskeySignInResult.SignedIn, h.signIn.signIn(authenticator))
        assertEquals(Json.parseToJsonElement(optionsJson), Json.parseToJsonElement(authenticator.requests.single()))
        assertEquals("tok1", h.transport.verifies().single().challengeToken())
        val stored = (h.sessions.state.value as AuthState.SignedIn).session
        assertEquals("u1", stored.userId)
        assertEquals(access, stored.accessToken)
        assertEquals(stored, h.store.session)
        val check = h.transport.requests.single { it.path.startsWith("/rest/v1/players_self") }
        assertEquals("Bearer $access", check.headers["Authorization"])
    }

    @Test
    fun `publishes the session only after the player row check`() = runTest {
        var stateDuringCheck: AuthState? = null
        lateinit var h: Harness
        h = harness(
            routes(playerRow = {
                stateDuringCheck = h.sessions.state.value
                ok("""[{"id":"p1"}]""")
            }),
        )
        h.signIn.signIn(FakeAuthenticator(AssertionResult.Ok(assertion)))
        assertTrue(stateDuringCheck is AuthState.SignedOut)
    }

    @Test
    fun `ends the session of an account with no player row, on this device only`() = runTest {
        val h = harness(routes(playerRow = { ok("[]") }))
        assertEquals(PasskeySignInResult.Unfinished, h.signIn.signIn(FakeAuthenticator(AssertionResult.Ok(assertion))))
        val last = h.transport.requests.last()
        assertEquals("/auth/v1/logout?scope=local", last.path)
        assertEquals("Bearer $access", last.headers["Authorization"])
        assertTrue(h.sessions.state.value is AuthState.SignedOut)
        assertNull(h.store.session)
    }

    @Test
    fun `fails open when the player row cannot be read`() = runTest {
        val h = harness(routes(playerRow = { status(500, """{"message":"boom"}""") }))
        assertEquals(PasskeySignInResult.SignedIn, h.signIn.signIn(FakeAuthenticator(AssertionResult.Ok(assertion))))
        assertTrue(h.sessions.state.value is AuthState.SignedIn)
    }

    @Test
    fun `a cancel says nothing and a retry fetches fresh options`() = runTest {
        val h = harness(routes())
        val authenticator = FakeAuthenticator(AssertionResult.Cancelled, AssertionResult.Ok(assertion))
        assertEquals(PasskeySignInResult.Cancelled, h.signIn.signIn(authenticator))
        assertTrue(h.transport.verifies().isEmpty())
        assertEquals(PasskeySignInResult.SignedIn, h.signIn.signIn(authenticator))
        assertEquals("tok2", h.transport.verifies().single().challengeToken())
    }

    @Test
    fun `a refused verify is retried with a new challenge, never the burned one`() = runTest {
        var verifies = 0
        val h = harness(
            routes(verify = {
                verifies += 1
                if (verifies == 1) status(400, """{"error":"Passkey sign-in failed"}""") else ok(session)
            }),
        )
        val authenticator = FakeAuthenticator(AssertionResult.Ok(assertion), AssertionResult.Ok(assertion))
        assertEquals(
            PasskeySignInResult.Failed("Signing in with your passkey did not work. Try again, or use an email code. (AUTH-208)"),
            h.signIn.signIn(authenticator),
        )
        assertEquals(PasskeySignInResult.SignedIn, h.signIn.signIn(authenticator))
        assertEquals(listOf("tok1", "tok2"), h.transport.verifies().map { it.challengeToken() })
    }

    @Test
    fun `no passkey on the phone sends no verify`() = runTest {
        val h = harness(routes())
        assertEquals(PasskeySignInResult.NoPasskey, h.signIn.signIn(FakeAuthenticator(AssertionResult.NoCredential)))
        assertTrue(h.transport.verifies().isEmpty())
    }

    @Test
    fun `an authenticator failure shows the passkey message, not its detail`() = runTest {
        val h = harness(routes())
        val result = h.signIn.signIn(FakeAuthenticator(AssertionResult.Failed("NotAllowedError")))
        assertEquals(
            PasskeySignInResult.Failed("Signing in with your passkey did not work. Try again, or use an email code. (AUTH-208)"),
            result,
        )
        assertTrue(h.transport.verifies().isEmpty())
    }

    @Test
    fun `a server without passkeys never opens the sheet`() = runTest {
        val h = harness { status(503, """{"error":"Passkeys are not configured"}""") }
        val authenticator = FakeAuthenticator()
        assertEquals(PasskeySignInResult.Unavailable, h.signIn.signIn(authenticator))
        assertTrue(authenticator.requests.isEmpty())
    }

    @Test
    fun `an unreadable verify reply signs nobody in`() = runTest {
        val h = harness(routes(verify = { ok("""{"access_token":"not-a-jwt","refresh_token":"r","expires_in":3600}""") }))
        assertEquals(
            PasskeySignInResult.Failed("The sign-in server sent a reply this app could not read. (AUTH-208)"),
            h.signIn.signIn(FakeAuthenticator(AssertionResult.Ok(assertion))),
        )
        assertTrue(h.sessions.state.value is AuthState.SignedOut)
        assertTrue(h.transport.requests.none { it.path.startsWith("/rest/v1/players_self") })
    }
}
