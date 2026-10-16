import Foundation
@testable import ClubLadder

enum Fixtures {
    static let now: Int64 = 1_800_000_000
    static let clock: @Sendable () -> Int64 = { now }

    static func gotrue(_ transport: HttpTransport) -> GoTrueApi {
        GoTrueApi(url: FakeTransport.baseUrl, anonKey: "anon", transport: transport, nowEpochSec: clock)
    }

    static func manager(_ transport: HttpTransport, _ store: SessionStore) async -> SessionManager {
        let m = SessionManager(api: gotrue(transport), store: store, nowEpochSec: clock)
        await m.load()
        return m
    }

    static func postgrest(_ transport: HttpTransport, _ sessions: SessionManager) -> Postgrest {
        Postgrest(url: FakeTransport.baseUrl, anonKey: "anon", transport: transport, sessions: sessions)
    }
}

/// The parsed form of a JSON text, for comparing JSON without caring about spacing.
func json(_ text: String) -> JSONValue? { JSONValue.parse(text) }
