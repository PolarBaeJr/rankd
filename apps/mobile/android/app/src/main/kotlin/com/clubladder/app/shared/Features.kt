package com.clubladder.app.shared

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// Port of the flag half of packages/shared/src/utils/features.ts: the ids,
// featureField, DEFAULT_FEATURE_FLAGS, parseFeatureFlags and featureGate. Keep
// in step with it.
//
// holdsAccess is always false in the app. The web lets a member holding a
// page.access.<id> key see a switched-off feature's card; that needs the
// member's permission columns, which players_self does not carry, and there is
// no app route for it yet. So such a member sees less here than on the web. The
// server still refuses every write, whichever way this reads.

enum class FeatureGateDecision { ALLOW, BANNER, REDIRECT }

/** Every feature id, in the web's order, and whether it is on with no stored value. */
val FEATURES: List<Pair<String, Boolean>> = listOf(
    "sessions" to true,
    "challenges" to true,
    "tournaments" to true,
    "events" to true,
    "leaderboard" to true,
    "my_stats" to true,
    "announcements" to true,
    "fees" to true,
    "membership" to true,
    "socials" to true,
    "guest_waivers" to false,
)

fun featureField(id: String): String = "${id}_enabled"

val DEFAULT_FEATURE_FLAGS: Map<String, Boolean> = FEATURES.toMap()

/**
 * The platform_settings 'features' value. A default-on feature is off only for
 * a literal false; a default-off one is on only for a literal true. Anything
 * that is not an object reads as the defaults.
 */
fun parseFeatureFlags(value: JsonElement?): Map<String, Boolean> {
    val row = value as? JsonObject ?: JsonObject(emptyMap())
    return FEATURES.associate { (id, defaultOn) ->
        val stored = (row[featureField(id)] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        id to if (defaultOn) stored != false else stored == true
    }
}

fun featureGate(enabled: Boolean, holdsAccess: Boolean): FeatureGateDecision = when {
    enabled -> FeatureGateDecision.ALLOW
    holdsAccess -> FeatureGateDecision.BANNER
    else -> FeatureGateDecision.REDIRECT
}

/** The web's on(id), with no access keys (see the header). */
fun featureOn(flags: Map<String, Boolean>, id: String): Boolean =
    featureGate(flags[id] ?: DEFAULT_FEATURE_FLAGS[id] ?: true, holdsAccess = false) != FeatureGateDecision.REDIRECT
