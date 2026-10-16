package com.clubladder.app.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The platform's own HTTP client. A handful of JSON requests does not need an
 * HTTP library, and every one left out is download size and memory saved.
 */
class UrlConnectionTransport(private val timeoutMillis: Int = 15_000) : HttpTransport {
    override suspend fun send(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        // The session tokens ride on every request. The config check and the
        // manifest's cleartext ban already refuse http; this is the last one.
        if (!request.url.startsWith("https://", ignoreCase = true)) {
            return@withContext HttpResponse(0, "", "Refusing a request that is not https.")
        }
        var connection: HttpURLConnection? = null
        try {
            connection = URL(request.url).openConnection() as HttpURLConnection
            connection.requestMethod = request.method
            connection.connectTimeout = timeoutMillis
            connection.readTimeout = timeoutMillis
            connection.useCaches = false
            connection.instanceFollowRedirects = request.followRedirects
            for ((name, value) in request.headers) connection.setRequestProperty(name, value)
            if (request.body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(request.body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            HttpResponse(
                status = status,
                statusText = connection.responseMessage ?: "",
                body = body,
                apiVersion = connection.getHeaderField("X-Supabase-Api-Version"),
            )
        } catch (e: IOException) {
            HttpResponse(0, "", e.message ?: "The network request failed.")
        } finally {
            connection?.disconnect()
        }
    }
}
