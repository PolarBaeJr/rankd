import Foundation

/// A FIFO lock held across suspension points. An actor alone is reentrant, so
/// two refreshes could interleave at an await; this holds the second caller
/// until the first is completely done. The body runs on the caller's actor.
final class AsyncMutex: Sendable {
    private let state = State()

    func withLock<T, E: Error>(
        isolation: isolated (any Actor)? = #isolation,
        _ body: () async throws(E) -> T,
    ) async throws(E) -> T {
        await state.lock()
        let result: Result<T, E>
        do {
            result = .success(try await body())
        } catch {
            result = .failure(error)
        }
        await state.unlock()
        return try result.get()
    }

    private actor State {
        private var locked = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func lock() async {
            if !locked {
                locked = true
                return
            }
            await withCheckedContinuation { waiters.append($0) }
        }

        func unlock() {
            if waiters.isEmpty {
                locked = false
            } else {
                waiters.removeFirst().resume()
            }
        }
    }
}
