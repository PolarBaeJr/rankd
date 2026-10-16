import Foundation
@testable import ClubLadder

final class InMemorySessionStore: SessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var _session: StoredSession?
    private var _cleared = false
    var onWrite: (@Sendable (StoredSession) -> Void)?

    init(_ session: StoredSession? = nil) { _session = session }

    var session: StoredSession? { lock.withLock { _session } }
    var cleared: Bool { lock.withLock { _cleared } }

    func read() -> StoredSession? { session }

    func write(_ session: StoredSession) throws {
        onWrite?(session)
        lock.withLock { _session = session }
    }

    func clear() {
        lock.withLock {
            _cleared = true
            _session = nil
        }
    }
}

/// Answers each assertion request with the next queued result, and records the request.
final class FakeAuthenticator: PasskeyAuthenticator, @unchecked Sendable {
    private let queue: Locked<[AssertionResult]>
    private let recorded = Locked<[String]>([])

    init(_ results: AssertionResult...) { queue = Locked(results) }

    var requests: [String] { recorded.get() }

    func getAssertion(_ requestJson: String) async throws -> AssertionResult {
        recorded.update { $0.append(requestJson) }
        return queue.update { $0.removeFirst() }
    }
}
