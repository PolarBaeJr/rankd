package com.clubladder.app.data

import com.clubladder.app.net.percentEncode
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PostgrestQueryTest {
    @Test
    fun `strips whitespace from a select except inside quotes`() {
        assertEquals("id,name,\"a b\"", PostgrestQuery.cleanSelect(" id,  name,\n\"a b\" "))
    }

    @Test
    fun `encodes the RFC 3986 way, never as a form`() {
        assertEquals("a%20b%2Bc~._-", percentEncode("a b+c~._-"))
        assertEquals("%C3%A9", percentEncode("é"))
    }

    @Test
    fun `reads the viewer's own row`() {
        assertEquals(
            "/rest/v1/players_self?select=id%2Cfull_name%2Cstatus%2Cis_exec%2Cfee_exempt%2Cavatar_url%2Ccreated_at%2Celigibility_flag",
            PostgrestQuery.select("players_self", "id, full_name, status, is_exec, fee_exempt, avatar_url, created_at, eligibility_flag")
                .pathAndQuery(),
        )
    }

    @Test
    fun `reads handle and member code by user id`() {
        assertEquals(
            "/rest/v1/players?select=handle%2Cmember_code&user_id=eq.u1",
            PostgrestQuery.select("players", "handle, member_code").eq("user_id", "u1").pathAndQuery(),
        )
    }

    @Test
    fun `reads the member's fees newest first`() {
        assertEquals(
            "/rest/v1/club_fees?select=id%2Cfee_type%2Cseason_id%2Ctournament_id%2Cclub_event_id%2Camount_cents%2C" +
                "paid_at%2Cmethod%2Creference%2Ccreated_at%2Cfee_submissions%28id%2Cstatus%2Creference%2C" +
                "reject_reason%2Csubmitted_at%29&player_id=eq.p1&order=created_at.desc",
            PostgrestQuery.select("club_fees", OWN_FEE_COLUMNS).eq("player_id", "p1")
                .order("created_at", ascending = false).pathAndQuery(),
        )
    }

    @Test
    fun `deduplicates an in list and quotes a value holding a reserved character`() {
        assertEquals(
            "/rest/v1/tournaments?select=id%2Cname&id=in.%28a%2Cb%2C%22c%2Cd%22%29",
            PostgrestQuery.select("tournaments", "id, name").isIn("id", listOf("a", "b", "a", "c,d")).pathAndQuery(),
        )
    }

    @Test
    fun `calls an RPC by POST with no query string`() {
        val q = PostgrestQuery.rpc("get_leaderboard")
        assertEquals("POST", q.method)
        assertEquals("/rest/v1/rpc/get_leaderboard", q.pathAndQuery())
    }

    @Test
    fun `posts an RPC's arguments as its body`() {
        val q = PostgrestQuery.rpc(
            "get_session_attendee_counts",
            buildJsonObject { putJsonArray("p_session_ids") { add("a"); add("b") } },
        )
        assertEquals("/rest/v1/rpc/get_session_attendee_counts", q.pathAndQuery())
        assertEquals("{\"p_session_ids\":[\"a\",\"b\"]}", q.body)
        assertEquals("{}", PostgrestQuery.rpc("get_leaderboard").body)
        assertNull(PostgrestQuery.select("seasons", "id").body)
    }

    @Test
    fun `filters below a value and on null`() {
        assertEquals(
            "/rest/v1/sessions?select=id&date=lt.2026-09-01&season_id=is.null",
            PostgrestQuery.select("sessions", "id").lt("date", "2026-09-01").isNull("season_id").pathAndQuery(),
        )
    }

    @Test
    fun `keeps two or params apart and in order`() {
        assertEquals(
            "/rest/v1/announcements?select=id&or=%28a.is.null%29&or=%28b.eq.true%29",
            PostgrestQuery.select("announcements", "id").or("a.is.null").or("b.eq.true").pathAndQuery(),
        )
    }

    @Test
    fun `pages with an offset and a limit`() {
        assertEquals(
            "/rest/v1/session_rsvp?select=session_id&order=session_id.asc&offset=500&limit=500",
            PostgrestQuery.select("session_rsvp", "session_id").order("session_id", true).offset(500).limit(500).pathAndQuery(),
        )
    }

    @Test
    fun `sends the anon key and the member's token`() {
        assertEquals(
            mapOf("apikey" to "anon", "Authorization" to "Bearer tok", "Accept" to "application/json"),
            PostgrestQuery.headers("anon", "tok", withBody = false),
        )
        assertEquals("application/json", PostgrestQuery.headers("anon", "tok", withBody = true)["Content-Type"])
    }
}
