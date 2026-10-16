package com.clubladder.app.net

data class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String? = null,
    /** False for the website's app routes, where a redirect means the route is not there. */
    val followRedirects: Boolean = true,
)

/**
 * A response, or a request that never got one. Status 0 is a network failure,
 * with the reason in [body]: callers treat it like any other failed status
 * rather than catching an exception, so no failure can pass as an empty result.
 */
data class HttpResponse(
    val status: Int,
    val statusText: String,
    val body: String,
    val apiVersion: String? = null,
) {
    val isSuccess: Boolean get() = status in 200..299
}

/** The app's one seam onto the network, so the auth and data code is testable. */
interface HttpTransport {
    suspend fun send(request: HttpRequest): HttpResponse
}
