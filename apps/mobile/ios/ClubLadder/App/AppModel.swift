import Observation

/// The main-actor mirror of the session manager's state, for the views.
@MainActor
@Observable
final class AppModel {
    private(set) var auth: AuthState = .loading
    /// A club website URL the system handed the app (a universal link), waiting
    /// to be routed. It stays here while signed out and is routed after sign-in.
    var pendingLink: String?

    @ObservationIgnored private var started = false

    /// Wires the manager to this model, then reads the stored session. State
    /// changes arrive in order through one stream.
    func start(_ services: Services) {
        guard !started else { return }
        started = true
        let (stream, continuation) = AsyncStream.makeStream(of: AuthState.self)
        Task {
            for await state in stream { self.auth = state }
        }
        Task {
            await services.sessions.observe { continuation.yield($0) }
            services.store.clearIfFirstLaunch()
            await services.sessions.load()
        }
    }
}
