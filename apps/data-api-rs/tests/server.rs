// The service end to end: health, the documentation page, authentication,
// scopes, the key and read caches, rate limits and logs.

mod common;

use common::*;
use hyper::Method;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

// Literals, not the constants from auth.rs: the contract says 30 seconds, and a
// test that imported the constant would follow it wherever it was changed to.
const POSITIVE_TTL_MS: i64 = 30_000;
const NEGATIVE_TTL_MS: i64 = 5_000;
// The roster, results and ratings live 60 seconds; tournaments and the
// schedule 30 (rpc_cache.rs).
const READ_CACHE_TTL_MS: i64 = 60_000;
const LIVE_CACHE_TTL_MS: i64 = 30_000;

fn ref_a() -> String {
    "a".repeat(64)
}

fn ref_b() -> String {
    "b".repeat(64)
}

async fn harness() -> Harness {
    let h = start().await;
    h.set_players(vec![player_row(&ref_a()), player_row(&ref_b())]);
    h
}

fn count(h: &Harness, fn_name: &str) -> usize {
    h.all(fn_name).len()
}

#[tokio::test]
async fn health_is_unauthenticated_and_reports_the_version() {
    let h = harness().await;
    let res = h.get("/health", None).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.json(), json!({"ok": true, "version": "0.1.0"}));
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn documentations_serves_html_with_the_security_headers_and_never_asks_the_database() {
    let h = harness().await;
    for path in ["/documentations", "/documentations/"] {
        let res = h.get(path, None).await;
        assert_eq!(res.status, 200);
        assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(res.header("cache-control"), Some("public, max-age=300"));
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(res.header("referrer-policy"), Some("no-referrer"));
        let csp = res
            .header("content-security-policy")
            .unwrap_or("")
            .to_string();
        assert!(csp.contains("default-src 'none'"));
        assert!(!csp.contains("script-src"));
        assert!(!csp.contains("unsafe-inline"));
        let body = res.text();
        assert!(body.contains("<title>Club Ladder Data API</title>"));
        // The one stylesheet, hashed here from what was served, is what the CSP allows.
        let styles: Vec<&str> = body
            .split("<style>")
            .skip(1)
            .map(|s| s.split("</style>").next().unwrap())
            .collect();
        assert_eq!(styles.len(), 1);
        assert!(
            !body.contains(" style=") && !body.contains("\nstyle=") && !body.contains("\tstyle=")
        );
        assert!(!body.to_ascii_lowercase().contains("<script"));
        let hash = data_api_rs::base64::encode(&Sha256::digest(styles[0].as_bytes()));
        assert!(csp.contains(&format!("style-src 'sha256-{hash}'")));
    }
    assert!(h.calls().is_empty());
    let lines = h.log_lines();
    assert_match(
        &lines[0],
        &json!({"method": "GET", "path": "/documentations", "status": 200}),
    );
    assert!(lines[0].get("key").is_none());
}

#[tokio::test]
async fn documentations_answers_head_with_the_headers_and_no_body() {
    let h = harness().await;
    let get = h.get("/documentations", None).await;
    let res = h.request(Method::HEAD, "/documentations", None, &[]).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
    let len: usize = res.header("content-length").unwrap().parse().unwrap();
    assert!(len > 0);
    assert_eq!(len, get.body.len());
    assert_eq!(res.text(), "");
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn documentations_405s_any_other_method() {
    let h = harness().await;
    let res = h
        .request(Method::POST, "/documentations", Some(&new_key()), &[])
        .await;
    assert_eq!(res.status, 405);
    assert_eq!(res.header("allow"), Some("GET, HEAD"));
    assert_eq!(res.json(), json!({"error": "method_not_allowed"}));
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn documentations_ignores_a_key_and_is_not_charged_to_its_rate_budget() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    for _ in 0..70 {
        assert_eq!(h.get("/documentations", Some(&key)).await.status, 200);
    }
    assert!(h.calls().is_empty());
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
}

#[tokio::test]
async fn documentations_links_to_the_changelog() {
    let h = harness().await;
    let body = h.get("/documentations", None).await.text();
    assert!(body.contains("href=\"/changelog\""));
}

#[tokio::test]
async fn changelog_serves_html_with_the_security_headers_and_never_asks_the_database() {
    let h = harness().await;
    for path in ["/changelog", "/changelog/"] {
        let res = h.get(path, None).await;
        assert_eq!(res.status, 200);
        assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(res.header("cache-control"), Some("public, max-age=300"));
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(res.header("referrer-policy"), Some("no-referrer"));
        let csp = res
            .header("content-security-policy")
            .unwrap_or("")
            .to_string();
        assert!(csp.contains("default-src 'none'"));
        assert!(!csp.contains("script-src"));
        assert!(!csp.contains("unsafe-inline"));
        // Bytes: the footer is not ASCII.
        let len: usize = res.header("content-length").unwrap().parse().unwrap();
        assert_eq!(len, res.body.len());
        let body = res.text();
        assert!(body.contains("<title>Club Ladder Data API changelog</title>"));
        let styles: Vec<&str> = body
            .split("<style>")
            .skip(1)
            .map(|s| s.split("</style>").next().unwrap())
            .collect();
        assert_eq!(styles.len(), 1);
        assert!(!body.to_ascii_lowercase().contains("<script"));
        let hash = data_api_rs::base64::encode(&Sha256::digest(styles[0].as_bytes()));
        assert!(csp.contains(&format!("style-src 'sha256-{hash}'")));
        assert!(body.contains("href=\"/documentations\""));
        assert!(body.contains("href=\"https://example.com/\""));
    }
    assert!(h.calls().is_empty());
    let lines = h.log_lines();
    assert_match(
        &lines[0],
        &json!({"method": "GET", "path": "/changelog", "status": 200}),
    );
    assert!(lines[0].get("key").is_none());
}

#[tokio::test]
async fn changelog_answers_head_with_the_headers_and_no_body() {
    let h = harness().await;
    let res = h.request(Method::HEAD, "/changelog", None, &[]).await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
    let len: usize = res.header("content-length").unwrap().parse().unwrap();
    assert_eq!(len, data_api_rs::changelog_page::CHANGELOG_HTML.len());
    assert_eq!(res.text(), "");
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn changelog_405s_any_other_method() {
    let h = harness().await;
    let res = h
        .request(Method::POST, "/changelog", Some(&new_key()), &[])
        .await;
    assert_eq!(res.status, 405);
    assert_eq!(res.header("allow"), Some("GET, HEAD"));
    assert_eq!(res.json(), json!({"error": "method_not_allowed"}));
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn changelog_ignores_a_key_and_is_not_charged_to_its_rate_budget() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    for _ in 0..70 {
        assert_eq!(h.get("/changelog", Some(&key)).await.status, 200);
    }
    assert!(h.calls().is_empty());
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
}

/// The quoted strings that follow `marker` in `source`.
fn quoted_after(source: &str, marker: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in source.split(marker).skip(1) {
        if let Some(s) = part.split('"').next()
            && !out.iter().any(|o| o == s)
        {
            out.push(s.to_string());
        }
    }
    out
}

// Read from server.rs itself, so a route, scope or error code added there
// without a line on the page fails here rather than going undocumented.
#[tokio::test]
async fn documentations_documents_every_route_scope_and_error_code_the_server_has() {
    let h = harness().await;
    let source =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/server.rs")).unwrap();
    let routes = quoted_after(&source, "template: \"");
    let errors = quoted_after(&source, "(\"error\", Out::str(\"");
    let scopes = quoted_after(&source, "scope: Some(\"");
    for r in [
        "/health",
        "/documentations",
        "/v1/players",
        "/v1/players/:ref",
        "/v1/matches",
    ] {
        assert!(routes.iter().any(|x| x == r), "{r}");
    }
    for e in [
        "not_found",
        "method_not_allowed",
        "unauthorized",
        "rate_limited",
        "forbidden",
        "unavailable",
    ] {
        assert!(errors.iter().any(|x| x == e), "{e}");
    }
    for s in ["players:read", "matches:read"] {
        assert!(scopes.iter().any(|x| x == s), "{s}");
    }

    let body = h.get("/documentations", None).await.text();
    for s in routes.iter().chain(&errors).chain(&scopes) {
        assert!(body.contains(s.as_str()), "{s}");
    }
}

#[tokio::test]
async fn response_headers_set_json_no_store_and_nosniff_and_no_cors() {
    let h = harness().await;
    let res = h.get("/health", None).await;
    assert_eq!(
        res.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(res.header("access-control-allow-origin"), None);
}

#[tokio::test]
async fn unauthorized_answers_missing_malformed_unknown_expired_and_revoked_identically() {
    let h = harness().await;
    let snapshot = |res: Res| {
        let mut headers: Vec<(String, String)> = res
            .headers
            .iter()
            .filter(|(k, _)| !["date", "connection", "keep-alive"].contains(&k.as_str()))
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
            .collect();
        headers.sort();
        (res.status, res.text(), headers)
    };
    // Expired and revoked keys are zero rows from data_api_verify_key, which is
    // exactly the unknown case: the fake simply holds no row for them.
    let results = vec![
        snapshot(h.get("/v1/players", None).await),
        snapshot(h.get("/v1/players", Some("not-a-key")).await),
        snapshot(h.get("/v1/players", Some(&new_key())).await),
        snapshot(h.get("/v1/players", Some(&new_key())).await),
        snapshot(h.get("/v1/players", Some(&new_key())).await),
    ];
    assert_eq!(results[0].0, 401);
    assert_eq!(
        serde_json::from_str::<Value>(&results[0].1).unwrap(),
        json!({"error": "unauthorized"})
    );
    for r in &results {
        assert_eq!(r, &results[0]);
    }
}

#[tokio::test]
async fn never_sends_a_malformed_or_missing_header_to_the_database() {
    let h = harness().await;
    h.get("/v1/players", None).await;
    h.get("/v1/players", Some("clubld_short")).await;
    h.request(
        Method::GET,
        "/v1/players",
        None,
        &[("authorization", "Basic abc")],
    )
    .await;
    assert!(h.calls().is_empty());
}

#[tokio::test]
async fn sends_the_sha256_hash_never_the_plaintext_key() {
    let h = harness().await;
    let key = new_key();
    h.get("/v1/players", Some(&key)).await;
    let calls = h.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].fn_name, "data_api_verify_key");
    let hash = calls[0].body["p_key_hash"].as_str().unwrap();
    assert!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    assert!(!format!("{:?}", calls[0]).contains(&key));
}

#[tokio::test]
async fn authenticates_to_postgrest_with_the_anon_apikey_and_the_reader_jwt() {
    let h = harness().await;
    h.get("/v1/players", Some(&new_key())).await;
    let call = &h.calls()[0];
    assert_eq!(call.header("apikey"), Some("anon-key-value"));
    assert_eq!(
        call.header("authorization"),
        Some("Bearer reader-jwt-value")
    );
}

#[tokio::test]
async fn scopes_403_a_key_without_players_read() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["matches:read"]);
    let res = h.get("/v1/players", Some(&key)).await;
    assert_eq!(res.status, 403);
    assert_eq!(
        res.json(),
        json!({"error": "forbidden", "detail": "this key does not carry players:read"})
    );
    assert_eq!(
        h.get(&format!("/v1/players/{}", ref_a()), Some(&key))
            .await
            .status,
        403
    );
}

#[tokio::test]
async fn scopes_403_matches_without_matches_read_and_page_an_empty_history_with_it() {
    let h = harness().await;
    let reader = new_key();
    h.grant(&reader, &["players:read"]);
    let denied = h.get("/v1/matches", Some(&reader)).await;
    assert_eq!(denied.status, 403);
    assert_eq!(
        denied.json(),
        json!({"error": "forbidden", "detail": "this key does not carry matches:read"})
    );

    let matches = new_key();
    h.grant_as(
        &matches,
        &["matches:read"],
        "99999999-2222-3333-4444-555555555555",
        CONSUMER,
    );
    h.set_rpc("data_api_matches", |_| json!([]));
    let ok = h.get("/v1/matches", Some(&matches)).await;
    assert_eq!(ok.status, 200);
    let body = ok.json();
    assert_eq!(
        body,
        json!({
            "generated_at": "2027-01-15T08:00:00Z",
            "count": 0,
            "limit": 100,
            "offset": 0,
            "next_offset": null,
            "matches": [],
        })
    );
    assert_eq!(
        keys(&body),
        [
            "generated_at",
            "count",
            "limit",
            "offset",
            "next_offset",
            "matches"
        ]
    );
}

#[tokio::test]
async fn players_matches_the_api_md_shape_exactly() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    let res = h.get("/v1/players", Some(&key)).await;
    assert_eq!(res.status, 200);
    let body = res.json();
    assert_eq!(keys(&body), ["season", "generated_at", "count", "players"]);
    assert_eq!(body["season"], Value::Null);
    assert_eq!(body["generated_at"], "2027-01-15T08:00:00Z");
    assert_eq!(body["count"], 2);
    let first = &body["players"][0];
    assert_eq!(
        keys(first),
        [
            "player_ref",
            "singles_elo",
            "doubles_elo",
            "singles_provisional",
            "doubles_provisional",
            "singles_matches_played",
            "doubles_matches_played",
            "singles_wins",
            "singles_losses",
            "doubles_wins",
            "doubles_losses",
            "updated_at",
        ]
    );
    assert_eq!(first["updated_at"], "2026-09-14T04:11:55Z");
    assert_eq!(
        h.fns(),
        [
            "data_api_verify_key",
            "data_api_players",
            "data_api_active_season"
        ]
    );
    assert_eq!(h.calls()[1].body, json!({"p_consumer_id": CONSUMER}));
}

#[tokio::test]
async fn players_drops_any_column_the_database_adds_beyond_the_contract() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    let mut row = player_row(&ref_a());
    row["id"] = json!("internal");
    h.set_players(vec![row]);
    let body = h.get("/v1/players", Some(&key)).await.json();
    assert!(body["players"][0].get("id").is_none());
}

#[tokio::test]
async fn player_returns_one_player_in_the_same_shape() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    let res = h.get(&format!("/v1/players/{}", ref_b()), Some(&key)).await;
    assert_eq!(res.status, 200);
    let body = res.json();
    assert_eq!(body["player_ref"], ref_b());
    assert_eq!(body["updated_at"], "2026-09-14T04:11:55Z");
}

#[tokio::test]
async fn player_404s_an_unknown_ref() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    let res = h
        .get(&format!("/v1/players/{}", "c".repeat(64)), Some(&key))
        .await;
    assert_eq!(res.status, 404);
    assert_eq!(res.json(), json!({"error": "not_found"}));
}

#[tokio::test]
async fn player_404s_a_malformed_ref_without_asking_the_database() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    let res = h.get("/v1/players/p_8f14e45fceea167a", Some(&key)).await;
    assert_eq!(res.status, 404);
    assert_eq!(h.fns(), ["data_api_verify_key"]);
}

#[tokio::test]
async fn routes_404_an_unknown_route_as_json() {
    let h = harness().await;
    let res = h.get("/v2/players", None).await;
    assert_eq!(res.status, 404);
    assert_eq!(
        res.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(res.json(), json!({"error": "not_found"}));
}

#[tokio::test]
async fn routes_405_a_non_get_on_a_known_route_before_auth() {
    let h = harness().await;
    let res = h.request(Method::POST, "/v1/players", None, &[]).await;
    assert_eq!(res.status, 405);
    assert_eq!(res.header("allow"), Some("GET"));
    assert_eq!(res.json(), json!({"error": "method_not_allowed"}));
    let del = h
        .request(
            Method::DELETE,
            &format!("/v1/players/{}", ref_a()),
            None,
            &[],
        )
        .await;
    assert_eq!(del.status, 405);
}

#[tokio::test]
async fn verification_cache_reuses_a_positive_result_and_a_revoked_key_stops_after_30s() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);

    // Revoked in the database: data_api_verify_key now returns zero rows.
    h.clear_keys();
    h.advance(POSITIVE_TTL_MS - 1);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
    assert_eq!(count(&h, "data_api_verify_key"), 1);

    h.advance(1);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 401);
    assert_eq!(count(&h, "data_api_verify_key"), 2);
}

#[tokio::test]
async fn verification_cache_caches_a_negative_result_briefly() {
    let h = harness().await;
    let key = new_key();
    h.get("/v1/players", Some(&key)).await;
    h.get("/v1/players", Some(&key)).await;
    assert_eq!(h.calls().len(), 1);

    // Minted a moment later: still refused until the negative entry expires.
    h.grant(&key, &["players:read"]);
    h.advance(NEGATIVE_TTL_MS - 1);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 401);
    h.advance(1);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
}

#[tokio::test]
async fn verification_cache_does_not_cache_an_upstream_failure() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    h.fail_next(Some(500));
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 503);
    h.fail_next(None);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
}

#[tokio::test]
async fn upstream_failure_maps_to_503_and_logs_only_the_status() {
    for status in [500u16, 502, 404, 401] {
        let h = harness().await;
        h.fail_next(Some(status));
        let res = h.get("/v1/players", Some(&new_key())).await;
        assert_eq!(res.status, 503);
        assert_eq!(res.json(), json!({"error": "unavailable"}));
        let line = h
            .log_lines()
            .into_iter()
            .find(|l| l["msg"] == "upstream_failed");
        assert_eq!(
            line,
            Some(
                json!({"level": "error", "msg": "upstream_failed", "fn": "data_api_verify_key", "upstream_status": status})
            )
        );
        assert!(!h.log_text().contains("boom"));
    }
}

#[tokio::test]
async fn upstream_failure_maps_a_failed_feed_read_to_503() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    h.get("/v1/players", Some(&key)).await;
    // Past the read cache; the key is checked again and passes.
    h.advance(READ_CACHE_TTL_MS + 1);
    h.fail_fn(Some(("data_api_players", 503)));
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 503);
    assert!(h.log_text().contains(r#""fn":"data_api_players""#));
}

#[tokio::test]
async fn read_cache_answers_a_repeat_read_for_60_seconds_then_asks_again() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
    h.advance(READ_CACHE_TTL_MS - 1);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
    assert_eq!(count(&h, "data_api_players"), 1);
    h.advance(2);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
    assert_eq!(count(&h, "data_api_players"), 2);
}

#[tokio::test]
async fn read_cache_shares_one_database_call_between_concurrent_identical_reads() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    h.get("/v1/players", Some(&key)).await;
    h.advance(READ_CACHE_TTL_MS + 1);
    let mut tasks = Vec::new();
    for _ in 0..10 {
        let client = h.client();
        let uri = format!("{}/v1/players", h.base);
        let auth = format!("Bearer {key}");
        tasks.push(tokio::spawn(async move {
            let req = hyper::Request::get(uri)
                .header("authorization", auth)
                .body(http_body_util::Full::new(hyper::body::Bytes::new()))
                .unwrap();
            client.request(req).await.unwrap().status().as_u16()
        }));
    }
    for t in tasks {
        assert_eq!(t.await.unwrap(), 200);
    }
    assert_eq!(count(&h, "data_api_players"), 2);
}

#[tokio::test]
async fn read_cache_never_serves_one_consumer_the_answer_computed_for_another() {
    let h = harness().await;
    let first = new_key();
    let second = new_key();
    h.grant(&first, &["players:read"]);
    h.grant_as(
        &second,
        &["players:read"],
        "99999999-2222-3333-4444-555555555555",
        "bbbbbbbb-0000-0000-0000-000000000002",
    );
    h.get("/v1/players", Some(&first)).await;
    h.get("/v1/players", Some(&second)).await;
    let consumers: Vec<Value> = h
        .all("data_api_players")
        .into_iter()
        .map(|b| b["p_consumer_id"].clone())
        .collect();
    assert_eq!(
        consumers,
        [
            json!(CONSUMER),
            json!("bbbbbbbb-0000-0000-0000-000000000002")
        ]
    );
}

#[tokio::test]
async fn read_cache_does_not_keep_a_failure() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    h.get("/v1/players", Some(&key)).await;
    h.advance(READ_CACHE_TTL_MS + 1);
    h.fail_fn(Some(("data_api_players", 500)));
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 503);
    h.fail_fn(None);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
    assert_eq!(count(&h, "data_api_players"), 3);
}

#[tokio::test]
async fn read_cache_keeps_tournaments_and_the_schedule_for_30_seconds() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["tournaments:read"]);
    h.set_rpc("data_api_tournaments", |_| json!([]));
    assert_eq!(h.get("/v1/tournaments", Some(&key)).await.status, 200);
    h.advance(LIVE_CACHE_TTL_MS - 1);
    h.get("/v1/tournaments", Some(&key)).await;
    assert_eq!(count(&h, "data_api_tournaments"), 1);
    h.advance(1);
    h.get("/v1/tournaments", Some(&key)).await;
    assert_eq!(count(&h, "data_api_tournaments"), 2);
}

#[tokio::test]
async fn read_cache_keys_on_the_parameters_after_normalising_them() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["matches:read"]);
    h.set_rpc("data_api_matches", |_| json!([]));
    let season = "abcdef01-2345-4678-89ab-cdef01234567";
    h.get(
        &format!("/v1/matches?season={season}&since=2026-09-01T00:00Z"),
        Some(&key),
    )
    .await;
    // The same request spelled differently: an upper-case uuid, seconds and
    // milliseconds on the timestamp, the parameters in another order.
    h.get(
        &format!(
            "/v1/matches?since=2026-09-01T00:00:00.000Z&season={}",
            season.to_uppercase()
        ),
        Some(&key),
    )
    .await;
    assert_eq!(count(&h, "data_api_matches"), 1);
    h.get(
        &format!("/v1/matches?season={season}&since=2026-09-01T00:00Z&limit=5"),
        Some(&key),
    )
    .await;
    assert_eq!(count(&h, "data_api_matches"), 2);
}

#[tokio::test]
async fn read_cache_drops_entrant_and_signup_reads_after_a_registration_not_after_a_prediction() {
    let h = harness().await;
    let key = new_key();
    h.grant(
        &key,
        &[
            "schedule:read",
            "players:read",
            "registrations:write",
            "predictions:write",
        ],
    );
    let other = new_key();
    h.grant_as(
        &other,
        &["schedule:read"],
        "99999999-2222-3333-4444-555555555555",
        "bbbbbbbb-0000-0000-0000-000000000002",
    );
    h.set_rpc("data_api_club_events", |_| json!([]));
    h.set_rpc("data_api_sessions", |_| json!([]));
    h.set_rpc("data_api_import_registration", |_| {
        json!([{"item": 1, "event_id": null, "status": "entered", "reason": null, "replayed": false}])
    });
    h.set_rpc(
        "data_api_write_predictions",
        |_| json!([{"item": 1, "status": "created"}]),
    );
    let window = "?from=2027-01-15T00:00:00Z";
    for k in [&key, &other] {
        h.get(&format!("/v1/events{window}"), Some(k)).await;
        h.get(&format!("/v1/sessions{window}"), Some(k)).await;
    }
    h.get("/v1/players", Some(&key)).await;
    assert_eq!(
        (
            count(&h, "data_api_club_events"),
            count(&h, "data_api_sessions"),
            count(&h, "data_api_players")
        ),
        (2, 2, 1)
    );

    let json_type = [("content-type", "application/json")];
    let imported = h
        .send(
            Method::POST,
            "/v1/registrations",
            Some(&key),
            &json_type,
            json!({
                "form_id": "1FAIpQLSexampleForm",
                "response_id": "ACYDBNj-example",
                "submitted_at": "2026-10-08T10:00:00Z",
                "email": "guest@example.org",
                "name": "Guest Person",
                "entries": [{"event_id": "aaaaaaaa-1111-4222-8333-444444444444", "partner_name": null}],
            })
            .to_string(),
        )
        .await;
    assert_eq!(imported.status, 200);
    for k in [&key, &other] {
        h.get(&format!("/v1/events{window}"), Some(k)).await;
        h.get(&format!("/v1/sessions{window}"), Some(k)).await;
    }
    // Only this consumer's club events were asked again.
    assert_eq!(
        (
            count(&h, "data_api_club_events"),
            count(&h, "data_api_sessions")
        ),
        (3, 2)
    );

    let prediction = json!({"predictions": [{
        "format": "singles", "side_a": [ref_a()], "side_b": [ref_b()],
        "probability": 0.5, "model": "m", "made_at": "2027-01-15T08:00:00Z"
    }]});
    let predicted = h
        .send(
            Method::POST,
            "/v1/predictions",
            Some(&key),
            &json_type,
            prediction.to_string(),
        )
        .await;
    assert_eq!(predicted.status, 200);
    h.get("/v1/players", Some(&key)).await;
    assert_eq!(count(&h, "data_api_players"), 1);
}

#[tokio::test]
async fn read_cache_drops_them_after_a_failed_registration_too_which_may_still_have_committed() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["schedule:read", "registrations:write"]);
    h.set_rpc("data_api_club_events", |_| json!([]));
    h.fail_fn(Some(("data_api_import_registration", 500)));
    let window = "/v1/events?from=2027-01-15T00:00:00Z";
    h.get(window, Some(&key)).await;
    let imported = h
        .send(
            Method::POST,
            "/v1/registrations",
            Some(&key),
            &[("content-type", "application/json")],
            json!({
                "form_id": "1FAIpQLSexampleForm",
                "response_id": "ACYDBNj-example",
                "submitted_at": "2026-10-08T10:00:00Z",
                "email": "guest@example.org",
                "name": "Guest Person",
                "entries": [{"event_id": "aaaaaaaa-1111-4222-8333-444444444444", "partner_name": null}],
            })
            .to_string(),
        )
        .await;
    assert_eq!(imported.status, 503);
    h.get(window, Some(&key)).await;
    assert_eq!(count(&h, "data_api_club_events"), 2);
}

#[tokio::test]
async fn read_cache_shares_one_call_between_concurrent_identical_misses() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    h.get("/v1/seasons", Some(&key)).await;
    let held = h.hold("data_api_players");
    let tasks: Vec<_> = (0..8).map(|_| h.spawn_get("/v1/players", &key)).collect();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(count(&h, "data_api_players"), 1);
    held.release();
    for t in tasks {
        assert_eq!(t.await.unwrap(), 200);
    }
    assert_eq!(count(&h, "data_api_players"), 1);
}

#[tokio::test]
async fn verification_single_flight_sends_one_key_check_for_many_concurrent_requests() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    let held = h.hold("data_api_verify_key");
    let tasks: Vec<_> = (0..10).map(|_| h.spawn_get("/v1/players", &key)).collect();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(count(&h, "data_api_verify_key"), 1);
    held.release();
    for t in tasks {
        assert_eq!(t.await.unwrap(), 200);
    }
    assert_eq!(count(&h, "data_api_verify_key"), 1);
    // The shared answer filled the cache.
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
    assert_eq!(count(&h, "data_api_verify_key"), 1);
}

#[tokio::test]
async fn verification_single_flight_shares_a_failure_and_keeps_nothing() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    h.fail_fn(Some(("data_api_verify_key", 500)));
    let held = h.hold("data_api_verify_key");
    let tasks: Vec<_> = (0..5).map(|_| h.spawn_get("/v1/players", &key)).collect();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    held.release();
    for t in tasks {
        assert_eq!(t.await.unwrap(), 503);
    }
    assert_eq!(count(&h, "data_api_verify_key"), 1);
    h.fail_fn(None);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
    assert_eq!(count(&h, "data_api_verify_key"), 2);
}

#[tokio::test]
async fn upstream_cap_keeps_at_most_the_cap_in_flight_and_queues_the_rest() {
    let h = start_with(std::time::Duration::from_millis(5000), 3).await;
    let key = new_key();
    h.grant(&key, &["matches:read"]);
    h.set_rpc("data_api_matches", |_| json!([]));
    h.get("/v1/matches", Some(&key)).await;
    let held = h.hold("data_api_matches");
    let tasks: Vec<_> = (1..=7)
        .map(|i| h.spawn_get(&format!("/v1/matches?offset={i}"), &key))
        .collect();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    // The warm-up call and three held ones.
    assert_eq!(count(&h, "data_api_matches"), 4);
    held.release();
    for t in tasks {
        assert_eq!(t.await.unwrap(), 200);
    }
    assert_eq!(count(&h, "data_api_matches"), 8);
    assert_eq!(h.max_in_flight(), 3);
}

#[tokio::test]
async fn upstream_cap_counts_time_queued_against_the_timeout_and_fails_as_any_timeout_does() {
    // One slot, a 400 ms budget. The first call holds the slot until its own
    // deadline; the second waits 200 ms of its budget in the queue, so it has
    // 200 left once it gets the slot, not a fresh 400.
    let h = start_with(std::time::Duration::from_millis(400), 1).await;
    let key = new_key();
    h.grant(&key, &["matches:read"]);
    h.set_rpc("data_api_matches", |_| json!([]));
    h.get("/v1/matches", Some(&key)).await;
    let held = h.hold("data_api_matches");
    let first = h.spawn_get("/v1/matches?offset=1", &key);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let started = std::time::Instant::now();
    let queued = h.spawn_get("/v1/matches?offset=2", &key);
    assert_eq!(first.await.unwrap(), 503);
    assert_eq!(queued.await.unwrap(), 503);
    let waited = started.elapsed();
    assert!(
        waited >= std::time::Duration::from_millis(350),
        "{waited:?}"
    );
    assert!(waited < std::time::Duration::from_millis(550), "{waited:?}");
    held.release();
    let failures: Vec<Value> = h
        .log_lines()
        .into_iter()
        .filter(|l| l["msg"] == "upstream_failed")
        .collect();
    assert_eq!(
        failures,
        vec![
            json!({"level": "error", "msg": "upstream_failed", "fn": "data_api_matches", "upstream_status": 0});
            2
        ]
    );
}

#[tokio::test]
async fn read_cache_does_not_cache_key_verification_beyond_its_own_contract() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    h.get("/v1/players", Some(&key)).await;
    h.clear_keys();
    h.advance(POSITIVE_TTL_MS + 1);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 401);
}

#[tokio::test]
async fn rate_limits_429_a_key_past_60_requests_a_minute_with_retry_after() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    for _ in 0..60 {
        assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
    }
    let limited = h.get("/v1/players", Some(&key)).await;
    assert_eq!(limited.status, 429);
    assert_eq!(limited.json(), json!({"error": "rate_limited"}));
    let retry: f64 = limited.header("retry-after").unwrap().parse().unwrap();
    assert!(retry >= 1.0);

    h.advance(1000);
    assert_eq!(h.get("/v1/players", Some(&key)).await.status, 200);
}

#[tokio::test]
async fn rate_limits_429_an_address_past_30_failed_lookups_without_blocking_a_cached_valid_key() {
    let h = harness().await;
    let good = new_key();
    h.grant(&good, &["players:read"]);
    assert_eq!(h.get("/v1/players", Some(&good)).await.status, 200);

    for _ in 0..30 {
        assert_eq!(h.get("/v1/players", Some(&new_key())).await.status, 401);
    }
    let lookups = count(&h, "data_api_verify_key");
    let limited = h.get("/v1/players", Some(&new_key())).await;
    assert_eq!(limited.status, 429);
    assert!(limited.header("retry-after").is_some_and(|v| !v.is_empty()));
    assert_eq!(count(&h, "data_api_verify_key"), lookups);

    assert_eq!(h.get("/v1/players", Some(&good)).await.status, 200);
}

#[tokio::test]
async fn logs_redact_the_player_ref_drop_the_query_and_never_log_a_key() {
    let h = harness().await;
    let key = new_key();
    h.grant(&key, &["players:read"]);
    h.get(&format!("/v1/players/{}?key={key}", ref_a()), Some(&key))
        .await;
    h.get(&format!("/nope/{key}"), None).await;
    let all = h.log_text();
    assert!(!all.contains(&ref_a()));
    assert!(!all.contains(&key));
    assert!(!all.contains(&key[7..]));
    let lines = h.log_lines();
    assert_match(
        &lines[0],
        &json!({"method": "GET", "path": "/v1/players/:ref", "status": 200, "key": "11111111"}),
    );
    assert!(lines[0]["ms"].is_number());
    assert_match(
        &lines[1],
        &json!({"method": "GET", "path": "(unmatched)", "status": 404}),
    );
    assert!(lines[1].get("key").is_none());
}
