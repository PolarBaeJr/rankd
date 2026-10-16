import Foundation

// Port of packages/shared/src/utils/auth-otp.ts (via AuthOtp.kt). Keep in step
// with it; the reasoning behind each rule is written up there and not repeated
// here. JS `regex.test` is a search, so every match here is a search too.

/// An existing account gets a `recovery` token, an unconfirmed one `signup`.
let signinOtpTypes: [String] = ["recovery", "signup"]

func containsMatch(_ pattern: String, _ text: String) -> Bool {
    text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
}

/// Fall through to the next token type when the code did not match.
func shouldTryNextOtpType(_ message: String?) -> Bool {
    containsMatch("verification type|not found|expired or is invalid", message ?? "")
}

/// GoTrue refusing to create an account for an address it does not know.
func isUnknownAccountError(_ message: String?, _ code: String? = nil) -> Bool {
    if code == "otp_disabled" { return true }
    return containsMatch("signups? not allowed|otp[_ ]disabled", message ?? "")
}

/// Whether a failed code send is worth one silent retry: a gateway blip only.
func shouldRetryOtpSend(_ message: String?, _ code: String?, _ status: Int?) -> Bool {
    if isUnknownAccountError(message, code) { return false }
    let msg = (message ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if containsMatch(#"rate|after \d|security purposes|too many"#, msg) { return false }
    if let status, status >= 500 { return true }
    return msg.isEmpty || msg == "{}" || msg == "[object Object]"
}
