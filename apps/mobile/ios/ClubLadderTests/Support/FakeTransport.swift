import Foundation
@testable import ClubLadder

/// A value shared between a test and the @Sendable closures it hands out.
final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) { self.value = value }

    func get() -> Value { lock.withLock { value } }

    @discardableResult
    func update<R>(_ body: (inout Value) -> R) -> R { lock.withLock { body(&value) } }
}

/// Answers each request from `respond` and records it.
final class FakeTransport: HttpTransport, @unchecked Sendable {
    static let baseUrl = "https://db.example.invalid"

    private let respond: @Sendable (HttpRequest) async -> HttpResponse
    private let recorded = Locked<[HttpRequest]>([])

    init(_ respond: @escaping @Sendable (HttpRequest) async -> HttpResponse) {
        self.respond = respond
    }

    var requests: [HttpRequest] { recorded.get() }

    func send(_ request: HttpRequest) async throws -> HttpResponse {
        recorded.update { $0.append(request) }
        return await respond(request)
    }

    func paths() -> [String] { requests.map { $0.path } }
}

extension HttpRequest {
    /// The URL with the fake Supabase base removed.
    var path: String {
        url.hasPrefix(FakeTransport.baseUrl) ? String(url.dropFirst(FakeTransport.baseUrl.count)) : url
    }
}

func ok(_ body: String) -> HttpResponse { HttpResponse(status: 200, statusText: "OK", body: body) }

func status(_ code: Int, _ body: String, _ apiVersion: String? = nil) -> HttpResponse {
    HttpResponse(status: code, statusText: "", body: body, apiVersion: apiVersion)
}

/// An unsigned test JWT: base64url without padding, as GoTrue issues them.
func testJwt(_ payload: String) -> String {
    func part(_ json: String) -> String { base64UrlEncode(Data(json.utf8)) }
    return part(#"{"alg":"HS256","typ":"JWT"}"#) + "." + part(payload) + ".sig"
}
