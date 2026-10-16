import Foundation

// The player website's two native-app passkey routes, on the wire exactly as
// apps/player/src/app/api/passkey/app/login/{options,verify}/route.ts expect
// them. Nothing here logs the options, the assertion or the tokens.

enum PasskeyOptions: Equatable, Sendable {
    /// `requestJson` goes to the authenticator as is; `challengeToken` back to verify unchanged.
    case ok(requestJson: String, challengeToken: String)
    /// 503: the server has no passkey secret. Not a fault, just no passkeys here.
    case unavailable
    case failed(String)
}

enum PasskeyVerify: Equatable, Sendable {
    /// The raw 200 body. Reading it into a session is the caller's job, so a bad one has one message.
    case ok(String)
    case failed(String)
}

/// Only Content-Type and Accept go to the website: never the Supabase anon key
/// or a bearer, which are for Supabase alone.
struct PasskeyApi: Sendable {
    let siteUrl: String
    let transport: HttpTransport

    static let failedMessage = withErrorCode(
        "Signing in with your passkey did not work. Try again, or use an email code.",
        "AUTH-208",
    )

    /// The server ignores the body, but one is sent: a POST with no body can go
    /// out with no Content-Length, and an edge can refuse that. The options
    /// object is passed through as the server wrote it, in order, never decoded
    /// into a type, so a field this app does not know still reaches the
    /// authenticator.
    func options() async throws -> PasskeyOptions {
        let response = try await post("/api/passkey/app/login/options", "{}")
        if response.status == 503 { return .unavailable }
        if !response.isSuccess { return .failed(errorMessage(response.status, verify: false)) }
        guard let obj = JSONValue.parse(response.body), obj.isObject,
              let options = obj["options"], options.isObject,
              let token = obj["challengeToken"]?.string, !token.isEmpty else {
            return .failed(PasskeyApi.failedMessage)
        }
        return .ok(requestJson: options.serialized, challengeToken: token)
    }

    /// The credential goes as a JSON OBJECT, not a string holding one: the
    /// route's schema wants an object with an id, and a string would be a
    /// silent 400. Anything that is not an object is refused here, unsent.
    func verify(_ credentialJson: String, challengeToken: String) async throws -> PasskeyVerify {
        guard let credential = JSONValue.parse(credentialJson), credential.isObject else {
            return .failed(PasskeyApi.failedMessage)
        }
        let body = JSONValue.object([
            ("credential", credential),
            ("challengeToken", .string(challengeToken)),
        ])
        let response = try await post("/api/passkey/app/login/verify", body.serialized)
        if !response.isSuccess { return .failed(errorMessage(response.status, verify: true)) }
        return .ok(response.body)
    }

    // Every server failure is the same "Passkey sign-in failed" by design, so
    // the status is all there is to go on. A verify 500 is the server failing
    // to mint the session after a good signature: a fresh attempt is the
    // answer, as it is for a 400, so it reads as a passkey failure.
    private func errorMessage(_ status: Int, verify: Bool) -> String {
        if status == 0 {
            return withErrorCode("Could not reach the club website. Check your connection and try again.", "AUTH-205")
        }
        if status == 429 { return withErrorCode("Too many attempts. Wait a minute and try again.", "AUTH-202") }
        if status >= 500 && !(verify && status == 500) {
            return withErrorCode("The sign-in service did not answer. Try again in a moment.", "AUTH-205")
        }
        return PasskeyApi.failedMessage
    }

    private func post(_ path: String, _ body: String) async throws -> HttpResponse {
        try await transport.send(HttpRequest(
            method: "POST",
            url: siteUrl + path,
            headers: [
                "Content-Type": "application/json",
                "Accept": "application/json",
            ],
            body: body,
        ))
    }
}
