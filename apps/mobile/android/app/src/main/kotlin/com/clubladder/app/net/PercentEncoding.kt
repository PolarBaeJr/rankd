package com.clubladder.app.net

/**
 * RFC 3986 percent-encoding: everything outside the unreserved set is encoded,
 * as UTF-8. Not URLEncoder, which writes a space as "+" (form encoding), and a
 * "+" inside a PostgREST filter value would then read back as a space.
 */
fun percentEncode(value: String): String {
    val out = StringBuilder(value.length)
    for (byte in value.toByteArray(Charsets.UTF_8)) {
        val c = byte.toInt() and 0xff
        if (isUnreserved(c)) {
            out.append(c.toChar())
        } else {
            out.append('%')
            out.append(HEX[c shr 4])
            out.append(HEX[c and 0x0f])
        }
    }
    return out.toString()
}

private const val HEX = "0123456789ABCDEF"

private fun isUnreserved(c: Int): Boolean =
    c in 'A'.code..'Z'.code ||
        c in 'a'.code..'z'.code ||
        c in '0'.code..'9'.code ||
        c == '-'.code || c == '.'.code || c == '_'.code || c == '~'.code
