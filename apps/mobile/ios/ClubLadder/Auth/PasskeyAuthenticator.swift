import Foundation

/// The phone's half of a passkey sign-in, behind a protocol so the flow is
/// testable. The real one is ASAuthorizationAuthenticator.
protocol PasskeyAuthenticator: Sendable {
    /// `requestJson` is the server's options object, as JSON text.
    func getAssertion(_ requestJson: String) async throws -> AssertionResult
}

enum AssertionResult: Equatable, Sendable {
    /// The WebAuthn AuthenticationResponseJSON, as JSON text.
    case ok(String)
    /// The member dismissed the sheet. The only outcome that says nothing.
    case cancelled
    /// No passkey for this site on the phone.
    case noCredential
    /// No provider can do passkeys on this phone.
    case unavailable
    /// `detail` is for debugging only, never shown: the member sees one message.
    case failed(String)
}
