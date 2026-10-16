import Foundation

// Port of SupabaseConfig.kt. The two public values the app needs to reach
// Supabase, read once at start from Info.plist. A missing value renders a
// configuration screen instead of a client pointed at nothing.

enum SupabaseConfig: Equatable, Sendable {
    case ok(url: String, anonKey: String)
    case missing([String])

    static let urlName = "BADMINTON_SUPABASE_ADDRESS"
    static let anonKeyName = "BADMINTON_SUPABASE_ANON_KEY"

    static func read(url: String?, anonKey: String?) -> SupabaseConfig {
        let trimmedUrl = (url ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedKey = (anonKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var missing: [String] = []
        // https only: the session tokens travel on every request, and a phone
        // on a club's public Wi-Fi is exactly where plain http would be read.
        if !isHttpsUrl(trimmedUrl) { missing.append(urlName) }
        if trimmedKey.isEmpty { missing.append(anonKeyName) }
        if !missing.isEmpty { return .missing(missing) }
        return .ok(url: stripTrailingSlashes(trimmedUrl), anonKey: trimmedKey)
    }
}

/// `^https://[^\s/]+`, case-insensitive: a bare "https://" has no host and fails.
func isHttpsUrl(_ value: String) -> Bool {
    value.range(of: #"^https://[^\s/]+"#, options: [.regularExpression, .caseInsensitive]) != nil
}

func stripTrailingSlashes(_ value: String) -> String {
    var s = Substring(value)
    while s.hasSuffix("/") { s = s.dropLast() }
    return String(s)
}
