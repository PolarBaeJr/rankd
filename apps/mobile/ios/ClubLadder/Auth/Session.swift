import Foundation

/// What the app keeps between launches. Only the user's id and email: nothing else is read.
struct StoredSession: Equatable, Sendable {
    var accessToken: String
    var refreshToken: String
    var expiresAtEpochSec: Int64
    var userId: String
    var email: String? = nil

    /// The stored form, with the same field names as the Android file.
    var json: JSONValue {
        var pairs: [(String, JSONValue)] = [
            ("accessToken", .string(accessToken)),
            ("refreshToken", .string(refreshToken)),
            ("expiresAtEpochSec", .int(expiresAtEpochSec)),
            ("userId", .string(userId)),
        ]
        if let email { pairs.append(("email", .string(email))) }
        return .object(pairs)
    }

    init(accessToken: String, refreshToken: String, expiresAtEpochSec: Int64, userId: String, email: String? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAtEpochSec = expiresAtEpochSec
        self.userId = userId
        self.email = email
    }

    /// Nil unless every required field is there with the right type.
    init?(json: JSONValue) {
        guard let access = json["accessToken"]?.string,
              let refresh = json["refreshToken"]?.string,
              let expires = json["expiresAtEpochSec"]?.int,
              let user = json["userId"]?.string else { return nil }
        let email = json["email"]
        if let email, email != .null, email.string == nil { return nil }
        self.init(accessToken: access, refreshToken: refresh, expiresAtEpochSec: expires, userId: user, email: email?.string)
    }
}

/// A GoTrue session response (verify, or the refresh grant). expires_at is
/// absent on some GoTrue versions, in which case expires_in counts from now, as
/// auth-js does. Nil when the body is not a session.
func parseSession(_ body: String, nowEpochSec: Int64) -> StoredSession? {
    guard let obj = JSONValue.parse(body), obj.isObject,
          let accessToken = obj["access_token"]?.string,
          let refreshToken = obj["refresh_token"]?.string,
          let user = obj["user"], user.isObject,
          let userId = user["id"]?.string,
          let expiresAt = expiresAt(obj, nowEpochSec) else { return nil }
    return StoredSession(accessToken: accessToken, refreshToken: refreshToken, expiresAtEpochSec: expiresAt, userId: userId, email: user["email"]?.string)
}

/// The passkey verify reply: a GoTrue session with no user object, so the user
/// id is the access token's `sub` claim and the email its optional `email`.
/// The JWT is read, not verified: it came over TLS from our own server, and
/// every request it is used on is checked by the server that signed it. Nil
/// when the body is not a session or the token is not a readable JWT.
func parseTokenSession(_ body: String, nowEpochSec: Int64) -> StoredSession? {
    guard let obj = JSONValue.parse(body), obj.isObject,
          let accessToken = obj["access_token"]?.string,
          let refreshToken = obj["refresh_token"]?.string,
          let claims = jwtClaims(accessToken),
          let userId = claims["sub"]?.string, !userId.isEmpty,
          let expiresAt = expiresAt(obj, nowEpochSec) else { return nil }
    return StoredSession(accessToken: accessToken, refreshToken: refreshToken, expiresAtEpochSec: expiresAt, userId: userId, email: claims["email"]?.string)
}

private func expiresAt(_ obj: JSONValue, _ now: Int64) -> Int64? {
    if let at = longOrNull(obj["expires_at"]) { return at }
    if let inSec = longOrNull(obj["expires_in"]) { return now + inSec }
    return nil
}

// kotlinx longOrNull: a whole number, from a number or a string holding one.
private func longOrNull(_ value: JSONValue?) -> Int64? {
    switch value {
    case let .int(n)?: return n
    case let .string(s)?: return Int64(s)
    default: return nil
    }
}

/// The JWT payload as an object. JWTs are base64url without padding.
func jwtClaims(_ token: String) -> JSONValue? {
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3, let data = base64UrlDecode(String(parts[1])) else { return nil }
    guard let text = String(data: data, encoding: .utf8), let claims = JSONValue.parse(text), claims.isObject else { return nil }
    return claims
}

func base64UrlDecode(_ value: String) -> Data? {
    var s = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let remainder = s.count % 4
    if remainder == 1 { return nil }
    if remainder > 0 { s += String(repeating: "=", count: 4 - remainder) }
    return Data(base64Encoded: s)
}

func base64UrlEncode(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}
