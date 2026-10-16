import Foundation

/// JSON with its key order kept, parsed and printed the way kotlinx.serialization
/// does. Several requests are compared byte for byte against the Android app's,
/// so JSONSerialization (which reorders keys and turns booleans into numbers)
/// is never used.
enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([(String, JSONValue)])

    static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): return true
        case let (.bool(a), .bool(b)): return a == b
        case let (.int(a), .int(b)): return a == b
        case let (.double(a), .double(b)): return a == b
        case let (.string(a), .string(b)): return a == b
        case let (.array(a), .array(b)): return a == b
        case let (.object(a), .object(b)):
            return a.count == b.count && zip(a, b).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: return false
        }
    }

    /// The first value under [key], when this is an object.
    subscript(key: String) -> JSONValue? {
        guard case let .object(pairs) = self else { return nil }
        return pairs.first { $0.0 == key }?.1
    }

    /// A JSON string only: a number or a bool is not read as text.
    var string: String? {
        if case let .string(s) = self { return s }
        return nil
    }

    /// A JSON integer only.
    var int: Int64? {
        if case let .int(n) = self { return n }
        return nil
    }

    /// Any JSON number, an integer widened.
    var double: Double? {
        switch self {
        case let .int(n): return Double(n)
        case let .double(d): return d
        default: return nil
        }
    }

    /// Strictly true or false: never a number or the string "true".
    var bool: Bool? {
        if case let .bool(b) = self { return b }
        return nil
    }

    var objectValue: [(String, JSONValue)]? {
        if case let .object(pairs) = self { return pairs }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case let .array(items) = self { return items }
        return nil
    }

    var isObject: Bool { objectValue != nil }
    var isArray: Bool { arrayValue != nil }

    // MARK: Parsing

    /// Parses one JSON value, refusing anything after it as kotlinx's
    /// parseToJsonElement does. Nil for anything that is not JSON.
    static func parse(_ text: String) -> JSONValue? {
        var parser = Parser(bytes: Array(text.utf8))
        guard let value = parser.parseValue(depth: 0) else { return nil }
        parser.skipWhitespace()
        return parser.index == parser.bytes.count ? value : nil
    }

    private struct Parser {
        let bytes: [UInt8]
        var index = 0
        static let maxDepth = 512

        mutating func skipWhitespace() {
            while index < bytes.count {
                switch bytes[index] {
                case 0x20, 0x09, 0x0A, 0x0D: index += 1
                default: return
                }
            }
        }

        mutating func parseValue(depth: Int) -> JSONValue? {
            guard depth < Parser.maxDepth else { return nil }
            skipWhitespace()
            guard index < bytes.count else { return nil }
            switch bytes[index] {
            case UInt8(ascii: "{"): return parseObject(depth: depth)
            case UInt8(ascii: "["): return parseArray(depth: depth)
            case UInt8(ascii: "\""): return parseString().map(JSONValue.string)
            case UInt8(ascii: "t"): return literal("true", .bool(true))
            case UInt8(ascii: "f"): return literal("false", .bool(false))
            case UInt8(ascii: "n"): return literal("null", .null)
            default: return parseNumber()
            }
        }

        mutating func literal(_ word: String, _ value: JSONValue) -> JSONValue? {
            let w = Array(word.utf8)
            guard index + w.count <= bytes.count, Array(bytes[index..<index + w.count]) == w else { return nil }
            index += w.count
            return value
        }

        mutating func parseObject(depth: Int) -> JSONValue? {
            index += 1
            var pairs: [(String, JSONValue)] = []
            skipWhitespace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
                index += 1
                return .object(pairs)
            }
            while true {
                skipWhitespace()
                guard index < bytes.count, bytes[index] == UInt8(ascii: "\""), let key = parseString() else { return nil }
                skipWhitespace()
                guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { return nil }
                index += 1
                guard let value = parseValue(depth: depth + 1) else { return nil }
                // A repeated key keeps its first place and its last value, as
                // kotlinx's LinkedHashMap does.
                if let existing = pairs.firstIndex(where: { $0.0 == key }) {
                    pairs[existing].1 = value
                } else {
                    pairs.append((key, value))
                }
                skipWhitespace()
                guard index < bytes.count else { return nil }
                if bytes[index] == UInt8(ascii: ",") {
                    index += 1
                    continue
                }
                if bytes[index] == UInt8(ascii: "}") {
                    index += 1
                    return .object(pairs)
                }
                return nil
            }
        }

        mutating func parseArray(depth: Int) -> JSONValue? {
            index += 1
            var items: [JSONValue] = []
            skipWhitespace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
                index += 1
                return .array(items)
            }
            while true {
                guard let value = parseValue(depth: depth + 1) else { return nil }
                items.append(value)
                skipWhitespace()
                guard index < bytes.count else { return nil }
                if bytes[index] == UInt8(ascii: ",") {
                    index += 1
                    continue
                }
                if bytes[index] == UInt8(ascii: "]") {
                    index += 1
                    return .array(items)
                }
                return nil
            }
        }

        mutating func parseString() -> String? {
            index += 1
            var out: [UInt8] = []
            while index < bytes.count {
                let b = bytes[index]
                if b == UInt8(ascii: "\"") {
                    index += 1
                    return String(decoding: out, as: UTF8.self)
                }
                if b < 0x20 { return nil }
                if b != UInt8(ascii: "\\") {
                    out.append(b)
                    index += 1
                    continue
                }
                index += 1
                guard index < bytes.count else { return nil }
                let e = bytes[index]
                index += 1
                switch e {
                case UInt8(ascii: "\""): out.append(0x22)
                case UInt8(ascii: "\\"): out.append(0x5C)
                case UInt8(ascii: "/"): out.append(0x2F)
                case UInt8(ascii: "b"): out.append(0x08)
                case UInt8(ascii: "f"): out.append(0x0C)
                case UInt8(ascii: "n"): out.append(0x0A)
                case UInt8(ascii: "r"): out.append(0x0D)
                case UInt8(ascii: "t"): out.append(0x09)
                case UInt8(ascii: "u"):
                    guard var unit = hex4() else { return nil }
                    var scalar: Unicode.Scalar?
                    if (0xD800...0xDBFF).contains(unit),
                       index + 1 < bytes.count, bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u") {
                        let save = index
                        index += 2
                        if let low = hex4(), (0xDC00...0xDFFF).contains(low) {
                            scalar = Unicode.Scalar(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00))
                        } else {
                            index = save
                        }
                    }
                    if scalar == nil {
                        if (0xD800...0xDFFF).contains(unit) { unit = 0xFFFD }
                        scalar = Unicode.Scalar(unit)
                    }
                    out.append(contentsOf: Array(String(Character(scalar!)).utf8))
                default:
                    return nil
                }
            }
            return nil
        }

        mutating func hex4() -> UInt32? {
            guard index + 4 <= bytes.count else { return nil }
            var value: UInt32 = 0
            for _ in 0..<4 {
                let c = bytes[index]
                let digit: UInt32
                switch c {
                case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt32(c - UInt8(ascii: "0"))
                case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt32(c - UInt8(ascii: "a") + 10)
                case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt32(c - UInt8(ascii: "A") + 10)
                default: return nil
                }
                value = value * 16 + digit
                index += 1
            }
            return value
        }

        mutating func parseNumber() -> JSONValue? {
            let start = index
            var integral = true
            if index < bytes.count, bytes[index] == UInt8(ascii: "-") { index += 1 }
            guard index < bytes.count, isDigit(bytes[index]) else { return nil }
            if bytes[index] == UInt8(ascii: "0") {
                index += 1
            } else {
                while index < bytes.count, isDigit(bytes[index]) { index += 1 }
            }
            if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
                integral = false
                index += 1
                guard index < bytes.count, isDigit(bytes[index]) else { return nil }
                while index < bytes.count, isDigit(bytes[index]) { index += 1 }
            }
            if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
                integral = false
                index += 1
                if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") { index += 1 }
                guard index < bytes.count, isDigit(bytes[index]) else { return nil }
                while index < bytes.count, isDigit(bytes[index]) { index += 1 }
            }
            let text = String(decoding: bytes[start..<index], as: UTF8.self)
            if integral, let n = Int64(text) { return .int(n) }
            guard let d = Double(text) else { return nil }
            return .double(d)
        }

        func isDigit(_ b: UInt8) -> Bool { b >= UInt8(ascii: "0") && b <= UInt8(ascii: "9") }
    }

    // MARK: Printing

    /// Compact JSON, byte for byte as kotlinx prints it: no whitespace, `/`
    /// left alone, controls below 0x20 as lower-case `\u00xx`.
    var serialized: String {
        var out = ""
        write(to: &out)
        return out
    }

    private func write(to out: inout String) {
        switch self {
        case .null: out += "null"
        case let .bool(b): out += b ? "true" : "false"
        case let .int(n): out += String(n)
        case let .double(d): out += JSONValue.format(d)
        case let .string(s): JSONValue.quote(s, into: &out)
        case let .array(items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                item.write(to: &out)
            }
            out += "]"
        case let .object(pairs):
            out += "{"
            for (i, pair) in pairs.enumerated() {
                if i > 0 { out += "," }
                JSONValue.quote(pair.0, into: &out)
                out += ":"
                pair.1.write(to: &out)
            }
            out += "}"
        }
    }

    // Kotlin's Double.toString: 1.0 stays 1.0.
    private static func format(_ d: Double) -> String {
        if d.isFinite, d == d.rounded(), abs(d) < 1e7 { return String(format: "%.1f", d) }
        return "\(d)"
    }

    private static let hex = Array("0123456789abcdef")

    private static func quote(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 {
                    let v = Int(scalar.value)
                    out += "\\u00"
                    out.append(hex[v >> 4])
                    out.append(hex[v & 0xF])
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}
