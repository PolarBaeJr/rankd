// The club's external Data API: an HTTP service in front of PostgREST, the
// Rust build of apps/data-api. See ../README.md for the shape of it and
// ../../data-api/API.md for the contract.

pub mod auth;
pub mod base64;
pub mod changelog_page;
pub mod config;
pub mod docs_page;
pub mod healthcheck;
pub mod js_parse;
pub mod json;
pub mod key;
pub mod ordered;
pub mod params;
pub mod predictions;
pub mod rate_limit;
pub mod registrations;
pub mod rpc_cache;
pub mod scopes;
pub mod server;
pub mod shape;
pub mod time;
pub mod upstream;
pub mod url;

use std::convert::Infallible;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex};
use std::task::Poll;
use std::time::Duration;

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::header::{AUTHORIZATION, CONTENT_TYPE, HeaderName, HeaderValue};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::server::graceful::GracefulShutdown;
use tokio::net::TcpListener;

pub use server::Deps;
use server::{Ctx, Failure, Handler, Reply, RequestInfo};

/// The version /health reports: package.json's, as the Node service read it.
pub static VERSION: LazyLock<String> = LazyLock::new(|| {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../package.json")).unwrap_or_default();
    manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string()
});

/// Node's default limit on a request head is 16 KiB; this buffer is that plus
/// room for the request line.
const MAX_BUF_SIZE: usize = 17_408;
/// Node's headersTimeout.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a shutdown waits for requests in flight before it gives up.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

fn to_response(reply: Reply) -> Response<Full<Bytes>> {
    let mut res = Response::new(Full::new(Bytes::from(reply.body)));
    *res.status_mut() =
        StatusCode::from_u16(reply.status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
    let headers = res.headers_mut();
    for (name, value) in reply.headers {
        if let Ok(v) = HeaderValue::from_str(&value) {
            headers.append(HeaderName::from_static(name), v);
        }
    }
    res
}

/// Request targets Node's parser (llhttp) refuses but hyper's accepts: one
/// that is neither origin-form (`/...`), absolute-form nor `*`, and one with a
/// byte outside ASCII. Node answered those with a bare 400 before the handler
/// saw them, so they get no log line here either.
fn parser_rejects(uri: &hyper::Uri) -> bool {
    let target = uri.to_string();
    let origin_form = target.starts_with('/') || target == "*" || uri.scheme().is_some();
    !origin_form || !target.is_ascii()
}

/// The 400 Node's parser sent: no body, and the connection closed.
fn bad_request() -> Response<Full<Bytes>> {
    let mut res = Response::new(Full::new(Bytes::new()));
    *res.status_mut() = StatusCode::BAD_REQUEST;
    res.headers_mut()
        .insert(hyper::header::CONNECTION, HeaderValue::from_static("close"));
    res
}

async fn respond(
    handler: Arc<Handler>,
    peer: String,
    req: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    if parser_rejects(req.uri()) {
        return Ok(bad_request());
    }
    let (parts, body) = req.into_parts();
    let info = RequestInfo {
        method: parts.method.as_str().to_string(),
        target: url::latin1(parts.uri.to_string().as_bytes()),
        authorization: parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string),
        forwarded_for: parts
            .headers
            .get_all("x-forwarded-for")
            .iter()
            .map(|v| url::latin1(v.as_bytes()))
            .collect(),
        peer,
        content_type: parts
            .headers
            .get(CONTENT_TYPE)
            .map(|v| url::latin1(v.as_bytes())),
        body: Mutex::new(Some(body)),
    };
    let method = info.method.clone();
    let ctx = Arc::new(Mutex::new(Ctx::default()));
    let started = handler.now();
    // Its own task: a client that disconnects does not cancel the request (its
    // database call and its log line still happen), and a panic is that one
    // request's 503, not the process.
    let task = tokio::spawn({
        let handler = Arc::clone(&handler);
        let ctx = Arc::clone(&ctx);
        async move { handler.handle(info, ctx).await }
    });
    let reply = match task.await {
        Ok(reply) => reply,
        Err(_) => {
            handler.log_failure(&Failure::Error("Error"));
            let reply = server::unavailable();
            let ctx = ctx.lock().map(|c| c.clone()).unwrap_or_default();
            handler.log_request(&method, &ctx, reply.status, started);
            reply
        }
    };
    Ok(to_response(reply))
}

/// Serves HTTP/1.1 on `listener` until `shutdown` resolves, then lets requests
/// in flight finish for up to 10 seconds.
pub async fn serve(listener: TcpListener, deps: Deps, shutdown: impl Future<Output = ()>) {
    let handler = Arc::new(Handler::new(deps));
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .max_buf_size(MAX_BUF_SIZE)
        .header_read_timeout(HEADER_READ_TIMEOUT)
        .title_case_headers(true)
        .timer(TokioTimer::new());
    let graceful = GracefulShutdown::new();
    let mut shutdown = std::pin::pin!(shutdown);
    loop {
        // A two-way race without tokio's macros feature: the shutdown signal
        // wins over a connection that arrives in the same poll.
        let event = std::future::poll_fn(|cx| {
            if shutdown.as_mut().poll(cx).is_ready() {
                return Poll::Ready(None);
            }
            listener.poll_accept(cx).map(Some)
        })
        .await;
        let Some(accepted) = event else { break };
        let Ok((stream, addr)) = accepted else {
            continue;
        };
        let peer = match addr.ip() {
            std::net::IpAddr::V6(v6) => v6.to_canonical().to_string(),
            ip => ip.to_string(),
        };
        let handler = Arc::clone(&handler);
        let svc = service_fn(move |req| respond(Arc::clone(&handler), peer.clone(), req));
        let conn = graceful.watch(builder.serve_connection(TokioIo::new(stream), svc));
        tokio::spawn(async move {
            let _ = conn.await;
        });
    }
    drop(listener);
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, graceful.shutdown()).await;
}
