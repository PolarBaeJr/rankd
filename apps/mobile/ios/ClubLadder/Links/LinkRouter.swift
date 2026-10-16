import Foundation

// Port of LinkRouter.kt: where a club website URL goes in the app, from a
// scanned QR code or from a link iOS handed over (a universal link, or the
// app's own URL scheme). Pure, so every claimed path is tested.
//
// Only the website's own origin is ours: https, the same host (case aside) and
// the same port as the build's site URL, and no user info. Anything else on
// that origin opens in the browser; any other origin is not ours at all.
//
// Keep in step with LinkRouter.kt, the Android manifest's App Links paths and
// the applinks components in apps/player/src/lib/passkey/native-apps.ts.

enum TabTarget: Equatable, Sendable { case feed, leaderboard, challenges, myStats, membership }

enum LinkRoute: Equatable, Sendable {
    case tab(TabTarget, sessionId: String? = nil)
    case challengeDetail(id: String)
    case newChallenge(opponentId: String?)
    case checkIn(token: String)
    case openInBrowser(url: String)
    case notOurs
}

enum LinkRouter {
    /// The app's own URL scheme. A link on it names a website path
    /// (`clubladder://challenges/new?opponent=<id>`) and is read as that page
    /// of the build's website. It works without a signed build, where
    /// universal links cannot.
    static let appScheme = "clubladder"

    static func parse(_ url: String, siteUrl: String?) -> LinkRoute {
        guard let siteUrl else { return .notOurs }
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let link = components(trimmed), let site = components(siteUrl), sameOrigin(link, site) else { return .notOurs }

        let path = normalisedPath(link)
        let query = queryParams(link.percentEncodedQuery)
        let segments = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)

        switch path {
        case "/leaderboard": return .tab(.leaderboard)
        case "/my-stats": return .tab(.myStats)
        // The web folded the schedule into the feed; /sessions only redirects there.
        case "/feed", "/sessions": return .tab(.feed, sessionId: query["s"].flatMap { isUuid($0) ? $0 : nil })
        case "/membership", "/fees": return .tab(.membership)
        case "/challenges": return .tab(.challenges)
        case "/challenges/new": return .newChallenge(opponentId: query["opponent"].flatMap { isUuid($0) ? $0 : nil })
        default: break
        }
        if segments.count == 2 && segments[0] == "challenges" && isUuid(segments[1]) {
            return .challengeDetail(id: segments[1])
        }
        if segments.count == 2 && segments[0] == "checkin" && isCheckinToken(segments[1]) {
            return .checkIn(token: segments[1])
        }
        return .openInBrowser(url: trimmed)
    }

    /// True for a path the website's apple-app-site-association hands to this
    /// app, whether or not the router then draws it. Such a URL must open in
    /// an in-app browser, since handing it to the system could bring it
    /// straight back here.
    static func isClaimedPath(_ url: String) -> Bool {
        guard let link = components(url) else { return false }
        let path = normalisedPath(link)
        if ["/leaderboard", "/my-stats", "/sessions", "/membership", "/fees", "/challenges", "/challenges/new"].contains(path) {
            return true
        }
        let segments = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
        guard segments.count == 2 else { return false }
        return (segments[0] == "challenges" && segments[1].count == 36) || (segments[0] == "checkin" && segments[1].count == 48)
    }

    /// A link on the app's own scheme, read as the same path on the build's
    /// website: `clubladder://challenges` is `<site>/challenges`. Nil for
    /// any other link, or when the build names no website.
    static func fromAppScheme(_ url: String, siteUrl: String?) -> String? {
        guard let siteUrl, let c = components(url.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.scheme?.lowercased() == appScheme,
              c.user == nil, c.password == nil, c.port == nil else { return nil }
        let path = (c.percentEncodedHost ?? "") + c.percentEncodedPath
        let trimmed = path.drop { $0 == "/" }
        let query = c.percentEncodedQuery.map { "?\($0)" } ?? ""
        return "\(siteUrl)/\(trimmed)\(query)"
    }

    // Postgres' uuid shape, either case, as isUuid in challenge-qr.ts.
    private static func isUuid(_ text: String) -> Bool {
        text.wholeMatch(of: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/) != nil
    }

    // CHECKIN_TOKEN_REGEX (packages/shared/src/utils/constants.ts): lower-case only.
    private static func isCheckinToken(_ text: String) -> Bool { text.wholeMatch(of: /[0-9a-f]{48}/) != nil }

    private static func components(_ text: String) -> URLComponents? {
        // java.net.URI refuses a space or other character a URI cannot hold;
        // URLComponents would quietly encode some of them.
        guard !text.isEmpty, !text.contains(where: { $0.isWhitespace || $0 == "\"" || $0 == "<" || $0 == ">" }) else { return nil }
        return URLComponents(string: text)
    }

    private static func normalisedPath(_ link: URLComponents) -> String {
        var path = link.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        return path.isEmpty ? "/" : path
    }

    private static func sameOrigin(_ link: URLComponents, _ site: URLComponents) -> Bool {
        guard link.scheme?.lowercased() == "https" else { return false }
        if link.user != nil || link.password != nil { return false }
        guard let host = link.host, !host.isEmpty, let siteHost = site.host else { return false }
        guard host.lowercased() == siteHost.lowercased() else { return false }
        return (link.port ?? 443) == (site.port ?? 443)
    }

    private static func queryParams(_ raw: String?) -> [String: String] {
        guard let raw, !raw.isEmpty else { return [:] }
        var out: [String: String] = [:]
        for pair in raw.split(separator: "&", omittingEmptySubsequences: false) {
            let key: String
            let value: String
            if let eq = pair.firstIndex(of: "=") {
                key = String(pair[..<eq])
                value = String(pair[pair.index(after: eq)...])
            } else {
                key = String(pair)
                value = ""
            }
            // The first value wins, as URLSearchParams.get does.
            if !key.isEmpty && out[key] == nil { out[key] = value }
        }
        return out
    }
}
