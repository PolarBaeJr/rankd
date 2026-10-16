import Foundation

/// RFC 3986 percent-encoding: everything outside the unreserved set is encoded,
/// as UTF-8. Not addingPercentEncoding(.urlQueryAllowed), which leaves "+" and
/// "," alone, and a "+" inside a PostgREST filter value would read back as a space.
func percentEncode(_ value: String) -> String {
    let hex = Array("0123456789ABCDEF")
    var out = ""
    out.reserveCapacity(value.utf8.count)
    for byte in value.utf8 {
        if isUnreserved(byte) {
            out.unicodeScalars.append(Unicode.Scalar(byte))
        } else {
            out.append("%")
            out.append(hex[Int(byte >> 4)])
            out.append(hex[Int(byte & 0x0F)])
        }
    }
    return out
}

private func isUnreserved(_ c: UInt8) -> Bool {
    (c >= UInt8(ascii: "A") && c <= UInt8(ascii: "Z")) ||
        (c >= UInt8(ascii: "a") && c <= UInt8(ascii: "z")) ||
        (c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9")) ||
        c == UInt8(ascii: "-") || c == UInt8(ascii: ".") || c == UInt8(ascii: "_") || c == UInt8(ascii: "~")
}
