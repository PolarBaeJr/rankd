import Foundation

// Port of Viewer.kt (the Expo app's src/lib/viewer.ts).

/// The signed-in member, as the screens need them.
struct Viewer: Equatable, Sendable {
    let id: String
    let fullName: String?
    let status: String?
    let isExec: Bool?
    let feeExempt: Bool?
    let avatarUrl: String?
    let createdAt: String?
    let handle: String?
    let memberCode: String?
    /// Addresses an 'eligible_only' announcement.
    var eligibilityFlag: Bool? = nil
}

/// Two reads, because neither source has everything. players_self is the
/// caller's own full row (a definer view filtered to auth.uid()); handle and
/// member_code are read from players under their own column grant, which
/// refuses select=* outright, so the columns are named.
///
/// Nil with no error means no player row: an account that never finished
/// signing up on the website.
func loadViewer(_ postgrest: Postgrest, userId: String) async throws -> Viewer? {
    let selfRow = try await postgrest.maybeSingle(
        PostgrestQuery.select("players_self", "id, full_name, status, is_exec, fee_exempt, avatar_url, created_at, eligibility_flag"),
        what: "your profile",
    ) { json in
        let row = try json.object()
        return (id: try row.optString("id"), row: Viewer(
            id: "",
            fullName: try row.optString("full_name"),
            status: try row.optString("status"),
            isExec: try row.optBool("is_exec"),
            feeExempt: try row.optBool("fee_exempt"),
            avatarUrl: try row.optString("avatar_url"),
            createdAt: try row.optString("created_at"),
            handle: nil,
            memberCode: nil,
            eligibilityFlag: try row.optBool("eligibility_flag"),
        ))
    }
    guard let id = selfRow?.id, let selfRow = selfRow?.row else { return nil }

    let extra = try await postgrest.maybeSingle(
        PostgrestQuery.select("players", "handle, member_code").eq("user_id", userId),
        what: "your member number",
    ) { json in
        let row = try json.object()
        return (handle: try row.optString("handle"), memberCode: try row.optString("member_code"))
    }

    return Viewer(
        id: id,
        fullName: selfRow.fullName,
        status: selfRow.status,
        isExec: selfRow.isExec,
        feeExempt: selfRow.feeExempt,
        avatarUrl: selfRow.avatarUrl,
        createdAt: selfRow.createdAt,
        handle: extra?.handle,
        memberCode: extra?.memberCode,
        eligibilityFlag: selfRow.eligibilityFlag,
    )
}

/// Approved: neither waiting for an exec nor suspended. The web's test.
func isApproved(_ viewer: Viewer) -> Bool { viewer.status != "pending_approval" && viewer.status != "suspended" }
