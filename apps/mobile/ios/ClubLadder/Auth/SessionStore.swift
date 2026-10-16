import Foundation

/// Where the session lives between launches. Called only from SessionManager.
protocol SessionStore: Sendable {
    func read() -> StoredSession?
    func write(_ session: StoredSession) throws
    func clear()
}
