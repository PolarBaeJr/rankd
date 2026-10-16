package com.clubladder.app.auth

import com.clubladder.app.net.FakeTransport
import com.clubladder.app.net.HttpResponse
import com.clubladder.app.net.ok
import com.clubladder.app.net.status
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PasskeyApiTest {
    private val site = "https://site.example.invalid"
    private val failed = "Signing in with your passkey did not work. Try again, or use an email code. (AUTH-208)"
    private val options =
        """{"challenge":"c1","rpId":"example.invalid","allowCredentials":[],"userVerification":"preferred",""" +
            """"hints":["client-device"],"extensions":{"x":1}}"""
    private val credential = """{"id":"cred-1","rawId":"cred-1","type":"public-key","response":{"signature":"s"}}"""

    private fun api(respond: suspend () -> HttpResponse) = FakeTransport { respond() }.let { it to PasskeyApi(site, it) }

    @Test
    fun `posts a JSON body to the options route, with no Supabase headers`() = runTest {
        val (transport, api) = api { ok("""{"options":$options,"challengeToken":"tok"}""") }
        api.options()
        val request = transport.requests.single()
        assertEquals("POST", request.method)
        assertEquals("$site/api/passkey/app/login/options", request.url)
        assertEquals("application/json", request.headers["Content-Type"])
        assertEquals("{}", request.body)
        assertEquals(setOf("Content-Type", "Accept"), request.headers.keys)
    }

    @Test
    fun `passes the options through untouched, unknown fields included`() = runTest {
        val (_, api) = api { ok("""{"options":$options,"challengeToken":"tok"}""") }
        val result = api.options() as PasskeyOptions.Ok
        assertEquals(Json.parseToJsonElement(options), Json.parseToJsonElement(result.requestJson))
        assertEquals("tok", result.challengeToken)
    }

    @Test
    fun `reads a 503 as passkeys unavailable`() = runTest {
        val (_, api) = api { status(503, """{"error":"Passkeys are not configured"}""") }
        assertEquals(PasskeyOptions.Unavailable, api.options())
    }

    @Test
    fun `fails an options reply with no token or no options object`() = runTest {
        for (body in listOf(
            """{"options":$options}""",
            """{"options":$options,"challengeToken":""}""",
            """{"options":"x","challengeToken":"tok"}""",
            "not json",
        )) {
            val (_, api) = api { ok(body) }
            assertEquals(body, PasskeyOptions.Failed(failed), api.options())
        }
    }

    @Test
    fun `sends the credential as an object with the challenge token`() = runTest {
        val (transport, api) = api { ok("{}") }
        api.verify(credential, "tok")
        val request = transport.requests.single()
        assertEquals("$site/api/passkey/app/login/verify", request.url)
        val body = Json.parseToJsonElement(request.body!!).jsonObject
        val sent = body["credential"]
        assertTrue(sent is JsonObject)
        assertEquals(JsonPrimitive("cred-1"), (sent as JsonObject)["id"])
        assertEquals(Json.parseToJsonElement(credential), sent)
        assertEquals(JsonPrimitive("tok"), body["challengeToken"])
    }

    @Test
    fun `sends nothing for a credential that is not an object`() = runTest {
        val (transport, api) = api { ok("{}") }
        assertEquals(PasskeyVerify.Failed(failed), api.verify("\"$credential\"", "tok"))
        assertEquals(PasskeyVerify.Failed(failed), api.verify("not json", "tok"))
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun `hands back a verify 200 unread`() = runTest {
        val (_, api) = api { ok("anything") }
        assertEquals(PasskeyVerify.Ok("anything"), api.verify(credential, "tok"))
    }

    @Test
    fun `reads 400, 403 and a verify 500 as the same passkey failure`() = runTest {
        for (code in listOf(400, 403, 500)) {
            val (_, api) = api { status(code, """{"error":"Passkey sign-in failed"}""") }
            assertEquals("$code", PasskeyVerify.Failed(failed), api.verify(credential, "tok"))
        }
    }

    @Test
    fun `reads a 429 as a rate limit`() = runTest {
        val (_, api) = api { status(429, "") }
        assertEquals(PasskeyVerify.Failed("Too many attempts. Wait a minute and try again. (AUTH-202)"), api.verify(credential, "tok"))
        assertEquals(PasskeyOptions.Failed("Too many attempts. Wait a minute and try again. (AUTH-202)"), api.options())
    }

    @Test
    fun `reads no response as the website being unreachable`() = runTest {
        val (_, api) = api { status(0, "timeout") }
        val message = "Could not reach the club website. Check your connection and try again. (AUTH-205)"
        assertEquals(PasskeyOptions.Failed(message), api.options())
        assertEquals(PasskeyVerify.Failed(message), api.verify(credential, "tok"))
    }

    @Test
    fun `reads another 5xx as the service not answering`() = runTest {
        val message = "The sign-in service did not answer. Try again in a moment. (AUTH-205)"
        assertEquals(PasskeyOptions.Failed(message), api { status(502, "") }.second.options())
        assertEquals(PasskeyVerify.Failed(message), api { status(503, "") }.second.verify(credential, "tok"))
    }
}
