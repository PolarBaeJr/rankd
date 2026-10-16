import Foundation

/// A PostgREST read, built the way postgrest-js builds it, so both apps send the
/// server the same query. Pure: tested down to the exact query string.
struct PostgrestQuery: Sendable, Equatable {
    let method: String
    let path: String
    private let params: [Param]
    /// The JSON an RPC is posted with; nil for a read.
    let body: String?

    private struct Param: Sendable, Equatable {
        let key: String
        let value: String
    }

    private init(method: String, path: String, params: [Param], body: String? = nil) {
        self.method = method
        self.path = path
        self.params = params
        self.body = body
    }

    func eq(_ column: String, _ value: String) -> PostgrestQuery { filter(column, "eq.\(value)") }
    func gte(_ column: String, _ value: String) -> PostgrestQuery { filter(column, "gte.\(value)") }
    func lt(_ column: String, _ value: String) -> PostgrestQuery { filter(column, "lt.\(value)") }
    func isNull(_ column: String) -> PostgrestQuery { filter(column, "is.null") }
    func notIsNull(_ column: String) -> PostgrestQuery { filter(column, "not.is.null") }

    /// postgrest-js `in`: deduplicated, with a value quoted when it holds , ( or ).
    func isIn(_ column: String, _ values: [String]) -> PostgrestQuery {
        var seen = Set<String>()
        let list = values
            .filter { seen.insert($0).inserted }
            .map { $0.contains(where: { ",()".contains($0) }) ? "\"\($0)\"" : $0 }
            .joined(separator: ",")
        return filter(column, "in.(\(list))")
    }

    func or(_ filters: String) -> PostgrestQuery { param("or", "(\(filters))") }

    /// Appends to an existing order, as a second postgrest-js .order() call does.
    func order(_ column: String, ascending: Bool, nullsLast: Bool? = nil) -> PostgrestQuery {
        var term = column + (ascending ? ".asc" : ".desc")
        switch nullsLast {
        case nil: break
        case true?: term += ".nullslast"
        case false?: term += ".nullsfirst"
        }
        guard let existing = params.firstIndex(where: { $0.key == "order" }) else { return param("order", term) }
        var updated = params
        updated[existing] = Param(key: "order", value: updated[existing].value + "," + term)
        return PostgrestQuery(method: method, path: path, params: updated, body: body)
    }

    func limit(_ count: Int) -> PostgrestQuery { param("limit", String(count)) }

    /// postgrest-js range(from, to) sends offset=from and limit=to-from+1; this is the offset half.
    func offset(_ count: Int) -> PostgrestQuery { param("offset", String(count)) }

    func filter(_ column: String, _ expression: String) -> PostgrestQuery { param(column, expression) }

    /// The path and query string, percent-encoded, relative to the project URL.
    func pathAndQuery() -> String {
        if params.isEmpty { return path }
        return path + "?" + params.map { percentEncode($0.key) + "=" + percentEncode($0.value) }.joined(separator: "&")
    }

    private func param(_ key: String, _ value: String) -> PostgrestQuery {
        PostgrestQuery(method: method, path: path, params: params + [Param(key: key, value: value)], body: body)
    }

    static func select(_ table: String, _ columns: String) -> PostgrestQuery {
        PostgrestQuery(method: "GET", path: "/rest/v1/\(table)", params: [Param(key: "select", value: cleanSelect(columns))])
    }

    /// An RPC: POST with its arguments as the body, an empty object when it takes none.
    static func rpc(_ function: String, _ args: JSONValue = .object([])) -> PostgrestQuery {
        PostgrestQuery(method: "POST", path: "/rest/v1/rpc/\(function)", params: [], body: args.serialized)
    }

    /// postgrest-js strips whitespace from a select, except inside double quotes.
    static func cleanSelect(_ columns: String) -> String {
        var quoted = false
        var out = String.UnicodeScalarView()
        for c in columns.unicodeScalars {
            if " \t\n\u{0B}\u{0C}\r".unicodeScalars.contains(c) && !quoted { continue }
            if c == "\"" { quoted.toggle() }
            out.append(c)
        }
        return String(out)
    }

    static func headers(anonKey: String, accessToken: String, withBody: Bool) -> [String: String] {
        var h = [
            "apikey": anonKey,
            "Authorization": "Bearer \(accessToken)",
            "Accept": "application/json",
        ]
        if withBody { h["Content-Type"] = "application/json" }
        return h
    }
}
