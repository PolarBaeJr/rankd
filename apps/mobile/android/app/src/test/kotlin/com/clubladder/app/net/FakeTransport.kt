package com.clubladder.app.net

/** Answers each request from [respond] and records it. */
class FakeTransport(private val respond: suspend (HttpRequest) -> HttpResponse) : HttpTransport {
    val requests = mutableListOf<HttpRequest>()

    override suspend fun send(request: HttpRequest): HttpResponse {
        synchronized(requests) { requests.add(request) }
        return respond(request)
    }

    fun paths(): List<String> = synchronized(requests) { requests.map { it.url.substringAfter(BASE_URL) } }

    companion object {
        const val BASE_URL = "https://db.example.invalid"
    }
}

fun ok(body: String) = HttpResponse(200, "OK", body)

fun status(code: Int, body: String, apiVersion: String? = null) = HttpResponse(code, "", body, apiVersion)
