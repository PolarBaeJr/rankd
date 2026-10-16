import Foundation

/// Why the member is back on the sign-in screen, when it is not obvious.
enum SignInNotice: Equatable, Sendable {
    case unknownAccount
    case unfinished
}

enum AuthState: Equatable, Sendable {
    case loading
    case signedOut(SignInNotice?)
    case signedIn(StoredSession)
}

/// No session, so there is no token to use.
struct NotSignedInError: LocalizedError, Equatable {
    var errorDescription: String? { "You are signed out." }
}

/// A refresh failed for a reason that says nothing about the session itself.
struct SessionRefreshError: LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
}

/// The one owner of the session. Every read of a token goes through
/// `validAccessToken`, which refreshes a token close to expiry first.
///
/// Refresh is single-flight: GoTrue rotates the refresh token on use, so two
/// refreshes racing with the same token would have the second one refused and
/// sign the member out. The lock holder re-checks expiry after acquiring it,
/// and a new session is persisted BEFORE it is published or returned, so a
/// process killed in between never wakes up holding a spent refresh token.
actor SessionManager {
    private let api: GoTrueApi
    private let store: SessionStore
    private let nowEpochSec: @Sendable () -> Int64
    private let mutex = AsyncMutex()
    private var onStateChange: (@Sendable (AuthState) -> Void)?

    private(set) var state: AuthState = .loading

    private static let refreshMarginSec: Int64 = 90

    init(api: GoTrueApi, store: SessionStore, nowEpochSec: @escaping @Sendable () -> Int64) {
        self.api = api
        self.store = store
        self.nowEpochSec = nowEpochSec
    }

    /// Called on every change, after the change is persisted. The app hops to
    /// the main actor from here.
    func observe(_ handler: @escaping @Sendable (AuthState) -> Void) {
        onStateChange = handler
        handler(state)
    }

    /// Reads the stored session once, at start.
    func load() {
        let stored = store.read()
        publish(stored.map(AuthState.signedIn) ?? .signedOut(nil))
    }

    /// A code was verified and the account checked: keep the session.
    func signedIn(_ session: StoredSession) async throws {
        try await mutex.withLock {
            try store.write(session)
            publish(.signedIn(session))
        }
    }

    func validAccessToken() async throws -> String {
        guard let current = currentSession else { throw NotSignedInError() }
        if !needsRefresh(current) { return current.accessToken }
        return try await mutex.withLock {
            guard let latest = currentSession else { throw NotSignedInError() }
            if !needsRefresh(latest) { return latest.accessToken }
            return try await refreshLocked(latest).accessToken
        }
    }

    /// The server refused `rejected` (a PostgREST 401). Refresh once, unless
    /// another caller already replaced that token while this one waited.
    func forceRefresh(rejected: String) async throws -> String {
        try await mutex.withLock {
            guard let latest = currentSession else { throw NotSignedInError() }
            if latest.accessToken != rejected { return latest.accessToken }
            return try await refreshLocked(latest).accessToken
        }
    }

    /// Ends the session on THIS phone only, and says why on the sign-in screen.
    func signOut(_ notice: SignInNotice? = nil) async {
        let session = await mutex.withLock {
            let current = currentSession
            store.clear()
            publish(.signedOut(notice))
            return current
        }
        if let session { await api.logout(session.accessToken) }
    }

    func setNotice(_ notice: SignInNotice?) {
        if case .signedOut = state { publish(.signedOut(notice)) }
    }

    private var currentSession: StoredSession? {
        if case let .signedIn(session) = state { return session }
        return nil
    }

    private func needsRefresh(_ session: StoredSession) -> Bool {
        nowEpochSec() >= session.expiresAtEpochSec - SessionManager.refreshMarginSec
    }

    private func publish(_ newState: AuthState) {
        state = newState
        onStateChange?(newState)
    }

    // Caller holds the lock.
    private func refreshLocked(_ session: StoredSession) async throws -> StoredSession {
        switch try await api.refresh(session.refreshToken) {
        case let .ok(fresh):
            try store.write(fresh)
            publish(.signedIn(fresh))
            return fresh
        case let .failed(error):
            // A 4xx is GoTrue saying the refresh token is spent or revoked: the
            // session is over. Anything else (offline, a gateway 5xx) says
            // nothing about it, so it is kept for the next attempt.
            if (400...499).contains(error.status) {
                store.clear()
                publish(.signedOut(nil))
                throw NotSignedInError()
            }
            throw SessionRefreshError(message: "Could not refresh your session: \(error.message)")
        }
    }
}
