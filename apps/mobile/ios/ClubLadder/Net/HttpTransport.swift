import Foundation

struct HttpRequest: Sendable, Equatable {
    var method: String
    var url: String
    var headers: [String: String]
    var body: String? = nil
    /// False for the website's app routes, where a redirect means the route is not there.
    var followRedirects: Bool = true
}

/// A response, or a request that never got one. Status 0 is a network failure,
/// with the reason in `body`: callers treat it like any other failed status
/// rather than catching an error, so no failure can pass as an empty result.
struct HttpResponse: Sendable, Equatable {
    var status: Int
    var statusText: String
    var body: String
    var apiVersion: String? = nil

    var isSuccess: Bool { (200...299).contains(status) }
}

/// The app's one seam onto the network, so the auth and data code is testable.
/// It throws only CancellationError: a task cancelled with its screen stays
/// cancelled instead of reading as "could not reach the server".
protocol HttpTransport: Sendable {
    func send(_ request: HttpRequest) async throws -> HttpResponse
}
