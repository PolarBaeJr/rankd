import Foundation

// Port of EmailCode.kt, itself a port of the Expo app's email-code.ts and a
// mirror of apps/player/src/lib/email-code-client.ts. Keep in step with all.

enum SendCodeResult: Equatable, Sendable {
    case sent
    case unknownAccount
    case failed(String)
}

enum VerifyCodeResult: Equatable, Sendable {
    case signedIn
    /// The account has no player row: it never finished signing up on the website.
    case unfinished
    case failed(String)
}

struct EmailCode: Sendable {
    let api: GoTrueApi
    let sessions: SessionManager
    let postgrest: Postgrest
    var pause: @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0 * 1_000_000) }

    private static let retryDelayMs: UInt64 = 900

    func send(_ email: String) async throws -> SendCodeResult {
        // The auth gateway can 503 on the first request after an idle period;
        // one silent retry makes that invisible. Only that: a rate limit or an
        // unknown account would just be refused again, and cost another send.
        var error = try await api.sendOtp(email)
        if let e = error, shouldRetryOtpSend(e.message, e.code, e.status) {
            try await pause(EmailCode.retryDelayMs)
            error = try await api.sendOtp(email)
        }
        guard let error else { return .sent }
        if isUnknownAccountError(error.message, error.code) { return .unknownAccount }
        return .failed(failureMessage(error.message, error.code, error.status))
    }

    /// Tries each token type GoTrue might have issued in turn (a wrong-type
    /// attempt does not consume the token), then makes the web login's check
    /// for an unfinished account (keepIfFinished, shared with passkeys).
    func verify(_ email: String, _ token: String) async throws -> VerifyCodeResult {
        var lastError: GoTrueError?
        var session: StoredSession?
        for type in signinOtpTypes {
            switch try await api.verifyOtp(email, token: token, type: type) {
            case let .ok(value): session = value
            case let .failed(error): lastError = error
            }
            if session != nil { break }
            if !shouldTryNextOtpType(lastError?.message) { break }
        }
        guard let session else {
            let message = lastError?.message ?? ""
            return .failed(failureMessage(message.isEmpty ? "That code did not work. Request a new one." : message, lastError?.code, lastError?.status))
        }
        return try await keepIfFinished(session, api: api, sessions: sessions, postgrest: postgrest) ? .signedIn : .unfinished
    }

    /// Status 0 is a request that never got a response, and its message is the
    /// system's own, which the shared rules would pass through untouched. Said
    /// the way PasskeyApi says it instead.
    private func failureMessage(_ message: String, _ code: String?, _ status: Int?) -> String {
        if status == 0 {
            return withErrorCode("Could not reach the club server. Check your connection and try again.", "AUTH-205")
        }
        return withErrorCode(friendlyAuthError(message), authErrorCode(message, code, status: status))
    }
}
