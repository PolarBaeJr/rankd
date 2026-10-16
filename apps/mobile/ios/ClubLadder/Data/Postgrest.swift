import Foundation

enum PostgrestResult: Equatable, Sendable {
    case ok([JSONValue])
    case failed(message: String, status: Int)
}

/// A failed read, carried to the screen as an error and never as an empty list.
struct ReadError: LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
}

/// PostgREST with the member's own JWT, so RLS is the gate exactly as it is for
/// the website's browser client. A 401 refreshes the session once and retries
/// once: a token can expire between the expiry check and the server reading it.
struct Postgrest: Sendable {
    let url: String
    let anonKey: String
    let transport: HttpTransport
    let sessions: SessionManager

    func run(_ query: PostgrestQuery) async throws -> PostgrestResult {
        let token = try await sessions.validAccessToken()
        let first = try await send(query, token)
        if first.status != 401 { return resultOf(first) }
        return resultOf(try await send(query, try await sessions.forceRefresh(rejected: token)))
    }

    /// With a token that is not (yet) the session's, for the check right after a code.
    func getWithToken(_ query: PostgrestQuery, accessToken: String) async throws -> PostgrestResult {
        resultOf(try await send(query, accessToken))
    }

    /// The rows, or a ReadError prefixed with `what`.
    func rows(_ query: PostgrestQuery, what: String) async throws -> [JSONValue] {
        switch try await run(query) {
        case let .ok(rows): return rows
        case let .failed(message, _): throw ReadError(message: "Could not read \(what): \(message)")
        }
    }

    /// Rows decoded by `decode`, or a ReadError prefixed with `what`.
    func list<T>(_ query: PostgrestQuery, what: String, _ decode: (JSONValue) throws -> T) async throws -> [T] {
        let list = try await rows(query, what: what)
        do {
            return try list.map(decode)
        } catch let error as DecodeError {
            throw ReadError(message: "Could not read \(what): \(error.message)")
        }
    }

    /// postgrest-js maybeSingle: no row is nil, one is the row, more is an error.
    func maybeSingle<T>(_ query: PostgrestQuery, what: String, _ decode: (JSONValue) throws -> T) async throws -> T? {
        let list = try await list(query, what: what, decode)
        if list.count > 1 { throw ReadError(message: "Could not read \(what): more than one row came back.") }
        return list.first
    }

    private func send(_ query: PostgrestQuery, _ token: String) async throws -> HttpResponse {
        let withBody = query.method == "POST"
        return try await transport.send(HttpRequest(
            method: query.method,
            url: url + query.pathAndQuery(),
            headers: PostgrestQuery.headers(anonKey: anonKey, accessToken: token, withBody: withBody),
            body: withBody ? query.body ?? "{}" : nil,
        ))
    }

    private func resultOf(_ response: HttpResponse) -> PostgrestResult {
        if !response.isSuccess { return .failed(message: errorMessage(response), status: response.status) }
        switch JSONValue.parse(response.body) {
        case let .array(rows)?: return .ok(rows)
        // A single-object RPC result, read as a one-row list.
        case let .some(obj) where obj.isObject: return .ok([obj])
        default: return .failed(message: "the server sent a reply this app could not read", status: response.status)
        }
    }

    private func errorMessage(_ response: HttpResponse) -> String {
        if response.status == 0 { return response.body }
        if let message = JSONValue.parse(response.body)?["message"]?.string { return message }
        let text = response.statusText.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "HTTP \(response.status)" : response.statusText
    }
}
