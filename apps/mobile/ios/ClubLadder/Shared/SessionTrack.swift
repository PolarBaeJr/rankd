import Foundation

// Port of packages/shared/src/utils/session-track.ts, via SessionTrack.kt. Keep
// in step with it. players.status and sessions.track share two words and are
// not one enum: an allowlist of the two track statuses, everything else sees
// every track.

/// The `session_group` enum, verbatim.
let sessionTracks = ["competitive", "recreational", "all"]

/// The tracks a member of this status is shown; always a subset of sessionTracks.
func visibleTracksFor(_ status: String?) -> [String] {
    if let status, status == "competitive" || status == "recreational" { return [status, "all"] }
    return sessionTracks
}
