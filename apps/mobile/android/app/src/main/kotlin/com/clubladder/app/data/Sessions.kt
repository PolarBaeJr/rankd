package com.clubladder.app.data

import kotlinx.serialization.Serializable

// Port of the Expo app's src/lib/sessions.ts. Keep in step with it. The
// schedule itself now lives on the Feed (data/Feed.kt).

@Serializable
data class ActiveSeasonRow(val id: String, val name: String? = null)

/** get_active_season() returns a set; the first row is the season, none means no season. */
suspend fun loadActiveSeason(postgrest: Postgrest): ActiveSeasonRow? =
    postgrest.list(PostgrestQuery.rpc("get_active_season"), ActiveSeasonRow.serializer(), "the season").firstOrNull()
