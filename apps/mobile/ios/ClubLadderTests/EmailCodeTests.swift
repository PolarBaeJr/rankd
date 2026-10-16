import XCTest
@testable import ClubLadder

// Port of EmailCodeTest.kt.
final class EmailCodeTests: XCTestCase {
    private let session = #"{"access_token":"a","refresh_token":"r","expires_in":3600,"user":{"id":"u1","email":"m@example.invalid"}}"#

    private struct Harness {
        let code: EmailCode
        let transport: FakeTransport
        let sessions: SessionManager
        let pauses: Locked<[UInt64]>
    }

    private func harness(_ respond: @escaping @Sendable (HttpRequest) async -> HttpResponse) async -> Harness {
        let transport = FakeTransport(respond)
        let sessions = await Fixtures.manager(transport, InMemorySessionStore())
        let pauses = Locked<[UInt64]>([])
        var code = EmailCode(api: Fixtures.gotrue(transport), sessions: sessions, postgrest: Fixtures.postgrest(transport, sessions))
        code.pause = { ms in pauses.update { $0.append(ms) } }
        return Harness(code: code, transport: transport, sessions: sessions, pauses: pauses)
    }

    func test_retriesAGateway503Once() async throws {
        let sends = Locked(0)
        let h = await harness { _ in
            let n = sends.update { $0 += 1; return $0 }
            return n == 1 ? status(503, "{}") : ok("{}")
        }
        let result = try await h.code.send("m@example.invalid")
        XCTAssertEqual(.sent, result)
        XCTAssertEqual(2, h.transport.requests.count)
        XCTAssertEqual([900], h.pauses.get())
    }

    func test_sendsCreateUserFalseSoAnUnknownAddressIsNeverEnrolled() async throws {
        let h = await harness { _ in ok("{}") }
        _ = try await h.code.send("m@example.invalid")
        let request = h.transport.requests[0]
        XCTAssertTrue(request.body!.contains(#""create_user":false"#))
        XCTAssertEqual("/auth/v1/otp", request.path)
        // iOS only: the whole body, byte for byte as kotlinx writes it.
        XCTAssertEqual(#"{"email":"m@example.invalid","data":{},"create_user":false,"gotrue_meta_security":{}}"#, request.body)
    }

    func test_doesNotRetryARateLimit() async throws {
        let h = await harness { _ in status(429, #"{"msg":"Email rate limit exceeded"}"#) }
        let result = try await h.code.send("m@example.invalid")
        XCTAssertEqual(1, h.transport.requests.count)
        XCTAssertEqual(.failed("Too many attempts. Please wait a minute before trying again. (AUTH-202)"), result)
    }

    func test_neverShowsTheSystemsOwnTextForARequestWithNoResponse() async throws {
        let h = await harness { _ in HttpResponse(status: 0, statusText: "", body: "A server with the specified hostname could not be found.") }
        let expected = "Could not reach the club server. Check your connection and try again. (AUTH-205)"
        let sent = try await h.code.send("m@example.invalid")
        XCTAssertEqual(.failed(expected), sent)
        let verified = try await h.code.verify("m@example.invalid", "123456")
        XCTAssertEqual(.failed(expected), verified)
    }

    func test_readsOtpDisabledAsAnUnknownAccount() async throws {
        let h = await harness { _ in status(422, #"{"code":"otp_disabled","msg":"Signups not allowed for otp"}"#, "2024-01-01") }
        let result = try await h.code.send("m@example.invalid")
        XCTAssertEqual(.unknownAccount, result)
        XCTAssertEqual(1, h.transport.requests.count)
    }

    func test_triesTheSignupTypeAfterRecoverySaysExpiredOrInvalid() async throws {
        let session = self.session
        let h = await harness { req in
            if req.path == "/auth/v1/verify" && req.body!.contains(#""recovery""#) {
                return status(403, #"{"code":"otp_expired","msg":"Token has expired or is invalid"}"#, "2024-01-01")
            }
            if req.path == "/auth/v1/verify" { return ok(session) }
            return ok(#"[{"id":"p1"}]"#)
        }
        let result = try await h.code.verify("m@example.invalid", "123456")
        XCTAssertEqual(.signedIn, result)
        XCTAssertEqual(2, h.transport.requests.filter { $0.path == "/auth/v1/verify" }.count)
        guard case let .signedIn(stored) = await h.sessions.state else { return XCTFail("not signed in") }
        XCTAssertEqual("a", stored.accessToken)
    }

    func test_stopsAtARateLimitOnTheFirstType() async throws {
        let h = await harness { _ in status(429, #"{"msg":"Request rate limit reached"}"#) }
        let result = try await h.code.verify("m@example.invalid", "123456")
        guard case .failed = result else { return XCTFail("expected a failure") }
        XCTAssertEqual(1, h.transport.requests.count)
    }

    func test_endsTheSessionOfAnAccountWithNoPlayerRowOnThisDeviceOnly() async throws {
        let session = self.session
        let h = await harness { req in
            if req.path == "/auth/v1/verify" { return ok(session) }
            if req.path.hasPrefix("/rest/v1/players_self") { return ok("[]") }
            return ok("")
        }
        let result = try await h.code.verify("m@example.invalid", "123456")
        XCTAssertEqual(.unfinished, result)
        let last = h.transport.requests.last!
        XCTAssertEqual("/auth/v1/logout?scope=local", last.path)
        XCTAssertEqual("Bearer a", last.headers["Authorization"])
        guard case .signedOut = await h.sessions.state else { return XCTFail("not signed out") }
    }

    func test_failsOpenWhenThePlayerRowCannotBeRead() async throws {
        let session = self.session
        let h = await harness { req in
            req.path == "/auth/v1/verify" ? ok(session) : status(500, #"{"message":"boom"}"#)
        }
        let result = try await h.code.verify("m@example.invalid", "123456")
        XCTAssertEqual(.signedIn, result)
        guard case .signedIn = await h.sessions.state else { return XCTFail("not signed in") }
    }
}
