import SwiftUI

enum LoadState<T> {
    case loading
    case failed(String)
    case loaded(T)
}

/// Runs a load and keeps its result, its failure and its refresh apart. The
/// loaders throw on a failed read, so an error reaches the screen as an error
/// and never as an empty list. A refresh keeps the last result on screen, and
/// a cancelled load never produces an error message.
///
/// The work runs in an unstructured Task the loader owns: `.refreshable`'s own
/// task is cancelled when the view re-renders mid-refresh, which would drop
/// the result. A screen calls `load()` from `.task(id:)`, `cancel()` from
/// `.onDisappear`, and `await refresh()` from `.refreshable`.
@MainActor
@Observable
final class Loader<T: Sendable> {
    private(set) var state: LoadState<T> = .loading
    private(set) var refreshing = false

    @ObservationIgnored private let work: @Sendable () async throws -> T
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var task: Task<Void, Never>?

    init(_ work: @escaping @Sendable () async throws -> T) {
        self.work = work
    }

    func load() {
        start()
    }

    func refresh() async {
        await start().value
    }

    func cancel() {
        task?.cancel()
        task = nil
        refreshing = false
    }

    @discardableResult
    private func start() -> Task<Void, Never> {
        task?.cancel()
        generation += 1
        let current = generation
        if case .loaded = state { refreshing = true }
        let work = self.work
        let task = Task { [weak self] in
            let outcome: Result<T, Error>
            do {
                outcome = .success(try await work())
            } catch {
                outcome = .failure(error)
            }
            guard let self, current == self.generation else { return }
            defer { self.refreshing = false }
            switch outcome {
            case let .success(value):
                self.state = .loaded(value)
            case let .failure(error):
                if error is CancellationError || Task.isCancelled { return }
                self.state = .failed(Loader.message(error))
            }
        }
        self.task = task
        return task
    }

    private static func message(_ error: Error) -> String {
        if let described = (error as? LocalizedError)?.errorDescription, !described.isEmpty { return described }
        return "Something went wrong."
    }
}
