// The public documentation page served at /documentations, compiled into the
// binary so the image needs nothing beside it.
//
// It describes what server.rs, params.rs, auth.rs and rate_limit.rs DO. Drift
// tests in tests/drift.rs fail when a route, scope, query parameter or error
// code is missing from this page.
//
// The CSP allows exactly this page's one stylesheet by hash, computed from the
// page at startup, so the page must carry exactly one <style> block and no
// style="" attribute (tests/drift.rs checks both).

use std::sync::LazyLock;

use sha2::{Digest, Sha256};

use crate::base64;

pub const DOCS_HTML: &str = include_str!("docs/documentations.html");

/// The text between `<style>` and `</style>`.
pub fn style() -> &'static str {
    let start = DOCS_HTML.find("<style>").map_or(0, |i| i + "<style>".len());
    let end = DOCS_HTML[start..]
        .find("</style>")
        .map_or(start, |i| start + i);
    &DOCS_HTML[start..end]
}

pub static DOCS_STYLE_HASH: LazyLock<String> = LazyLock::new(|| {
    format!(
        "sha256-{}",
        base64::encode(&Sha256::digest(style().as_bytes()))
    )
});

pub static DOCS_CSP: LazyLock<String> = LazyLock::new(|| {
    [
        "default-src 'none'".to_string(),
        format!("style-src '{}'", *DOCS_STYLE_HASH),
        "base-uri 'none'".to_string(),
        "form-action 'none'".to_string(),
        "frame-ancestors 'none'".to_string(),
    ]
    .join("; ")
});
