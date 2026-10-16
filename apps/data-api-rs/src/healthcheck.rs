// `data-api -healthcheck`: the image's HEALTHCHECK. It asks this process's own
// /health over loopback and exits 0 on a 2xx, 1 on anything else, as the
// Node image's fetch one-liner did.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::ExitCode;
use std::time::Duration;

use crate::config;

const TIMEOUT: Duration = Duration::from_secs(5);

pub fn run() -> ExitCode {
    let port =
        config::port_from(std::env::var("PORT").ok().as_deref()).unwrap_or(config::DEFAULT_PORT);
    if probe(port) {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn probe(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), TIMEOUT) else {
        return false;
    };
    if stream.set_read_timeout(Some(TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(TIMEOUT)).is_err()
    {
        return false;
    }
    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    if stream.read_exact(&mut head).is_err() {
        return false;
    }
    // "HTTP/1.1 200"
    head.starts_with(b"HTTP/1.") && head[9] == b'2'
}
