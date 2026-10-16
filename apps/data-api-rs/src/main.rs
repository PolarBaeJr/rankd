use std::process::ExitCode;
use std::sync::Arc;
use std::task::Poll;

use data_api_rs::json::Out;
use data_api_rs::upstream::{self, Upstream};
use data_api_rs::{Deps, VERSION, config, healthcheck, serve};
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

fn log(line: Out) {
    println!("{}", line.to_json());
}

fn fatal(msg: String) -> ExitCode {
    eprintln!(
        "{}",
        Out::obj([("level", Out::str("fatal")), ("msg", Out::Str(msg))]).to_json()
    );
    ExitCode::from(1)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn main() -> ExitCode {
    // The image is FROM scratch: no shell, no curl, so the binary probes itself.
    if std::env::args().nth(1).as_deref() == Some("-healthcheck") {
        return healthcheck::run();
    }

    let config = match config::load(&|name| std::env::var(name).ok()) {
        Ok(c) => c,
        Err(msg) => return fatal(msg),
    };

    // One thread: the work is waiting on PostgREST, and every extra worker is
    // memory. Blocking work is limited to the resolver's getaddrinfo. The
    // multi-thread scheduler was measured in 0.3.1 (scripts/bench.mjs, 16 in
    // flight): three to eight times slower at the median on every scenario,
    // so it stays on one.
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(2)
        .build()
    {
        Ok(rt) => rt,
        Err(e) => return fatal(format!("runtime: {e}")),
    };

    runtime.block_on(async move {
        let listener = match TcpListener::bind(("0.0.0.0", config.port)).await {
            Ok(l) => l,
            Err(e) => return fatal(format!("listen: {e}")),
        };
        let version = VERSION.clone();
        log(Out::obj([
            ("level", Out::str("info")),
            ("msg", Out::str("listening")),
            ("port", Out::Num(config.port as f64)),
            ("version", Out::str(version.clone())),
        ]));

        let (Ok(mut term), Ok(mut int)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            return fatal("signal handlers".to_string());
        };
        let shutdown = async move {
            let name = std::future::poll_fn(|cx| {
                if term.poll_recv(cx).is_ready() {
                    return Poll::Ready("SIGTERM");
                }
                int.poll_recv(cx).map(|_| "SIGINT")
            })
            .await;
            log(Out::obj([
                ("level", Out::str("info")),
                ("msg", Out::str("shutting_down")),
                ("signal", Out::str(name)),
            ]));
        };

        let deps = Deps {
            upstream: Arc::new(Upstream::with_options(
                &config.supabase_url,
                &config.anon_key,
                &config.db_jwt,
                upstream::TIMEOUT,
                config.upstream_concurrency,
            )),
            version,
            now: Arc::new(now_ms),
            log: Arc::new(|line| println!("{line}")),
        };
        serve(listener, deps, shutdown).await;
        ExitCode::SUCCESS
    })
}
