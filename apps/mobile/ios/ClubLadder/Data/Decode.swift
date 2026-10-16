import Foundation

/// A row that did not have the shape the app reads.
struct DecodeError: LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
}

// Row decoding by hand, with kotlinx's rules as Android configures them
// (ignoreUnknownKeys, coerceInputValues): an unknown key is ignored, a missing
// or explicit null field takes its default, a required field that is missing or
// null is an error, and a value of the wrong type is an error.
extension JSONValue {
    func object() throws -> JSONValue {
        guard isObject else { throw DecodeError(message: "expected an object") }
        return self
    }

    /// The value under `key`, nil when it is missing or null.
    private func present(_ key: String) -> JSONValue? {
        guard let value = self[key] else { return nil }
        if case .null = value { return nil }
        return value
    }

    func optString(_ key: String) throws -> String? {
        guard let value = present(key) else { return nil }
        guard let s = value.string else { throw DecodeError(message: "\(key) is not text") }
        return s
    }

    func reqString(_ key: String) throws -> String {
        guard let s = try optString(key) else { throw DecodeError(message: "\(key) is missing") }
        return s
    }

    func optBool(_ key: String) throws -> Bool? {
        guard let value = present(key) else { return nil }
        guard let b = value.bool else { throw DecodeError(message: "\(key) is not true or false") }
        return b
    }

    /// Any JSON number, or a numeric string, as kotlinx reads a Double.
    func optDouble(_ key: String) throws -> Double? {
        guard let value = present(key) else { return nil }
        if let d = value.double { return d }
        if let s = value.string, let d = Double(s) { return d }
        throw DecodeError(message: "\(key) is not a number")
    }

    /// A whole number only, as kotlinx reads an Int or a Long.
    func optInt(_ key: String) throws -> Int? {
        guard let value = present(key) else { return nil }
        if let n = value.int, let i = Int(exactly: n) { return i }
        if let s = value.string, let i = Int(s) { return i }
        throw DecodeError(message: "\(key) is not a whole number")
    }

    func reqInt(_ key: String) throws -> Int {
        guard let n = try optInt(key) else { throw DecodeError(message: "\(key) is missing") }
        return n
    }

    /// The raw value under `key`, nil when missing or null.
    func optValue(_ key: String) -> JSONValue? { present(key) }

    func reqBool(_ key: String) throws -> Bool {
        guard let b = try optBool(key) else { throw DecodeError(message: "\(key) is missing") }
        return b
    }

    func reqDouble(_ key: String) throws -> Double {
        guard let d = try optDouble(key) else { throw DecodeError(message: "\(key) is missing") }
        return d
    }

    func reqObject(_ key: String) throws -> JSONValue {
        guard let value = present(key) else { throw DecodeError(message: "\(key) is missing") }
        return try value.object()
    }
}
