import Foundation

// Port of packages/shared/src/utils/auth-errors.ts (via AuthErrors.kt). Keep in
// step with it. The registry codes are plain strings here.

private let afterSeconds = #"after (\d+) seconds?"#
private let rateLimited = "rate|security purposes|too many"
private let expiredOrInvalid = "token has expired or is invalid"

private func isEmptyBody(_ msg: String) -> Bool { msg.isEmpty || msg == "{}" || msg == "[object Object]" }

/// A raw GoTrue message turned into something a member can act on.
func friendlyAuthError(_ message: String?) -> String {
    let msg = (message ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if isEmptyBody(msg) {
        return "Something went wrong reaching the server. Please try again in a moment."
    }
    if let seconds = firstGroup(afterSeconds, msg) {
        // Kotlin reads the digits as a BigInteger: leading zeros go, no overflow.
        var n = String(seconds.drop { $0 == "0" })
        if n.isEmpty { n = "0" }
        let plural = n == "1" ? "" : "s"
        return "A code was sent to this email moments ago. Check your inbox, or ask for a new one in \(n) second\(plural)."
    }
    if containsMatch(rateLimited, msg) {
        return "Too many attempts. Please wait a minute before trying again."
    }
    return msg
}

private let authCodes: [String: String] = [
    "over_email_send_rate_limit": "AUTH-201",
    "over_request_rate_limit": "AUTH-202",
    "otp_expired": "AUTH-203",
    "otp_disabled": "AUTH-204",
    "signup_disabled": "AUTH-204",
    "bad_oauth_state": "AUTH-206",
    "bad_oauth_callback": "AUTH-206",
    "flow_state_expired": "AUTH-206",
    "flow_state_not_found": "AUTH-206",
    "bad_code_verifier": "AUTH-206",
    "user_banned": "AUTH-207",
]

/// The registry code for an auth failure, so a banner can say which one it was.
func authErrorCode(_ message: String?, _ code: String? = nil, status: Int? = nil) -> String {
    if let code, !code.isEmpty, let mapped = authCodes[code] { return mapped }
    if let status, status >= 500 { return "AUTH-205" }
    let msg = (message ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if isEmptyBody(msg) { return "AUTH-205" }
    if containsMatch(afterSeconds, msg) { return "AUTH-201" }
    if containsMatch(rateLimited, msg) { return "AUTH-202" }
    if containsMatch(expiredOrInvalid, msg) { return "AUTH-203" }
    return "AUTH-000"
}

/// A banner's text with the code after it, for the member to quote.
func withErrorCode(_ message: String, _ code: String) -> String { "\(message) (\(code))" }

private func firstGroup(_ pattern: String, _ text: String) -> String? {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
          let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let range = Range(match.range(at: 1), in: text) else { return nil }
    return String(text[range])
}
