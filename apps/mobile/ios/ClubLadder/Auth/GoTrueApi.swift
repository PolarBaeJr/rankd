import Foundation

/// A failed auth call, read the way @supabase/auth-js reads one (handleError in
/// its fetch.ts), so the shared auth rules see the message and code they were
/// written against. Status 0 is a request that never got a response.
struct GoTrueError: Error, Equatable, Sendable {
    var message: String
    var code: String?
    var status: Int

    static func network(_ message: String) -> GoTrueError { GoTrueError(message: message, code: nil, status: 0) }

    static func from(status: Int, body: String, apiVersionHeader: String?, statusText: String) -> GoTrueError {
        if status == 0 { return network(body) }
        // Only an object or array counts.
        guard let parsed = JSONValue.parse(body), parsed.isObject || parsed.isArray else {
            // A gateway page rather than GoTrue: nothing to read but the status.
            let text = statusText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "HTTP \(status)" : statusText
            return GoTrueError(message: text, code: nil, status: status)
        }
        let isObject = parsed.isObject
        let message = ["msg", "message", "error_description", "error"]
            .lazy
            .compactMap { key -> String? in
                guard let s = parsed[key]?.string, !s.isEmpty else { return nil }
                return s
            }
            .first ?? parsed.serialized
        let code: String?
        if !isObject {
            code = nil
        } else if apiVersionAtLeast(apiVersionHeader), let c = parsed["code"]?.string {
            code = c
        } else {
            code = parsed["error_code"]?.string
        }
        return GoTrueError(message: message, code: code, status: status)
    }

    /// The header is a date, read strictly as yyyy-MM-dd the way LocalDate.parse does.
    private static func apiVersionAtLeast(_ header: String?) -> Bool {
        guard let trimmed = header?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return false }
        let parts = trimmed.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m), d >= 1, d <= daysIn(month: m, year: y) else { return false }
        return (y, m, d) >= (2024, 1, 1)
    }

    private static func daysIn(month: Int, year: Int) -> Int {
        switch month {
        case 2: return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }
}

enum GoTrueResult<T: Sendable>: Sendable {
    case ok(T)
    case failed(GoTrueError)
}

/// The four GoTrue calls the app makes, on the wire exactly as auth-js makes
/// them (GoTrueClient.ts), so the server cannot tell the clients apart.
struct GoTrueApi: Sendable {
    let url: String
    let anonKey: String
    let transport: HttpTransport
    let nowEpochSec: @Sendable () -> Int64

    /// Email a code to an EXISTING account. create_user false is the guard: left
    /// out, GoTrue mints an account for whatever address is typed. Accounts are
    /// created on the website, where the waivers are.
    func sendOtp(_ email: String) async throws -> GoTrueError? {
        let body = JSONValue.object([
            ("email", .string(email)),
            ("data", .object([])),
            ("create_user", .bool(false)),
            ("gotrue_meta_security", .object([])),
        ])
        let response = try await post("/auth/v1/otp", body.serialized, bearer: anonKey)
        return response.isSuccess ? nil : errorOf(response)
    }

    func verifyOtp(_ email: String, token: String, type: String) async throws -> GoTrueResult<StoredSession> {
        let body = JSONValue.object([
            ("email", .string(email)),
            ("token", .string(token)),
            ("type", .string(type)),
            ("gotrue_meta_security", .object([])),
        ])
        return sessionFrom(try await post("/auth/v1/verify", body.serialized, bearer: anonKey))
    }

    func refresh(_ refreshToken: String) async throws -> GoTrueResult<StoredSession> {
        let body = JSONValue.object([("refresh_token", .string(refreshToken))])
        return sessionFrom(try await post("/auth/v1/token?grant_type=refresh_token", body.serialized, bearer: anonKey))
    }

    /// Ends this device's session only (scope=local). Best effort: the caller signs out either way.
    func logout(_ accessToken: String) async {
        _ = try? await post("/auth/v1/logout?scope=local", nil, bearer: accessToken)
    }

    private func sessionFrom(_ response: HttpResponse) -> GoTrueResult<StoredSession> {
        guard response.isSuccess else { return .failed(errorOf(response)) }
        guard let session = parseSession(response.body, nowEpochSec: nowEpochSec()) else {
            return .failed(GoTrueError(message: "The sign-in server sent a reply this app could not read.", code: nil, status: response.status))
        }
        return .ok(session)
    }

    private func errorOf(_ response: HttpResponse) -> GoTrueError {
        GoTrueError.from(status: response.status, body: response.body, apiVersionHeader: response.apiVersion, statusText: response.statusText)
    }

    private func post(_ path: String, _ body: String?, bearer: String) async throws -> HttpResponse {
        try await transport.send(HttpRequest(
            method: "POST",
            url: url + path,
            headers: [
                "apikey": anonKey,
                "Authorization": "Bearer \(bearer)",
                "Content-Type": "application/json;charset=UTF-8",
                "X-Supabase-Api-Version": "2024-01-01",
            ],
            body: body,
        ))
    }
}
