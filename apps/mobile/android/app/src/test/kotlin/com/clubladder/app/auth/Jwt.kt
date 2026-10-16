package com.clubladder.app.auth

import java.util.Base64

/** An unsigned test JWT: base64url without padding, as GoTrue issues them. */
fun testJwt(payload: String): String {
    val encoder = Base64.getUrlEncoder().withoutPadding()
    fun part(json: String) = encoder.encodeToString(json.toByteArray(Charsets.UTF_8))
    return part("""{"alg":"HS256","typ":"JWT"}""") + "." + part(payload) + ".sig"
}
