import XCTest
@testable import ClubLadder

// Port of PasskeySignInTest.kt.
final class PasskeySignInTests: XCTestCase {
    private static let site = "https://site.example.invalid"
    private static let access = testJwt(#"{"sub":"u1","email":"m@example.invalid"}"#)
    private static let session = #"{"access_token":""# + access + #"","refresh_token":"r","expires_in":3600,"expires_at":1800003600,"token_type":"bearer"}"#
    private static let assertion = #"{"id":"cred-1","type":"public-key","response":{}}"#
    private static let optionsJson = #"{"challenge":"c","rpId":"example.invalid"}"#

    private struct Harness {
        let signIn: PasskeySignIn
        let transport: FakeTransport
        let sessions: SessionManager
        let store: InMemorySessionStore
    }

    private func harness(_ respond: @escaping @Sendable (HttpRequest) async -> HttpResponse) async -> Harness {
        let transport = FakeTransport(respond)
        let store = InMemorySessionStore()
        let sessions = await Fixtures.manager(transport, store)
        let signIn = PasskeySignIn(
            api: PasskeyApi(siteUrl: Self.site, transport: transport),
            gotrue: Fixtures.gotrue(transport),
            sessions: sessions,
            postgrest: Fixtures.postgrest(transport, sessions),
            nowEpochSec: Fixtures.clock,
        )
        return Harness(signIn: signIn, transport: transport, sessions: sessions, store: store)
    }

    private static func sitePath(_ req: HttpRequest) -> String {
        req.url.hasPrefix(site) ? String(req.url.dropFirst(site.count)) : req.path
    }

    /// Options hand out tok1, tok2, ... so a retry can be told from the first attempt.
    private func routes(
        verify: @escaping @Sendable (HttpRequest) async -> HttpResponse = { _ in ok(PasskeySignInTests.session) },
        playerRow: @escaping @Sendable (HttpRequest) async -> HttpResponse = { _ in ok(#"[{"id":"p1"}]"#) },
    ) -> @Sendable (HttpRequest) async -> HttpResponse {
        let issued = Locked(0)
        return { req in
            let path = Self.sitePath(req)
            if path == "/api/passkey/app/login/options" {
                let n = issued.update { $0 += 1; return $0 }
                return ok(#"{"options":"# + Self.optionsJson + #","challengeToken":"tok\#(n)"}"#)
            }
            if path == "/api/passkey/app/login/verify" { return await verify(req) }
            if path.hasPrefix("/rest/v1/players_self") { return await playerRow(req) }
            return ok("")
        }
    }

    private func challengeToken(_ req: HttpRequest) -> String? { json(req.body!)?["challengeToken"]?.string }

    private func verifies(_ transport: FakeTransport) -> [HttpRequest] {
        transport.requests.filter { $0.url == "\(Self.site)/api/passkey/app/login/verify" }
    }

    func test_signsInWithTheSessionTheWebsiteReturns() async throws {
        let h = await harness(routes())
        let authenticator = FakeAuthenticator(.ok(Self.assertion))
        let result = try await h.signIn.signIn(authenticator)
        XCTAssertEqual(.signedIn, result)
        XCTAssertEqual(1, authenticator.requests.count)
        XCTAssertEqual(json(Self.optionsJson), json(authenticator.requests[0]))
        XCTAssertEqual(["tok1"], verifies(h.transport).map(challengeToken))
        guard case let .signedIn(stored) = await h.sessions.state else { return XCTFail("not signed in") }
        XCTAssertEqual("u1", stored.userId)
        XCTAssertEqual(Self.access, stored.accessToken)
        XCTAssertEqual(stored, h.store.session)
        let checks = h.transport.requests.filter { $0.path.hasPrefix("/rest/v1/players_self") }
        XCTAssertEqual(1, checks.count)
        XCTAssertEqual("Bearer \(Self.access)", checks[0].headers["Authorization"])
    }

    func test_publishesTheSessionOnlyAfterThePlayerRowCheck() async throws {
        let managerBox = Locked<SessionManager?>(nil)
        let stateDuringCheck = Locked<AuthState?>(nil)
        let h = await harness(routes(playerRow: { _ in
            if let m = managerBox.get() {
                let state = await m.state
                stateDuringCheck.update { $0 = state }
            }
            return ok(#"[{"id":"p1"}]"#)
        }))
        managerBox.update { $0 = h.sessions }
        _ = try await h.signIn.signIn(FakeAuthenticator(.ok(Self.assertion)))
        guard case .signedOut? = stateDuringCheck.get() else { return XCTFail("was \(String(describing: stateDuringCheck.get()))") }
    }

    func test_endsTheSessionOfAnAccountWithNoPlayerRowOnThisDeviceOnly() async throws {
        let h = await harness(routes(playerRow: { _ in ok("[]") }))
        let result = try await h.signIn.signIn(FakeAuthenticator(.ok(Self.assertion)))
        XCTAssertEqual(.unfinished, result)
        let last = h.transport.requests.last!
        XCTAssertEqual("/auth/v1/logout?scope=local", last.path)
        XCTAssertEqual("Bearer \(Self.access)", last.headers["Authorization"])
        guard case .signedOut = await h.sessions.state else { return XCTFail("not signed out") }
        XCTAssertNil(h.store.session)
    }

    func test_failsOpenWhenThePlayerRowCannotBeRead() async throws {
        let h = await harness(routes(playerRow: { _ in status(500, #"{"message":"boom"}"#) }))
        let result = try await h.signIn.signIn(FakeAuthenticator(.ok(Self.assertion)))
        XCTAssertEqual(.signedIn, result)
        guard case .signedIn = await h.sessions.state else { return XCTFail("not signed in") }
    }

    func test_aCancelSaysNothingAndARetryFetchesFreshOptions() async throws {
        let h = await harness(routes())
        let authenticator = FakeAuthenticator(.cancelled, .ok(Self.assertion))
        let first = try await h.signIn.signIn(authenticator)
        XCTAssertEqual(.cancelled, first)
        XCTAssertTrue(verifies(h.transport).isEmpty)
        let second = try await h.signIn.signIn(authenticator)
        XCTAssertEqual(.signedIn, second)
        XCTAssertEqual(["tok2"], verifies(h.transport).map(challengeToken))
    }

    func test_aRefusedVerifyIsRetriedWithANewChallengeNeverTheBurnedOne() async throws {
        let count = Locked(0)
        let h = await harness(routes(verify: { _ in
            let n = count.update { $0 += 1; return $0 }
            return n == 1 ? status(400, #"{"error":"Passkey sign-in failed"}"#) : ok(PasskeySignInTests.session)
        }))
        let authenticator = FakeAuthenticator(.ok(Self.assertion), .ok(Self.assertion))
        let first = try await h.signIn.signIn(authenticator)
        XCTAssertEqual(.failed("Signing in with your passkey did not work. Try again, or use an email code. (AUTH-208)"), first)
        let second = try await h.signIn.signIn(authenticator)
        XCTAssertEqual(.signedIn, second)
        XCTAssertEqual(["tok1", "tok2"], verifies(h.transport).map(challengeToken))
    }

    func test_noPasskeyOnThePhoneSendsNoVerify() async throws {
        let h = await harness(routes())
        let result = try await h.signIn.signIn(FakeAuthenticator(.noCredential))
        XCTAssertEqual(.noPasskey, result)
        XCTAssertTrue(verifies(h.transport).isEmpty)
    }

    func test_anAuthenticatorFailureShowsThePasskeyMessageNotItsDetail() async throws {
        let h = await harness(routes())
        let result = try await h.signIn.signIn(FakeAuthenticator(.failed("NotAllowedError")))
        XCTAssertEqual(.failed("Signing in with your passkey did not work. Try again, or use an email code. (AUTH-208)"), result)
        XCTAssertTrue(verifies(h.transport).isEmpty)
    }

    func test_aServerWithoutPasskeysNeverOpensTheSheet() async throws {
        let h = await harness { _ in status(503, #"{"error":"Passkeys are not configured"}"#) }
        let authenticator = FakeAuthenticator()
        let result = try await h.signIn.signIn(authenticator)
        XCTAssertEqual(.unavailable, result)
        XCTAssertTrue(authenticator.requests.isEmpty)
    }

    func test_anUnreadableVerifyReplySignsNobodyIn() async throws {
        let h = await harness(routes(verify: { _ in ok(#"{"access_token":"not-a-jwt","refresh_token":"r","expires_in":3600}"#) }))
        let result = try await h.signIn.signIn(FakeAuthenticator(.ok(Self.assertion)))
        XCTAssertEqual(.failed("The sign-in server sent a reply this app could not read. (AUTH-208)"), result)
        guard case .signedOut = await h.sessions.state else { return XCTFail("signed in") }
        XCTAssertFalse(h.transport.requests.contains { $0.path.hasPrefix("/rest/v1/players_self") })
    }
}
