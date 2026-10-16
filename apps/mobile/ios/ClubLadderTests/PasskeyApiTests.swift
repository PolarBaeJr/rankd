import XCTest
@testable import ClubLadder

// Port of PasskeyApiTest.kt.
final class PasskeyApiTests: XCTestCase {
    private let site = "https://site.example.invalid"
    private let failed = "Signing in with your passkey did not work. Try again, or use an email code. (AUTH-208)"
    private let options =
        #"{"challenge":"c1","rpId":"example.invalid","allowCredentials":[],"userVerification":"preferred","# +
        #""hints":["client-device"],"extensions":{"x":1}}"#
    private let credential = #"{"id":"cred-1","rawId":"cred-1","type":"public-key","response":{"signature":"s"}}"#

    private func api(_ respond: @escaping @Sendable () -> HttpResponse) -> (FakeTransport, PasskeyApi) {
        let transport = FakeTransport { _ in respond() }
        return (transport, PasskeyApi(siteUrl: site, transport: transport))
    }

    func test_postsAJsonBodyToTheOptionsRouteWithNoSupabaseHeaders() async throws {
        let body = #"{"options":"# + options + #","challengeToken":"tok"}"#
        let (transport, api) = api { ok(body) }
        _ = try await api.options()
        XCTAssertEqual(1, transport.requests.count)
        let request = transport.requests[0]
        XCTAssertEqual("POST", request.method)
        XCTAssertEqual("\(site)/api/passkey/app/login/options", request.url)
        XCTAssertEqual("application/json", request.headers["Content-Type"])
        XCTAssertEqual("{}", request.body)
        XCTAssertEqual(Set(["Content-Type", "Accept"]), Set(request.headers.keys))
    }

    func test_passesTheOptionsThroughUntouchedUnknownFieldsIncluded() async throws {
        let body = #"{"options":"# + options + #","challengeToken":"tok"}"#
        let (_, api) = api { ok(body) }
        guard case let .ok(requestJson, token) = try await api.options() else { return XCTFail("expected options") }
        XCTAssertEqual(json(options), json(requestJson))
        // iOS only: key order and number form survive the round trip, byte for byte.
        XCTAssertEqual(options, requestJson)
        XCTAssertEqual("tok", token)
    }

    func test_readsA503AsPasskeysUnavailable() async throws {
        let (_, api) = api { status(503, #"{"error":"Passkeys are not configured"}"#) }
        let result = try await api.options()
        XCTAssertEqual(.unavailable, result)
    }

    func test_failsAnOptionsReplyWithNoTokenOrNoOptionsObject() async throws {
        for body in [
            #"{"options":"# + options + "}",
            #"{"options":"# + options + #","challengeToken":""}"#,
            #"{"options":"x","challengeToken":"tok"}"#,
            "not json",
        ] {
            let (_, api) = api { ok(body) }
            let result = try await api.options()
            XCTAssertEqual(.failed(failed), result, body)
        }
    }

    func test_sendsTheCredentialAsAnObjectWithTheChallengeToken() async throws {
        let (transport, api) = api { ok("{}") }
        _ = try await api.verify(credential, challengeToken: "tok")
        XCTAssertEqual(1, transport.requests.count)
        let request = transport.requests[0]
        XCTAssertEqual("\(site)/api/passkey/app/login/verify", request.url)
        let body = json(request.body!)
        let sent = body?["credential"]
        XCTAssertTrue(sent?.isObject == true)
        XCTAssertEqual(.string("cred-1"), sent?["id"])
        XCTAssertEqual(json(credential), sent)
        XCTAssertEqual(.string("tok"), body?["challengeToken"])
    }

    func test_sendsNothingForACredentialThatIsNotAnObject() async throws {
        let (transport, api) = api { ok("{}") }
        let quoted = try await api.verify("\"\(credential)\"", challengeToken: "tok")
        XCTAssertEqual(.failed(failed), quoted)
        let garbage = try await api.verify("not json", challengeToken: "tok")
        XCTAssertEqual(.failed(failed), garbage)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func test_handsBackAVerify200Unread() async throws {
        let (_, api) = api { ok("anything") }
        let result = try await api.verify(credential, challengeToken: "tok")
        XCTAssertEqual(.ok("anything"), result)
    }

    func test_reads400_403AndAVerify500AsTheSamePasskeyFailure() async throws {
        for code in [400, 403, 500] {
            let (_, api) = api { status(code, #"{"error":"Passkey sign-in failed"}"#) }
            let result = try await api.verify(credential, challengeToken: "tok")
            XCTAssertEqual(.failed(failed), result, "\(code)")
        }
    }

    func test_readsA429AsARateLimit() async throws {
        let (_, api) = api { status(429, "") }
        let message = "Too many attempts. Wait a minute and try again. (AUTH-202)"
        let verified = try await api.verify(credential, challengeToken: "tok")
        XCTAssertEqual(.failed(message), verified)
        let options = try await api.options()
        XCTAssertEqual(.failed(message), options)
    }

    func test_readsNoResponseAsTheWebsiteBeingUnreachable() async throws {
        let (_, api) = api { status(0, "timeout") }
        let message = "Could not reach the club website. Check your connection and try again. (AUTH-205)"
        let options = try await api.options()
        XCTAssertEqual(.failed(message), options)
        let verified = try await api.verify(credential, challengeToken: "tok")
        XCTAssertEqual(.failed(message), verified)
    }

    func test_readsAnother5xxAsTheServiceNotAnswering() async throws {
        let message = "The sign-in service did not answer. Try again in a moment. (AUTH-205)"
        let options = try await api { status(502, "") }.1.options()
        XCTAssertEqual(.failed(message), options)
        let verified = try await api { status(503, "") }.1.verify(credential, challengeToken: "tok")
        XCTAssertEqual(.failed(message), verified)
    }
}
