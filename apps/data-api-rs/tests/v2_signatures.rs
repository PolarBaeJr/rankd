// PostgREST matches an RPC to a function by its argument NAMES, so a v2 reader
// whose parameters drift from what the service sends 404s exactly like a v2
// that does not exist yet, and the service would quietly serve v1 for ever.
// This reads 00277 off disk and holds the two together.

mod common;

use common::*;
use data_api_rs::scopes::DATA_API_SCOPES;
use serde_json::json;

const TOURNAMENT: &str = "22222222-0000-0000-0000-000000000001";
const EVENT: &str = "33333333-0000-0000-0000-000000000001";

/// Each `CREATE OR REPLACE FUNCTION public.<name>_v2(<args>)` in 00277, with
/// its argument names sorted.
fn v2_args() -> Vec<(String, Vec<String>)> {
    let sql = read_repo_file("supabase/migrations/00277_the_data_api_serves_staged_draws.sql");
    let marker = "CREATE OR REPLACE FUNCTION public.";
    let mut out = Vec::new();
    for part in sql.split(marker).skip(1) {
        let Some(open) = part.find('(') else { continue };
        let name = &part[..open];
        if !name.ends_with("_v2") || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            continue;
        }
        let args = &part[open + 1..open + 1 + part[open + 1..].find(')').expect("args end")];
        let mut names: Vec<String> = args
            .split(',')
            .map(|a| a.split_whitespace().next().unwrap_or("").to_string())
            .collect();
        names.sort();
        out.push((name.to_string(), names));
    }
    out
}

#[test]
fn defines_the_three_the_service_calls() {
    let mut names: Vec<String> = v2_args().into_iter().map(|(n, _)| n).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "data_api_tournament_draw_v2",
            "data_api_tournament_entrants_v2",
            "data_api_tournament_events_v2"
        ]
    );
}

#[tokio::test]
async fn take_exactly_the_argument_names_the_service_sends() {
    let h = start().await;
    h.set_rpc("data_api_tournaments", |_| json!([{"id": TOURNAMENT}]));
    h.set_rpc("data_api_tournament_events_v2", |_| json!([{"id": EVENT}]));
    h.set_rpc("data_api_tournament_entrants_v2", |_| json!([]));
    h.set_rpc("data_api_tournament_draw_v2", |_| json!([]));
    let key = new_key();
    h.grant(&key, &DATA_API_SCOPES);

    assert_eq!(
        h.get(&format!("/v1/tournaments/{TOURNAMENT}"), Some(&key))
            .await
            .status,
        200
    );
    assert_eq!(
        h.get(
            &format!("/v1/tournaments/{TOURNAMENT}/events/{EVENT}"),
            Some(&key)
        )
        .await
        .status,
        200
    );
    for (name, args) in v2_args() {
        let calls = h.all(&name);
        assert!(!calls.is_empty(), "{name}");
        for body in calls {
            let mut sent = keys(&body);
            sent.sort();
            assert_eq!(sent, args, "{name}");
        }
    }
}
