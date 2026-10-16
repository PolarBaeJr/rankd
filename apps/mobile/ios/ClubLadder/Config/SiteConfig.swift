import Foundation

// Port of SiteConfig.kt. The club website's base URL: the player site that
// serves the passkey routes, NOT the Supabase URL. Optional and public. Missing
// or not https reads as nil, and the app then simply offers no passkey sign-in:
// email codes still work, so this is never a configuration error.

enum SiteConfig {
    static let urlName = "BADMINTON_SITE_ADDRESS"

    static func read(_ raw: String?) -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        // https only, as for Supabase: the passkey verify reply carries the
        // session tokens.
        guard isHttpsUrl(trimmed) else { return nil }
        return stripTrailingSlashes(trimmed)
    }
}
