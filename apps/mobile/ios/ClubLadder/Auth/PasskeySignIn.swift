import Foundation

enum PasskeySignInResult: Equatable, Sendable {
    case signedIn
    /// The account has no player row: it never finished signing up on the website.
    case unfinished
    case cancelled
    case noPasskey
    /// Passkeys cannot work here right now (server or phone); offer the email code.
    case unavailable
    case failed(String)
}

/// Options, assertion, verify, then the same unfinished-account check as the
/// email code. The verify reply is an ordinary Supabase session, kept exactly
/// as an email code's is, so refresh and sign-out need nothing new.
struct PasskeySignIn: Sendable {
    let api: PasskeyApi
    let gotrue: GoTrueApi
    let sessions: SessionManager
    let postgrest: Postgrest
    let nowEpochSec: @Sendable () -> Int64

    func signIn(_ authenticator: PasskeyAuthenticator) async throws -> PasskeySignInResult {
        // Fresh options on EVERY attempt, never cached: the server claims the
        // challenge before verifying, so any attempt (a failure, even a cancel
        // after the fetch) has burned it, and a retry with the old token fails.
        let requestJson: String
        let challengeToken: String
        switch try await api.options() {
        case let .ok(json, token):
            requestJson = json
            challengeToken = token
        case .unavailable: return .unavailable
        case let .failed(message): return .failed(message)
        }
        let assertion: String
        switch try await authenticator.getAssertion(requestJson) {
        case let .ok(json): assertion = json
        case .cancelled: return .cancelled
        case .noCredential: return .noPasskey
        case .unavailable: return .unavailable
        case .failed: return .failed(PasskeyApi.failedMessage)
        }
        let body: String
        switch try await api.verify(assertion, challengeToken: challengeToken) {
        case let .ok(text): body = text
        case let .failed(message): return .failed(message)
        }
        guard let session = parseTokenSession(body, nowEpochSec: nowEpochSec()) else {
            return .failed(withErrorCode("The sign-in server sent a reply this app could not read.", "AUTH-208"))
        }
        return try await keepIfFinished(session, api: gotrue, sessions: sessions, postgrest: postgrest) ? .signedIn : .unfinished
    }
}
