package com.clubladder.app.shared

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors the parseFeatureFlags and featureGate cases of
// packages/shared/src/utils/__tests__/features.test.ts.
class FeaturesTest {
    private fun row(field: String, value: kotlinx.serialization.json.JsonElement) = JsonObject(mapOf(field to value))
    private val malformed = listOf(JsonPrimitive("false"), JsonPrimitive(0), JsonNull, JsonPrimitive("no"), JsonArray(emptyList()), JsonObject(emptyMap()))

    @Test
    fun `has guest waivers off and every other feature on`() {
        assertFalse(DEFAULT_FEATURE_FLAGS.getValue("guest_waivers"))
        for ((id, _) in FEATURES.filter { it.first != "guest_waivers" }) assertTrue(id, DEFAULT_FEATURE_FLAGS.getValue(id))
    }

    @Test
    fun `reads an absent row as every feature at its default`() {
        assertEquals(DEFAULT_FEATURE_FLAGS, parseFeatureFlags(null))
        assertEquals(DEFAULT_FEATURE_FLAGS, parseFeatureFlags(JsonNull))
        assertEquals(DEFAULT_FEATURE_FLAGS, parseFeatureFlags(JsonObject(emptyMap())))
    }

    @Test
    fun `switches off only the feature stored as an explicit false`() {
        val flags = parseFeatureFlags(buildJsonObject { put("tournaments_enabled", false) })
        assertFalse(flags.getValue("tournaments"))
        for ((id, _) in FEATURES.filter { it.first != "tournaments" }) assertEquals(id, DEFAULT_FEATURE_FLAGS[id], flags[id])
    }

    @Test
    fun `reads anything malformed as on`() {
        for (value in malformed) assertTrue(value.toString(), parseFeatureFlags(row("tournaments_enabled", value)).getValue("tournaments"))
        assertEquals(DEFAULT_FEATURE_FLAGS, parseFeatureFlags(JsonPrimitive("tournaments_enabled=false")))
        assertEquals(DEFAULT_FEATURE_FLAGS, parseFeatureFlags(JsonArray(listOf(JsonPrimitive(false)))))
    }

    @Test
    fun `switches guest waivers on only for a literal true`() {
        assertTrue(parseFeatureFlags(row("guest_waivers_enabled", JsonPrimitive(true))).getValue("guest_waivers"))
        val values = listOf(JsonPrimitive("true"), JsonPrimitive(1), JsonNull, JsonPrimitive("yes"), JsonArray(emptyList()), JsonObject(emptyMap()), JsonPrimitive(false))
        for (value in values) assertFalse(value.toString(), parseFeatureFlags(row("guest_waivers_enabled", value)).getValue("guest_waivers"))
    }

    @Test
    fun `round-trips the default row`() {
        val stored = JsonObject(FEATURES.associate { (id, on) -> featureField(id) to JsonPrimitive(on) })
        assertEquals(DEFAULT_FEATURE_FLAGS, parseFeatureFlags(stored))
    }

    @Test
    fun `allows an enabled feature and redirects a disabled one without access`() {
        assertEquals(FeatureGateDecision.ALLOW, featureGate(true, false))
        assertEquals(FeatureGateDecision.ALLOW, featureGate(true, true))
        assertEquals(FeatureGateDecision.REDIRECT, featureGate(false, false))
        assertEquals(FeatureGateDecision.BANNER, featureGate(false, true))
    }
}
