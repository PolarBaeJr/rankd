package com.clubladder.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Port of the Expo app's src/lib/viewer.ts.

/** The signed-in member, as the screens need them. */
data class Viewer(
    val id: String,
    val fullName: String?,
    val status: String?,
    val isExec: Boolean?,
    val feeExempt: Boolean?,
    val avatarUrl: String?,
    val createdAt: String?,
    val handle: String?,
    val memberCode: String?,
    /** Addresses an 'eligible_only' announcement. */
    val eligibilityFlag: Boolean? = null,
)

@Serializable
internal data class PlayerSelfRow(
    val id: String? = null,
    @SerialName("full_name") val fullName: String? = null,
    val status: String? = null,
    @SerialName("is_exec") val isExec: Boolean? = null,
    @SerialName("fee_exempt") val feeExempt: Boolean? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("eligibility_flag") val eligibilityFlag: Boolean? = null,
)

@Serializable
internal data class PlayerExtraRow(
    val handle: String? = null,
    @SerialName("member_code") val memberCode: String? = null,
)

/**
 * Two reads, because neither source has everything. players_self is the
 * caller's own full row (a definer view filtered to auth.uid()); handle and
 * member_code are read from players under their own column grant, which
 * refuses select=* outright, so the columns are named.
 *
 * Null with no error means no player row: an account that never finished
 * signing up on the website.
 */
suspend fun loadViewer(postgrest: Postgrest, userId: String): Viewer? {
    val self = postgrest.maybeSingle(
        PostgrestQuery.select("players_self", "id, full_name, status, is_exec, fee_exempt, avatar_url, created_at, eligibility_flag"),
        PlayerSelfRow.serializer(),
        "your profile",
    )
    val id = self?.id ?: return null

    val extra = postgrest.maybeSingle(
        PostgrestQuery.select("players", "handle, member_code").eq("user_id", userId),
        PlayerExtraRow.serializer(),
        "your member number",
    )

    return Viewer(
        id = id,
        fullName = self.fullName,
        status = self.status,
        isExec = self.isExec,
        feeExempt = self.feeExempt,
        avatarUrl = self.avatarUrl,
        createdAt = self.createdAt,
        handle = extra?.handle,
        memberCode = extra?.memberCode,
        eligibilityFlag = self.eligibilityFlag,
    )
}

/** Approved: neither waiting for an exec nor suspended. The web's test. */
fun isApproved(viewer: Viewer): Boolean = viewer.status != "pending_approval" && viewer.status != "suspended"
