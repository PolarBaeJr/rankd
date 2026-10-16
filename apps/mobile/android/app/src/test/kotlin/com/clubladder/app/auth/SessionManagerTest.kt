package com.clubladder.app.auth

import com.clubladder.app.config.SupabaseConfig
import com.clubladder.app.data.PostgrestQuery
import com.clubladder.app.data.PostgrestResult
import com.clubladder.app.data.Postgrest
import com.clubladder.app.net.FakeTransport
import com.clubladder.app.net.HttpResponse
import com.clubladder.app.net.ok
import com.clubladder.app.net.status
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionManagerTest {
    private val config = SupabaseConfig.Ok(FakeTransport.BASE_URL, "anon")
    private val now = 1_800_000_000L
    private val expired = StoredSession("old-access", "old-refresh", now - 10, "u1", null)
    private val fresh = StoredSession("fresh-access", "fresh-refresh", now + 3600, "u1", null)
    private val refreshed =
        """{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600,"user":{"id":"u1"}}"""

    private fun isRefresh(url: String) = url.contains("grant_type=refresh_token")

    private suspend fun manager(
        transport: FakeTransport,
        store: MemorySessionStore,
        io: kotlinx.coroutines.CoroutineDispatcher,
    ): SessionManager {
        val m = SessionManager(GoTrueApi(config, transport) { now }, store, { now }, io)
        m.load()
        return m
    }

    @Test
    fun `two callers on an expired session share one refresh`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val transport = FakeTransport {
            gate.await()
            ok(refreshed)
        }
        val m = manager(transport, MemorySessionStore(expired), UnconfinedTestDispatcher(testScheduler))

        val a = async { m.validAccessToken() }
        val b = async { m.validAccessToken() }
        advanceUntilIdle()
        gate.complete(Unit)

        assertEquals("new-access", a.await())
        assertEquals("new-access", b.await())
        assertEquals(1, transport.requests.count { isRefresh(it.url) })
    }

    @Test
    fun `persists the new session before publishing or returning it`() = runTest {
        val store = MemorySessionStore(expired)
        val transport = FakeTransport { ok(refreshed) }
        val m = manager(transport, store, UnconfinedTestDispatcher(testScheduler))
        var publishedAtWrite: AuthState? = null
        store.onWrite = { publishedAtWrite = m.state.value }

        val token = m.validAccessToken()

        assertEquals("new-access", token)
        assertEquals("new-refresh", store.session?.refreshToken)
        assertEquals(AuthState.SignedIn(expired), publishedAtWrite)
        assertEquals("new-access", (m.state.value as AuthState.SignedIn).session.accessToken)
    }

    @Test
    fun `keeps the session when the refresh never reached the server`() = runTest {
        val store = MemorySessionStore(expired)
        val transport = FakeTransport { HttpResponse(0, "", "Unable to resolve host") }
        val m = manager(transport, store, UnconfinedTestDispatcher(testScheduler))

        try {
            m.validAccessToken()
            fail("expected the refresh to fail")
        } catch (e: SessionRefreshException) {
            assertTrue(e.message!!.contains("Unable to resolve host"))
        }
        assertEquals(AuthState.SignedIn(expired), m.state.value)
        assertEquals(expired, store.session)
    }

    @Test
    fun `keeps the session through a gateway 5xx`() = runTest {
        val store = MemorySessionStore(expired)
        val m = manager(FakeTransport { status(503, "{}") }, store, UnconfinedTestDispatcher(testScheduler))
        try {
            m.validAccessToken()
            fail("expected the refresh to fail")
        } catch (e: SessionRefreshException) {
            // expected
        }
        assertEquals(AuthState.SignedIn(expired), m.state.value)
    }

    @Test
    fun `signs out on a refused refresh token`() = runTest {
        val store = MemorySessionStore(expired)
        val transport = FakeTransport {
            status(400, """{"code":"refresh_token_not_found","msg":"Invalid Refresh Token"}""", "2024-01-01")
        }
        val m = manager(transport, store, UnconfinedTestDispatcher(testScheduler))

        try {
            m.validAccessToken()
            fail("expected a sign-out")
        } catch (e: NotSignedInException) {
            // expected
        }
        assertEquals(AuthState.SignedOut(), m.state.value)
        assertTrue(store.cleared)
    }

    @Test
    fun `a 401 on a read refreshes once and retries once`() = runTest {
        val store = MemorySessionStore(fresh)
        var reads = 0
        val transport = FakeTransport { req ->
            when {
                isRefresh(req.url) -> ok(refreshed)
                else -> {
                    reads += 1
                    if (reads == 1) status(401, """{"message":"JWT expired"}""") else ok("""[{"id":"p1"}]""")
                }
            }
        }
        val m = manager(transport, store, UnconfinedTestDispatcher(testScheduler))
        val postgrest = Postgrest(config, transport, m)

        val result = postgrest.run(PostgrestQuery.select("players_self", "id"))

        assertTrue(result is PostgrestResult.Ok)
        assertEquals(3, transport.requests.size)
        assertEquals("Bearer fresh-access", transport.requests[0].headers["Authorization"])
        assertTrue(isRefresh(transport.requests[1].url))
        assertEquals("Bearer new-access", transport.requests[2].headers["Authorization"])
    }

    @Test
    fun `a second 401 is an error, not another refresh`() = runTest {
        val transport = FakeTransport { req ->
            if (isRefresh(req.url)) ok(refreshed) else status(401, """{"message":"JWT expired"}""")
        }
        val m = manager(transport, MemorySessionStore(fresh), UnconfinedTestDispatcher(testScheduler))

        val result = Postgrest(config, transport, m).run(PostgrestQuery.select("players_self", "id"))

        assertEquals(PostgrestResult.Failed("JWT expired", 401), result)
        assertEquals(1, transport.requests.count { isRefresh(it.url) })
    }
}
