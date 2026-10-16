import Foundation

// Port of AppApi.kt: the club website's /api/app routes
// (apps/player/src/app/api/app/). Every write the app makes goes through them,
// so it runs the website's own server action with the website's own gates and
// side effects; nothing here writes to PostgREST directly.
//
// The app will reach websites that do not serve these routes yet. Such a
// website answers with a redirect to /login, a 404, or an HTML page, and every
// one of those reads as NET-003, never as a parse error. Redirects are never
// followed for the same reason.

struct Standing: Equatable, Sendable {
    let ok: Bool
    var detail: String = ""
}

struct ChallengeRules: Equatable, Sendable {
    let maxActive: Int
    let expiryHours: Int
    var eloRange: Int = 9999
    var ladderRange: Int = 50
}

struct ChallengeQuota: Equatable, Sendable {
    let used: Int
    let max: Int
    let full: Bool
    let ratio: Double
}

/// One /challenges/new opponent. A nil Elo is a member who hides their rating.
struct Opponent: Equatable, Sendable {
    let id: String
    var fullName: String = ""
    var handle: String? = nil
    var singlesElo: Double? = nil
    var doublesElo: Double? = nil
}

struct ChallengeContext: Equatable, Sendable {
    let playerId: String
    let standing: Standing
    let feature: String
    var featureMessage: String? = nil
    let rules: ChallengeRules
    let quota: ChallengeQuota
    var opponents: [Opponent] = []

    var featureOn: Bool { feature == "on" }

    /// The web shows the create entry points only in good standing, feature on, quota not full.
    var canIssue: Bool { standing.ok && featureOn && !quota.full }

    init(playerId: String, standing: Standing, feature: String, featureMessage: String? = nil, rules: ChallengeRules, quota: ChallengeQuota, opponents: [Opponent] = []) {
        self.playerId = playerId
        self.standing = standing
        self.feature = feature
        self.featureMessage = featureMessage
        self.rules = rules
        self.quota = quota
        self.opponents = opponents
    }

    init(json: JSONValue) throws {
        let row = try json.object()
        playerId = try row.reqString("playerId")
        let standing = try row.reqObject("standing")
        self.standing = Standing(ok: try standing.reqBool("ok"), detail: try standing.optString("detail") ?? "")
        feature = try row.reqString("feature")
        featureMessage = try row.optString("featureMessage")
        let rules = try row.reqObject("rules")
        self.rules = ChallengeRules(
            maxActive: try rules.reqInt("maxActive"),
            expiryHours: try rules.reqInt("expiryHours"),
            eloRange: try rules.optInt("eloRange") ?? 9999,
            ladderRange: try rules.optInt("ladderRange") ?? 50,
        )
        let quota = try row.reqObject("quota")
        self.quota = ChallengeQuota(
            used: try quota.reqInt("used"),
            max: try quota.reqInt("max"),
            full: try quota.reqBool("full"),
            ratio: try quota.reqDouble("ratio"),
        )
        guard let list = row.optValue("opponents") else {
            opponents = []
            return
        }
        guard let items = list.arrayValue else { throw DecodeError(message: "opponents is not a list") }
        opponents = try items.map { item in
            let o = try item.object()
            return Opponent(
                id: try o.reqString("id"),
                fullName: try o.optString("full_name") ?? "",
                handle: try o.optString("handle"),
                singlesElo: try o.optDouble("singles_elo"),
                doublesElo: try o.optDouble("doubles_elo"),
            )
        }
    }
}

enum AppResult<T: Sendable>: Sendable {
    case ok(T)
    case failed(String)
}

extension AppResult: Equatable where T: Equatable {}

enum ActionOutcome: Equatable, Sendable {
    /// The action ran. The value is its return value, when it has one.
    case ok(JSONValue?)
    /// The website said no, in a sentence for the member (a rule, not a fault).
    case refused(String)
    /// The request did not get an answer the app can trust. Nothing is retried.
    case failed(String)
}

/// Bearer only: the member's access token, and never the Supabase anon key,
/// which is for Supabase alone. A 401 refreshes the session once and retries
/// once, as PostgREST reads do; a POST that got no answer (status 0) or a 5xx
/// is NEVER retried, because the write may have landed.
///
/// Throws only what the session manager throws (signed out, a refresh that
/// could not reach the server) and cancellation.
struct AppApi: Sendable {
    static let contextPath = "/api/app/challenges/context"
    static let actionsPath = "/api/app/actions"
    static let needsNewerSite = withErrorCode("This needs a newer version of the club website.", "NET-003")
    static let unreadable = "The club website sent a reply this app could not read."

    let siteUrl: String
    let transport: HttpTransport
    let sessions: SessionManager

    func context() async throws -> AppResult<ChallengeContext> {
        let response = try await send("GET", AppApi.contextPath, nil)
        if let failure = failureOf(response) { return .failed(failure) }
        guard let obj = parseObject(response.body), let ctx = try? ChallengeContext(json: obj) else {
            return .failed(AppApi.needsNewerSite)
        }
        return .ok(ctx)
    }

    func action(_ name: String, _ args: [JSONValue]) async throws -> ActionOutcome {
        let body = JSONValue.object([("args", .array(args))]).serialized
        let response = try await send("POST", "\(AppApi.actionsPath)/\(name)", body)
        if let failure = failureOf(response) { return .failed(failure) }
        guard let obj = parseObject(response.body) else { return .failed(AppApi.needsNewerSite) }
        guard let ok = obj["ok"]?.bool else { return .failed(AppApi.unreadable) }
        if ok {
            if let data = obj["data"], data != .null { return .ok(data) }
            return .ok(nil)
        }
        let error = nonBlank(obj["error"]?.string) ?? "Something went wrong"
        let code = nonBlank(obj["code"]?.string)
        let ref = nonBlank(obj["ref"]?.string)
        let tag: String
        if let code, let ref {
            tag = " (\(code).\(ref))"
        } else if let code {
            tag = " (\(code))"
        } else {
            tag = ""
        }
        return .refused(error + tag)
    }

    private func send(_ method: String, _ path: String, _ body: String?) async throws -> HttpResponse {
        let token = try await sessions.validAccessToken()
        let first = try await transport.send(request(method, path, body, token))
        if first.status != 401 { return first }
        return try await transport.send(request(method, path, body, try await sessions.forceRefresh(rejected: token)))
    }

    private func request(_ method: String, _ path: String, _ body: String?, _ token: String) -> HttpRequest {
        var headers = ["Authorization": "Bearer \(token)", "Accept": "application/json"]
        if body != nil { headers["Content-Type"] = "application/json" }
        return HttpRequest(method: method, url: siteUrl + path, headers: headers, body: body, followRedirects: false)
    }

    /// The message for a reply that is not a readable 200, or nil when it is one.
    private func failureOf(_ response: HttpResponse) -> String? {
        let status = response.status
        if status == 0 {
            return withErrorCode("Could not reach the club website. Check your connection and try again.", "NET-001")
        }
        if (300...399).contains(status) || status == 404 { return AppApi.needsNewerSite }
        if status == 401 {
            return withErrorCode("The club website could not confirm it is you. Sign out and back in.", "AUTH-101")
        }
        if status == 429 { return withErrorCode("Too many attempts. Wait a minute and try again.", "AUTH-202") }
        if status >= 500 { return withErrorCode("The club website is not answering. Try again in a moment.", "NET-002") }
        if status != 200 {
            return nonBlank(parseObject(response.body)?["error"]?.string)
                ?? "The club website refused this request (HTTP \(status))."
        }
        return nil
    }

    private func parseObject(_ text: String) -> JSONValue? {
        guard let value = JSONValue.parse(text), value.isObject else { return nil }
        return value
    }

    private func nonBlank(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }
}

/// The context route, with a thrown session error read as a failure like any
/// other. Nil when the build has no club website to ask.
func loadContext(_ context: (@Sendable () async throws -> AppResult<ChallengeContext>)?) async throws -> AppResult<ChallengeContext>? {
    guard let context else { return nil }
    do {
        return try await context()
    } catch is CancellationError {
        throw CancellationError()
    } catch {
        return .failed(errorText(error))
    }
}

/// One write through the website, with a thrown session error read as a failure.
func runAction(_ action: @Sendable (String, [JSONValue]) async throws -> ActionOutcome, _ name: String, _ args: [JSONValue]) async throws -> ActionOutcome {
    do {
        return try await action(name, args)
    } catch is CancellationError {
        throw CancellationError()
    } catch {
        return .failed(errorText(error))
    }
}

private func errorText(_ error: Error) -> String {
    if let text = (error as? LocalizedError)?.errorDescription, !text.isEmpty { return text }
    return "Something went wrong."
}
