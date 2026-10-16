// The documentation page, the changelog and API.md against the code: every
// route, scope and query parameter is named in the page and API.md, none of
// the three carries an em dash, both pages keep to what their CSP allows (one
// <style> block, no style attribute, no script), and the version is the
// TypeScript service's.

mod common;

use data_api_rs::changelog_page::CHANGELOG_HTML;
use data_api_rs::docs_page::DOCS_HTML;
use data_api_rs::params::QUERY_PARAMS;
use data_api_rs::scopes::DATA_API_SCOPES;
use data_api_rs::server::ROUTES;

fn api_md() -> String {
    common::read_repo_file("apps/data-api/API.md")
}

#[test]
fn the_docs_page_and_api_md_name_every_route_scope_and_parameter() {
    let md = api_md();
    let names = ROUTES
        .iter()
        .map(|r| r.template)
        .chain(DATA_API_SCOPES)
        .chain(QUERY_PARAMS.iter().map(|(n, _)| *n));
    for n in names {
        assert!(DOCS_HTML.contains(n), "docs page: {n}");
        assert!(md.contains(n), "API.md: {n}");
    }
}

#[test]
fn has_no_em_dash_in_the_docs_page_the_changelog_or_api_md() {
    assert!(!DOCS_HTML.contains('\u{2014}'));
    assert!(!CHANGELOG_HTML.contains('\u{2014}'));
    assert!(!api_md().contains('\u{2014}'));
}

#[test]
fn both_pages_keep_to_their_one_csp() {
    let docs_style = DOCS_HTML
        .split("<style>")
        .nth(1)
        .and_then(|s| s.split("</style>").next());
    for page in [DOCS_HTML, CHANGELOG_HTML] {
        assert_eq!(page.matches("<style>").count(), 1);
        assert_eq!(page.matches("</style>").count(), 1);
        let lower = page.to_ascii_lowercase();
        assert!(!lower.contains("<script"));
        // `/\sstyle=/`: an attribute, as opposed to the word in prose.
        for (i, _) in lower.match_indices("style=") {
            let before = lower[..i].chars().next_back();
            assert!(
                !before.is_some_and(char::is_whitespace),
                "a style attribute at byte {i}"
            );
        }
        // One stylesheet for both, so one hash in the CSP covers both.
        let style = page
            .split("<style>")
            .nth(1)
            .and_then(|s| s.split("</style>").next());
        assert_eq!(style, docs_style);
    }
    assert!(data_api_rs::docs_page::DOCS_CSP.contains(&format!(
        "style-src '{}'",
        *data_api_rs::docs_page::DOCS_STYLE_HASH
    )));
}

#[test]
fn the_version_is_the_typescript_service_version() {
    let ts: serde_json::Value =
        serde_json::from_str(&common::read_repo_file("apps/data-api/package.json")).unwrap();
    assert_eq!(ts["version"].as_str(), Some(data_api_rs::VERSION.as_str()));
}

/// The `name: VALUE,` lines of one `{ ... }` block in a TypeScript file.
fn ts_table(source: &str, opening: &str) -> Vec<(String, String)> {
    let start = source.find(opening).expect(opening) + opening.len();
    let end = start + source[start..].find("};").expect("table end");
    source[start..end]
        .lines()
        .filter_map(|line| {
            let (name, value) = line.trim().trim_end_matches(',').split_once(':')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

#[test]
fn the_read_cache_ttls_and_invalidation_list_are_the_typescript_services() {
    use data_api_rs::rpc_cache::{
        LIVE_TTL_MS, REGISTRATION_READS, RPC_CACHE_MAX_BYTES, RPC_CACHE_MAX_ENTRIES, RPC_TTL_MS,
        SETTLED_TTL_MS,
    };
    let ts = common::read_repo_file("apps/data-api/src/rpc-cache.ts");
    let table = ts_table(&ts, "RPC_TTL_MS: Readonly<Record<string, number>> = {");
    let named = |value: &str| match value {
        "SETTLED_TTL_MS" => SETTLED_TTL_MS,
        "LIVE_TTL_MS" => LIVE_TTL_MS,
        other => panic!("unexpected TTL {other}"),
    };
    let ts_ttls: Vec<(String, i64)> = table.iter().map(|(n, v)| (n.clone(), named(v))).collect();
    let rs_ttls: Vec<(String, i64)> = RPC_TTL_MS
        .iter()
        .map(|(n, v)| (n.to_string(), *v))
        .collect();
    assert_eq!(rs_ttls, ts_ttls);
    assert!(ts.contains("export const SETTLED_TTL_MS = 60_000;"));
    assert!(ts.contains("export const LIVE_TTL_MS = 30_000;"));
    assert!(ts.contains(&format!(
        "export const RPC_CACHE_MAX_ENTRIES = {};",
        RPC_CACHE_MAX_ENTRIES
    )));
    assert_eq!(RPC_CACHE_MAX_BYTES, 32 * 1024 * 1024);
    assert!(ts.contains("export const RPC_CACHE_MAX_BYTES = 32 * 1024 * 1024;"));
    for read in REGISTRATION_READS {
        assert!(ts.contains(&format!("'{read}'")), "{read}");
    }
    let list = ts
        .split("REGISTRATION_READS: readonly string[] = [")
        .nth(1)
        .and_then(|s| s.split(']').next())
        .unwrap();
    assert_eq!(list.matches("'data_api_").count(), REGISTRATION_READS.len());
}

#[test]
fn the_upstream_concurrency_variable_is_the_typescript_services() {
    use data_api_rs::config::{
        DEFAULT_UPSTREAM_CONCURRENCY, MAX_UPSTREAM_CONCURRENCY, UPSTREAM_CONCURRENCY_ENV,
    };
    let ts = common::read_repo_file("apps/data-api/src/config.ts");
    assert!(ts.contains(&format!(
        "UPSTREAM_CONCURRENCY_ENV = '{UPSTREAM_CONCURRENCY_ENV}'"
    )));
    assert!(ts.contains(&format!(
        "DEFAULT_UPSTREAM_CONCURRENCY = {DEFAULT_UPSTREAM_CONCURRENCY};"
    )));
    assert!(ts.contains(&format!(
        "MAX_UPSTREAM_CONCURRENCY = {MAX_UPSTREAM_CONCURRENCY};"
    )));
}
