package com.clubladder.app.data

import com.clubladder.app.auth.GoTrueApi
import com.clubladder.app.auth.MemorySessionStore
import com.clubladder.app.auth.SessionManager
import com.clubladder.app.auth.StoredSession
import com.clubladder.app.config.SupabaseConfig
import com.clubladder.app.net.FakeTransport
import com.clubladder.app.net.HttpRequest
import com.clubladder.app.net.HttpResponse
import com.clubladder.app.net.ok
import com.clubladder.app.net.status
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AppApiTest {
    private val site = "https://site.example.invalid"
    private val config = SupabaseConfig.Ok(FakeTransport.BASE_URL, "anon")
    private val now = 1_800_000_000L
    private val session = StoredSession("access-1", "refresh-1", now + 3600, "u1", null)
    private val refreshed =
        """{"access_token":"access-2","refresh_token":"refresh-2","expires_in":3600,"user":{"id":"u1"}}"""

    private val contextBody =
        """{"playerId":"p1","standing":{"ok":true,"detail":""},"feature":"on","featureMessage":null,
           "rules":{"maxActive":3,"expiryHours":72,"eloRange":9999,"ladderRange":50},
           "quota":{"used":1,"max":3,"full":false,"ratio":0.3333},
           "opponents":[{"id":"p2","full_name":"Member Two","handle":"two","singles_elo":1012.5,"doubles_elo":null}],
           "extra":"ignored"}"""

    private fun isSite(r: HttpRequest) = r.url.startsWith(site)

    private suspend fun TestScope.api(respond: suspend (HttpRequest) -> HttpResponse): Pair<AppApi, FakeTransport> {
        val transport = FakeTransport(respond)
        val sessions = SessionManager(
            GoTrueApi(config, transport) { now },
            MemorySessionStore(session),
            { now },
            StandardTestDispatcher(testScheduler),
        )
        sessions.load()
        return AppApi(site, transport, sessions) to transport
    }

    private val args = JsonArray(listOf(JsonPrimitive("c1")))

    @Test
    fun `sends the bearer only, and never follows a redirect`() = runTest {
        val (api, transport) = api { ok(contextBody) }
        api.context()
        val r = transport.requests.single()
        assertEquals("$site/api/app/challenges/context", r.url)
        assertEquals("GET", r.method)
        assertEquals("Bearer access-1", r.headers["Authorization"])
        assertFalse(r.headers.keys.any { it.equals("apikey", ignoreCase = true) })
        assertNull(r.headers["Content-Type"])
        assertFalse(r.followRedirects)
    }

    @Test
    fun `decodes the context, a hidden Elo included`() = runTest {
        val (api, _) = api { ok(contextBody) }
        val ctx = (api.context() as AppResult.Ok).value
        assertEquals("p1", ctx.playerId)
        assertTrue(ctx.featureOn)
        assertTrue(ctx.canIssue)
        assertEquals(72, ctx.rules.expiryHours)
        assertEquals(1012.5, ctx.opponents.single().singlesElo)
        assertNull(ctx.opponents.single().doublesElo)
    }

    @Test
    fun `cannot issue with a full quota, a bad standing or the switch off`() = runTest {
        val (api, _) = api {
            ok(contextBody.replace(""""full":false""", """"full":true"""))
        }
        assertFalse((api.context() as AppResult.Ok).value.canIssue)
        val (off, _) = api { ok(contextBody.replace(""""feature":"on"""", """"feature":"off"""")) }
        assertFalse((off.context() as AppResult.Ok).value.canIssue)
        val (paused, _) = api { ok(contextBody.replace(""""standing":{"ok":true""", """"standing":{"ok":false""")) }
        assertFalse((paused.context() as AppResult.Ok).value.canIssue)
    }

    @Test
    fun `posts the arguments as JSON to the named action`() = runTest {
        val (api, transport) = api { ok("""{"ok":true,"data":{"id":"c9"}}""") }
        val outcome = api.action("acceptChallenge", args)
        assertEquals("""{"id":"c9"}""", (outcome as ActionOutcome.Ok).data.toString())
        val r = transport.requests.single()
        assertEquals("$site/api/app/actions/acceptChallenge", r.url)
        assertEquals("POST", r.method)
        assertEquals("""{"args":["c1"]}""", r.body)
        assertEquals("application/json", r.headers["Content-Type"])
        assertFalse(r.followRedirects)
    }

    @Test
    fun `an action with no data is still ok`() = runTest {
        val (api, _) = api { ok("""{"ok":true,"data":null}""") }
        assertNull((api.action("cancelChallenge", args) as ActionOutcome.Ok).data)
    }

    @Test
    fun `a refusal reads as the website's sentence with its code`() = runTest {
        val (withRef, _) = api { ok("""{"ok":false,"error":"Challenge is no longer open","code":"CHAL-004","ref":"a1b2"}""") }
        assertEquals(
            ActionOutcome.Refused("Challenge is no longer open (CHAL-004.a1b2)"),
            withRef.action("acceptChallenge", args),
        )
        val (withCode, _) = api { ok("""{"ok":false,"error":"Not allowed","code":"CHAL-001"}""") }
        assertEquals(ActionOutcome.Refused("Not allowed (CHAL-001)"), withCode.action("acceptChallenge", args))
        val (bare, _) = api { ok("""{"ok":false}""") }
        assertEquals(ActionOutcome.Refused("Something went wrong"), bare.action("acceptChallenge", args))
    }

    @Test
    fun `a website without the routes reads as NET-003, never as a parse error`() = runTest {
        for (reply in listOf(
            status(307, ""),
            status(302, "<html></html>"),
            status(404, "<!DOCTYPE html><html>Not found</html>"),
            ok("<!DOCTYPE html><html>login</html>"),
            ok("[1,2]"),
        )) {
            val (api, _) = api { reply }
            assertEquals(ActionOutcome.Failed(AppApi.NEEDS_NEWER_SITE), api.action("acceptChallenge", args))
            assertEquals(AppResult.Failed(AppApi.NEEDS_NEWER_SITE), api.context())
        }
        assertTrue(AppApi.NEEDS_NEWER_SITE.endsWith("(NET-003)"))
    }

    @Test
    fun `a context that is JSON of the wrong shape reads as NET-003`() = runTest {
        val (api, _) = api { ok("""{"hello":"world"}""") }
        assertEquals(AppResult.Failed(AppApi.NEEDS_NEWER_SITE), api.context())
    }

    @Test
    fun `a 200 without a boolean ok is unreadable`() = runTest {
        val (api, _) = api { ok("""{"ok":"true"}""") }
        assertEquals(ActionOutcome.Failed(AppApi.UNREADABLE), api.action("acceptChallenge", args))
        val (none, _) = api { ok("""{"data":1}""") }
        assertEquals(ActionOutcome.Failed(AppApi.UNREADABLE), none.action("acceptChallenge", args))
    }

    @Test
    fun `a 401 refreshes once and retries once`() = runTest {
        val (api, transport) = api { r ->
            when {
                !isSite(r) -> ok(refreshed)
                r.headers["Authorization"] == "Bearer access-1" -> status(401, """{"error":"Not signed in"}""")
                else -> ok("""{"ok":true,"data":null}""")
            }
        }
        assertTrue(api.action("acceptChallenge", args) is ActionOutcome.Ok)
        val site = transport.requests.filter { isSite(it) }
        assertEquals(listOf("Bearer access-1", "Bearer access-2"), site.map { it.headers["Authorization"] })
        assertEquals(1, transport.requests.count { !isSite(it) })
    }

    @Test
    fun `a second 401 is not retried again`() = runTest {
        val (api, transport) = api { r -> if (!isSite(r)) ok(refreshed) else status(401, "{}") }
        val outcome = api.action("acceptChallenge", args) as ActionOutcome.Failed
        assertTrue(outcome.message.endsWith("(AUTH-101)"))
        assertEquals(2, transport.requests.count { isSite(it) })
    }

    @Test
    fun `a write that got no answer or a server error is never retried`() = runTest {
        for ((reply, code) in listOf(status(0, "") to "NET-001", status(500, "") to "NET-002", status(502, "<html>") to "NET-002")) {
            val (api, transport) = api { reply }
            val outcome = api.action("submitMatchResult", args) as ActionOutcome.Failed
            assertTrue(outcome.message, outcome.message.endsWith("($code)"))
            assertEquals(1, transport.requests.size)
        }
    }

    @Test
    fun `other refusals carry the route's own error`() = runTest {
        val (api, _) = api { status(400, """{"error":"Bad arguments"}""") }
        assertEquals(ActionOutcome.Failed("Bad arguments"), api.action("acceptChallenge", args))
        val (limited, _) = api { status(429, "") }
        assertTrue((limited.action("acceptChallenge", args) as ActionOutcome.Failed).message.endsWith("(AUTH-202)"))
        val (forbidden, _) = api { status(403, "<html>") }
        assertEquals(
            AppResult.Failed("The club website refused this request (HTTP 403)."),
            forbidden.context(),
        )
    }
}
