import Foundation

/// The platform's own HTTP client, with no cookies and no cache: every request
/// carries its own credentials, and nothing is kept on disk.
final class URLSessionTransport: HttpTransport {
    private let session: URLSession

    init(timeout: TimeInterval = 15) {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = timeout
        session = URLSession(configuration: config)
    }

    func send(_ request: HttpRequest) async throws -> HttpResponse {
        // The session tokens ride on every request. The config check already
        // refuses http; this is the last line.
        guard request.url.lowercased().hasPrefix("https://"), let url = URL(string: request.url) else {
            return HttpResponse(status: 0, statusText: "", body: "Refusing a request that is not https.")
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        if let body = request.body {
            urlRequest.httpBody = Data(body.utf8)
        }
        do {
            let (data, response) = try await session.data(
                for: urlRequest,
                delegate: request.followRedirects ? nil : NoRedirects(),
            )
            let http = response as? HTTPURLResponse
            return HttpResponse(
                status: http?.statusCode ?? 0,
                statusText: "",
                body: String(decoding: data, as: UTF8.self),
                apiVersion: http?.value(forHTTPHeaderField: "X-Supabase-Api-Version"),
            )
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            if Task.isCancelled { throw CancellationError() }
            return HttpResponse(status: 0, statusText: "", body: error.localizedDescription)
        }
    }
}

/// Hands back the 3xx itself instead of following it.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
    ) async -> URLRequest? {
        nil
    }
}
