import XCTest
@testable import ClubLadder

// Port of SessionManagerTest.kt.
final class SessionManagerTests: XCTestCase {
    private let now = Fixtures.now
    private lazy var expired = StoredSession(accessToken: "old-access", refreshToken: "old-refresh", expiresAtEpochSec: now - 10, userId: "u1")
    private lazy var fresh = StoredSession(accessToken: "fresh-access", refreshToken: "fresh-refresh", expiresAtEpochSec: now + 3600, userId: "u1")
    private let refreshed = #"{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600,"user":{"id":"u1"}}"#

    private static func isRefresh(_ url: String) -> Bool { url.contains("grant_type=refresh_token") }

    func test_twoCallersOnAnExpiredSessionShareOneRefresh() async throws {
        let gate = AsyncGate()
        let refreshed = self.refreshed
        let transport = FakeTransport { _ in
            await gate.wait()
            return ok(refreshed)
        }
        let m = await Fixtures.manager(transport, InMemorySessionStore(expired))

        let a = Task { try await m.validAccessToken() }
        let b = Task { try await m.validAccessToken() }
        let arrived = await eventually { transport.requests.count == 1 }
        XCTAssertTrue(arrived)
        // Give the second caller time to queue behind the first.
        try await Task.sleep(nanoseconds: 50_000_000)
        await gate.open()

        let tokenA = try await a.value
        let tokenB = try await b.value
        XCTAssertEqual("new-access", tokenA)
        XCTAssertEqual("new-access", tokenB)
        XCTAssertEqual(1, transport.requests.filter { Self.isRefresh($0.url) }.count)
    }

    // Kotlin reads the published state from inside the write; an actor's state
    // cannot be read synchronously there, so the order of the two is recorded.
    func test_persistsTheNewSessionBeforePublishingOrReturningIt() async throws {
        let store = InMemorySessionStore(expired)
        let refreshed = self.refreshed
        let transport = FakeTransport { _ in ok(refreshed) }
        let m = await Fixtures.manager(transport, store)
        let events = Locked<[String]>([])
        store.onWrite = { session in events.update { $0.append("write:\(session.accessToken)") } }
        await m.observe { state in
            if case let .signedIn(session) = state { events.update { $0.append("publish:\(session.accessToken)") } }
        }
        events.update { $0.removeAll() }

        let token = try await m.validAccessToken()

        XCTAssertEqual("new-access", token)
        XCTAssertEqual("new-refresh", store.session?.refreshToken)
        XCTAssertEqual(["write:new-access", "publish:new-access"], events.get())
        let state = await m.state
        XCTAssertEqual(.signedIn(store.session!), state)
    }

    func test_keepsTheSessionWhenTheRefreshNeverReachedTheServer() async throws {
        let store = InMemorySessionStore(expired)
        let m = await Fixtures.manager(FakeTransport { _ in HttpResponse(status: 0, statusText: "", body: "Unable to resolve host") }, store)
        do {
            _ = try await m.validAccessToken()
            XCTFail("expected the refresh to fail")
        } catch let error as SessionRefreshError {
            XCTAssertTrue(error.message.contains("Unable to resolve host"))
        }
        let state = await m.state
        XCTAssertEqual(.signedIn(expired), state)
        XCTAssertEqual(expired, store.session)
    }

    func test_keepsTheSessionThroughAGateway5xx() async throws {
        let m = await Fixtures.manager(FakeTransport { _ in status(503, "{}") }, InMemorySessionStore(expired))
        do {
            _ = try await m.validAccessToken()
            XCTFail("expected the refresh to fail")
        } catch is SessionRefreshError {
            // expected
        }
        let state = await m.state
        XCTAssertEqual(.signedIn(expired), state)
    }

    func test_signsOutOnARefusedRefreshToken() async throws {
        let store = InMemorySessionStore(expired)
        let transport = FakeTransport { _ in
            status(400, #"{"code":"refresh_token_not_found","msg":"Invalid Refresh Token"}"#, "2024-01-01")
        }
        let m = await Fixtures.manager(transport, store)
        do {
            _ = try await m.validAccessToken()
            XCTFail("expected a sign-out")
        } catch is NotSignedInError {
            // expected
        }
        let state = await m.state
        XCTAssertEqual(.signedOut(nil), state)
        XCTAssertTrue(store.cleared)
    }

    func test_a401OnAReadRefreshesOnceAndRetriesOnce() async throws {
        let reads = Locked(0)
        let refreshed = self.refreshed
        let transport = FakeTransport { req in
            if Self.isRefresh(req.url) { return ok(refreshed) }
            let n = reads.update { $0 += 1; return $0 }
            return n == 1 ? status(401, #"{"message":"JWT expired"}"#) : ok(#"[{"id":"p1"}]"#)
        }
        let m = await Fixtures.manager(transport, InMemorySessionStore(fresh))
        let result = try await Fixtures.postgrest(transport, m).run(PostgrestQuery.select("players_self", "id"))

        guard case .ok = result else { return XCTFail("expected rows, got \(result)") }
        let requests = transport.requests
        XCTAssertEqual(3, requests.count)
        XCTAssertEqual("Bearer fresh-access", requests[0].headers["Authorization"])
        XCTAssertTrue(Self.isRefresh(requests[1].url))
        XCTAssertEqual("Bearer new-access", requests[2].headers["Authorization"])
    }

    func test_aSecond401IsAnErrorNotAnotherRefresh() async throws {
        let refreshed = self.refreshed
        let transport = FakeTransport { req in
            Self.isRefresh(req.url) ? ok(refreshed) : status(401, #"{"message":"JWT expired"}"#)
        }
        let m = await Fixtures.manager(transport, InMemorySessionStore(fresh))
        let result = try await Fixtures.postgrest(transport, m).run(PostgrestQuery.select("players_self", "id"))

        XCTAssertEqual(.failed(message: "JWT expired", status: 401), result)
        XCTAssertEqual(1, transport.requests.filter { Self.isRefresh($0.url) }.count)
    }
}
