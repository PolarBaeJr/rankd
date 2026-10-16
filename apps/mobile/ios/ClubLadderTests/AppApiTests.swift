import XCTest
@testable import ClubLadder

// Port of AppApiTest.kt.
final class AppApiTests: XCTestCase {
    private let site = "https://site.example.invalid"
    private let session = StoredSession(accessToken: "access-1", refreshToken: "refresh-1", expiresAtEpochSec: Fixtures.now + 3600, userId: "u1")
    private static let refreshed = #"{"access_token":"access-2","refresh_token":"refresh-2","expires_in":3600,"user":{"id":"u1"}}"#

    private let contextBody = """
        {"playerId":"p1","standing":{"ok":true,"detail":""},"feature":"on","featureMessage":null,
           "rules":{"maxActive":3,"expiryHours":72,"eloRange":9999,"ladderRange":50},
           "quota":{"used":1,"max":3,"full":false,"ratio":0.3333},
           "opponents":[{"id":"p2","full_name":"Member Two","handle":"two","singles_elo":1012.5,"doubles_elo":null}],
           "extra":"ignored"}
        """

    private func isSite(_ r: HttpRequest) -> Bool { r.url.hasPrefix(site) }

    private func makeApi(_ respond: @escaping @Sendable (HttpRequest) async -> HttpResponse) async -> (AppApi, FakeTransport) {
        let transport = FakeTransport(respond)
        let sessions = await Fixtures.manager(transport, InMemorySessionStore(session))
        return (AppApi(siteUrl: site, transport: transport, sessions: sessions), transport)
    }

    private let args: [JSONValue] = [.string("c1")]

    private func context(_ result: AppResult<ChallengeContext>, file: StaticString = #filePath, line: UInt = #line) throws -> ChallengeContext {
        guard case let .ok(ctx) = result else {
            XCTFail("not ok: \(result)", file: file, line: line)
            throw DecodeError(message: "not ok")
        }
        return ctx
    }

    func test_sendsTheBearerOnlyAndNeverFollowsARedirect() async throws {
        let body = contextBody
        let (api, transport) = await makeApi { _ in ok(body) }
        _ = try await api.context()
        XCTAssertEqual(1, transport.requests.count)
        let r = transport.requests[0]
        XCTAssertEqual("\(site)/api/app/challenges/context", r.url)
        XCTAssertEqual("GET", r.method)
        XCTAssertEqual("Bearer access-1", r.headers["Authorization"])
        XCTAssertFalse(r.headers.keys.contains { $0.lowercased() == "apikey" })
        XCTAssertNil(r.headers["Content-Type"])
        XCTAssertFalse(r.followRedirects)
    }

    func test_decodesTheContextAHiddenEloIncluded() async throws {
        let body = contextBody
        let (api, _) = await makeApi { _ in ok(body) }
        let result = try await api.context()
        let ctx = try context(result)
        XCTAssertEqual("p1", ctx.playerId)
        XCTAssertTrue(ctx.featureOn)
        XCTAssertTrue(ctx.canIssue)
        XCTAssertEqual(72, ctx.rules.expiryHours)
        XCTAssertEqual(1, ctx.opponents.count)
        XCTAssertEqual(1012.5, ctx.opponents[0].singlesElo)
        XCTAssertNil(ctx.opponents[0].doublesElo)
    }

    func test_cannotIssueWithAFullQuotaABadStandingOrTheSwitchOff() async throws {
        let full = contextBody.replacingOccurrences(of: #""full":false"#, with: #""full":true"#)
        let (api, _) = await makeApi { _ in ok(full) }
        let fullCtx = try await api.context()
        XCTAssertFalse(try context(fullCtx).canIssue)
        let offBody = contextBody.replacingOccurrences(of: #""feature":"on""#, with: #""feature":"off""#)
        let (off, _) = await makeApi { _ in ok(offBody) }
        let offCtx = try await off.context()
        XCTAssertFalse(try context(offCtx).canIssue)
        let pausedBody = contextBody.replacingOccurrences(of: #""standing":{"ok":true"#, with: #""standing":{"ok":false"#)
        let (paused, _) = await makeApi { _ in ok(pausedBody) }
        let pausedCtx = try await paused.context()
        XCTAssertFalse(try context(pausedCtx).canIssue)
    }

    func test_postsTheArgumentsAsJsonToTheNamedAction() async throws {
        let (api, transport) = await makeApi { _ in ok(#"{"ok":true,"data":{"id":"c9"}}"#) }
        let outcome = try await api.action("acceptChallenge", args)
        guard case let .ok(data) = outcome else { return XCTFail("not ok: \(outcome)") }
        XCTAssertEqual(#"{"id":"c9"}"#, data?.serialized)
        XCTAssertEqual(1, transport.requests.count)
        let r = transport.requests[0]
        XCTAssertEqual("\(site)/api/app/actions/acceptChallenge", r.url)
        XCTAssertEqual("POST", r.method)
        XCTAssertEqual(#"{"args":["c1"]}"#, r.body)
        XCTAssertEqual("application/json", r.headers["Content-Type"])
        XCTAssertFalse(r.followRedirects)
    }

    func test_anActionWithNoDataIsStillOk() async throws {
        let (api, _) = await makeApi { _ in ok(#"{"ok":true,"data":null}"#) }
        let outcome = try await api.action("cancelChallenge", args)
        XCTAssertEqual(.ok(nil), outcome)
    }

    func test_aRefusalReadsAsTheWebsitesSentenceWithItsCode() async throws {
        let (withRef, _) = await makeApi { _ in ok(#"{"ok":false,"error":"Challenge is no longer open","code":"CHAL-004","ref":"a1b2"}"#) }
        let refused = try await withRef.action("acceptChallenge", args)
        XCTAssertEqual(.refused("Challenge is no longer open (CHAL-004.a1b2)"), refused)
        let (withCode, _) = await makeApi { _ in ok(#"{"ok":false,"error":"Not allowed","code":"CHAL-001"}"#) }
        let coded = try await withCode.action("acceptChallenge", args)
        XCTAssertEqual(.refused("Not allowed (CHAL-001)"), coded)
        let (bare, _) = await makeApi { _ in ok(#"{"ok":false}"#) }
        let plain = try await bare.action("acceptChallenge", args)
        XCTAssertEqual(.refused("Something went wrong"), plain)
    }

    func test_aWebsiteWithoutTheRoutesReadsAsNet003NeverAsAParseError() async throws {
        let replies = [
            status(307, ""),
            status(302, "<html></html>"),
            status(404, "<!DOCTYPE html><html>Not found</html>"),
            ok("<!DOCTYPE html><html>login</html>"),
            ok("[1,2]"),
        ]
        for reply in replies {
            let (api, _) = await makeApi { _ in reply }
            let outcome = try await api.action("acceptChallenge", args)
            XCTAssertEqual(.failed(AppApi.needsNewerSite), outcome)
            let ctx = try await api.context()
            XCTAssertEqual(.failed(AppApi.needsNewerSite), ctx)
        }
        XCTAssertTrue(AppApi.needsNewerSite.hasSuffix("(NET-003)"))
    }

    func test_aContextThatIsJsonOfTheWrongShapeReadsAsNet003() async throws {
        let (api, _) = await makeApi { _ in ok(#"{"hello":"world"}"#) }
        let ctx = try await api.context()
        XCTAssertEqual(.failed(AppApi.needsNewerSite), ctx)
    }

    func test_a200WithoutABooleanOkIsUnreadable() async throws {
        let (api, _) = await makeApi { _ in ok(#"{"ok":"true"}"#) }
        let quoted = try await api.action("acceptChallenge", args)
        XCTAssertEqual(.failed(AppApi.unreadable), quoted)
        let (none, _) = await makeApi { _ in ok(#"{"data":1}"#) }
        let missing = try await none.action("acceptChallenge", args)
        XCTAssertEqual(.failed(AppApi.unreadable), missing)
    }

    func test_a401RefreshesOnceAndRetriesOnce() async throws {
        let site = self.site
        let (api, transport) = await makeApi { r in
            if !r.url.hasPrefix(site) { return ok(Self.refreshed) }
            if r.headers["Authorization"] == "Bearer access-1" { return status(401, #"{"error":"Not signed in"}"#) }
            return ok(#"{"ok":true,"data":null}"#)
        }
        let outcome = try await api.action("acceptChallenge", args)
        XCTAssertEqual(.ok(nil), outcome)
        let siteRequests = transport.requests.filter { isSite($0) }
        XCTAssertEqual(["Bearer access-1", "Bearer access-2"], siteRequests.map { $0.headers["Authorization"] })
        XCTAssertEqual(1, transport.requests.filter { !isSite($0) }.count)
    }

    func test_aSecond401IsNotRetriedAgain() async throws {
        let site = self.site
        let (api, transport) = await makeApi { r in r.url.hasPrefix(site) ? status(401, "{}") : ok(Self.refreshed) }
        let outcome = try await api.action("acceptChallenge", args)
        guard case let .failed(message) = outcome else { return XCTFail("not failed: \(outcome)") }
        XCTAssertTrue(message.hasSuffix("(AUTH-101)"))
        XCTAssertEqual(2, transport.requests.filter { isSite($0) }.count)
    }

    func test_aWriteThatGotNoAnswerOrAServerErrorIsNeverRetried() async throws {
        for (reply, code) in [(status(0, ""), "NET-001"), (status(500, ""), "NET-002"), (status(502, "<html>"), "NET-002")] {
            let (api, transport) = await makeApi { _ in reply }
            let outcome = try await api.action("submitMatchResult", args)
            guard case let .failed(message) = outcome else { return XCTFail("not failed: \(outcome)") }
            XCTAssertTrue(message.hasSuffix("(\(code))"), message)
            XCTAssertEqual(1, transport.requests.count)
        }
    }

    func test_otherRefusalsCarryTheRoutesOwnError() async throws {
        let (api, _) = await makeApi { _ in status(400, #"{"error":"Bad arguments"}"#) }
        let bad = try await api.action("acceptChallenge", args)
        XCTAssertEqual(.failed("Bad arguments"), bad)
        let (limited, _) = await makeApi { _ in status(429, "") }
        let limitedOutcome = try await limited.action("acceptChallenge", args)
        guard case let .failed(message) = limitedOutcome else { return XCTFail("not failed: \(limitedOutcome)") }
        XCTAssertTrue(message.hasSuffix("(AUTH-202)"))
        let (forbidden, _) = await makeApi { _ in status(403, "<html>") }
        let ctx = try await forbidden.context()
        XCTAssertEqual(.failed("The club website refused this request (HTTP 403)."), ctx)
    }

    // iOS only: the wrappers the screens call keep cancellation apart from failure.
    func test_runActionReadsASessionErrorAsAFailureAndRethrowsCancellation() async throws {
        let signedOut = try await runAction({ _, _ in throw NotSignedInError() }, "acceptChallenge", args)
        guard case let .failed(message) = signedOut else { return XCTFail("not failed: \(signedOut)") }
        XCTAssertFalse(message.isEmpty)
        do {
            _ = try await runAction({ _, _ in throw CancellationError() }, "acceptChallenge", args)
            XCTFail("cancellation was swallowed")
        } catch is CancellationError {}
        let none = try await loadContext(nil)
        XCTAssertNil(none)
    }
}
