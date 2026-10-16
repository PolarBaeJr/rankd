// Every keyed route: scopes, methods, parameters, the shapes served, and the
// v2 readers' fallback. The fixtures carry `leak` in every column a later
// migration might add; none of it may reach a consumer.

mod common;

use std::collections::HashSet;

use common::*;
use data_api_rs::params::QUERY_PARAMS;
use data_api_rs::scopes::DATA_API_SCOPES;
use data_api_rs::server::ROUTES;
use hyper::Method;
use serde_json::{Map, Value, json};

const SEASON: &str = "15af1db0-ac97-499d-b583-98082a921368";
const TOURNAMENT: &str = "22222222-0000-0000-0000-000000000001";
const EVENT: &str = "33333333-0000-0000-0000-000000000001";

fn ref_a() -> String {
    "a".repeat(64)
}
fn ref_b() -> String {
    "b".repeat(64)
}
fn match_ref() -> String {
    "d".repeat(64)
}
fn ext_ref_a() -> String {
    "f".repeat(64)
}
fn ext_ref_b() -> String {
    "9".repeat(64)
}

/// `{...a, ...b}`.
fn spread(a: &Value, b: &Value) -> Value {
    let mut out = a.as_object().cloned().unwrap_or_default();
    for (k, v) in b.as_object().cloned().unwrap_or_default() {
        out.insert(k, v);
    }
    Value::Object(out)
}

fn match_row(i: usize) -> Value {
    json!({
        "match_ref": match_ref(),
        "source": "club",
        "status": "confirmed",
        "counts_toward_stats": true,
        "played_at": format!("2026-09-1{}T04:11:55.123456+00:00", i % 10),
        "updated_at": "2026-09-14T05:00:00+00:00",
        "season_id": SEASON,
        "season_name": "Fall 2026",
        "discipline": "singles",
        "kind": "ranked",
        "rated": true,
        "format": "best_of_3",
        "games_per_match": 3,
        "points_per_game": 21,
        "walkover": null,
        "winner_side": "a",
        "score_summary": "21-15, 21-18",
        "games": [
            {"game": 1, "a": 21, "b": 15, "notes": "leak"},
            {"game": 2, "a": 21, "b": 18},
        ],
        "sides": {
            "a": [{
                "player_ref": ref_a(),
                "won": true,
                "rating": {"before": 1200, "after": 1216, "delta": 16, "player_id": "leak"},
                "points_scored": 42,
                "points_allowed": 33,
                "games_won": 2,
                "games_lost": 0,
                "full_name": "leak",
                "email": "leak",
            }],
            "b": [{"player_ref": ref_b(), "won": false, "rating": null, "points_scored": 33, "points_allowed": 42, "games_won": 0, "games_lost": 2}],
        },
        "tournament": null,
        // Columns a later migration might add. None may reach a consumer.
        "notes": "leak",
        "walkover_reason": "leak",
        "player_id": "leak",
    })
}

fn season_row() -> Value {
    json!({
        "id": SEASON,
        "name": "Fall 2026",
        "term": "fall",
        "year": 2026,
        "start_date": "2026-09-01",
        "end_date": "2026-12-15",
        "active": true,
        "club_matches": 3,
        "tournament_matches": 2,
        "players_with_matches": 4,
        "sessions": 10,
        "tournaments": 1,
        "events": 2,
        "hidden_flag": false,
    })
}

fn tournament_row() -> Value {
    json!({
        "id": TOURNAMENT,
        "name": "Fall Open",
        "season_id": SEASON,
        "season_name": "Fall 2026",
        "start_date": "2026-10-01",
        "end_date": "2026-10-02",
        "status": "completed",
        "suspended": false,
        "event_multiplier": 1.5,
        "placement_bonus_enabled": true,
        // Never served: only an entry path may read the cap (00201's fence).
        "max_events_per_player": 2,
        "suspension_reason": "leak",
        "waiver_text": "leak",
    })
}

fn event_row() -> Value {
    json!({
        "id": EVENT,
        "event_type": "mens_doubles",
        "format": "single_elimination",
        "match_format": "best_of_3",
        "games_per_match": 3,
        "points_per_game": 21,
        "max_participants": 16,
        "seeding_method": "elo",
        "elo_multiplier": 1,
        "placement_bonus_enabled": true,
        "status": "completed",
        "group_count": null,
        "qualifiers_per_group": null,
        "seeded_from_event_id": null,
        "external_event": false,
        "notes": "leak",
    })
}

// A staged event (00272) as data_api_tournament_events_v2 might send it, with
// bait in every place the stored config carries something that is not served.
fn staged_event_row() -> Value {
    let scoring = json!({"best_of": 1, "target": 21, "win_by_two": true, "cap": 30, "handicap": true, "forfeit": null});
    spread(
        &event_row(),
        &json!({
            "event_type": "open_doubles",
            "format": "staged",
            "rated": false,
            "current_stage": 2,
            "stages": [
                {
                    "index": 1,
                    "key": "groups",
                    "name": "Group stage",
                    "kind": "groups",
                    "rated": false,
                    "scoring": spread(&scoring, &json!({"forfeit": {"winner": 21, "loser": 0, "court": "leak"}})),
                    "pools": 2,
                    "groups_per_pool": 2,
                    "group_size": "auto",
                    "tiebreaks": ["wins", "leak", "point_diff", 7],
                    "size": null,
                    "third_place": null,
                    "matches": null,
                    "courts": {"mode": "shared", "courts": ["leak"]},
                    "entrants": "leak",
                    "assignment": "leak",
                },
                {
                    "index": 2,
                    "key": "finals",
                    "name": "Finals",
                    "kind": "matches",
                    "rated": false,
                    "scoring": scoring,
                    "pools": null,
                    "groups_per_pool": null,
                    "group_size": null,
                    "tiebreaks": null,
                    "size": null,
                    "third_place": null,
                    "matches": [{"label": "final", "name": "Final", "winner_place": 1, "loser_place": 2, "court": "leak", "a": "leak"}],
                },
            ],
            "categories": [
                {"key": "mens", "label": "Men's", "note": "leak"},
                {"key": "womens", "label": "Women's"},
            ],
            "head_starts": {"womens": {"mens": 3, "mixed": "leak"}, "mixed": "leak"},
            "points_table": {"by_place": [50, 30, "leak"], "rest": 5, "participation": 1, "per_win": 2, "bonuses": "leak"},
            "leak": "leak",
        }),
    )
}

fn staged_event() -> Value {
    json!({
        "id": EVENT,
        "event_type": "open_doubles",
        "format": "staged",
        "match_format": "best_of_3",
        "games_per_match": 3,
        "points_per_game": 21,
        "max_participants": 16,
        "seeding_method": "elo",
        "elo_multiplier": 1,
        "placement_bonus_enabled": true,
        "status": "completed",
        "group_count": null,
        "qualifiers_per_group": null,
        "seeded_from_event_id": null,
        "rated": false,
        "current_stage": 2,
        "external": false,
        "stages": [
            {
                "index": 1,
                "key": "groups",
                "name": "Group stage",
                "kind": "groups",
                "rated": false,
                "scoring": {"best_of": 1, "target": 21, "win_by_two": true, "cap": 30, "handicap": true, "forfeit": {"winner": 21, "loser": 0}},
                "pools": 2,
                "groups_per_pool": 2,
                "group_size": "auto",
                "tiebreaks": ["wins", "point_diff"],
                "size": null,
                "third_place": null,
                "matches": null,
            },
            {
                "index": 2,
                "key": "finals",
                "name": "Finals",
                "kind": "matches",
                "rated": false,
                "scoring": {"best_of": 1, "target": 21, "win_by_two": true, "cap": 30, "handicap": true, "forfeit": null},
                "pools": null,
                "groups_per_pool": null,
                "group_size": null,
                "tiebreaks": null,
                "size": null,
                "third_place": null,
                "matches": [{"label": "final", "name": "Final", "winner_place": 1, "loser_place": 2}],
            },
        ],
        "categories": [
            {"key": "mens", "label": "Men's"},
            {"key": "womens", "label": "Women's"},
        ],
        "head_starts": {"womens": {"mens": 3}},
        "points_table": {"by_place": [50, 30], "rest": 5, "participation": 1, "per_win": 2},
    })
}

// The stage columns data_api_tournament_draw_v2 adds to each row of the v1 draw.
fn draw_stage_columns() -> Vec<Value> {
    vec![
        json!({"stage": 1, "pool_number": 1, "group_number": 2, "slot": 1, "match_label": null, "handicap_a": 3, "handicap_b": 0, "court_id": "leak"}),
        // The withheld slot: its structure is served, its head starts are not.
        json!({"stage": 2, "pool_number": null, "group_number": null, "slot": null, "match_label": "final", "handicap_a": 5, "handicap_b": 0}),
        json!({"stage": 1, "pool_number": 2, "group_number": 1, "slot": 2, "match_label": null, "handicap_a": 0, "handicap_b": 0}),
    ]
}

fn entrants_v1() -> Value {
    json!([
        {
            "event_id": EVENT,
            "player_refs": [ref_a(), ref_b()],
            "seed": 1,
            "status": "active",
            "final_position": 1,
            "group_number": null,
            "points": null,
            "elo_before": null,
            "elo_after": null,
            "elo_change": null,
            "combined_elo": 2216,
            "external": false,
            "external_ref": null,
            "pair_name": "leak",
        },
        {
            "event_id": EVENT,
            "player_refs": [],
            "seed": null,
            "status": "registered",
            "final_position": null,
            "group_number": 1,
            "points": 2,
            "elo_before": null,
            "elo_after": null,
            "elo_change": null,
            "combined_elo": null,
            "external": true,
            "external_ref": ext_ref_a(),
            "pair_name": "leak",
            "external1_name": "leak",
            "external2_name": "leak",
        },
    ])
}

fn draw_v1() -> Value {
    json!([
        {
            "match_ref": match_ref(),
            "round_number": 1,
            "round_name": "Final",
            "phase": "bracket",
            "bracket_position": 1,
            "match_number": 1,
            "is_bye": false,
            "is_third_place": false,
            "scheduled_time": "2026-10-02T20:00:00+00:00",
            "status": "completed",
            "winner_to": null,
            "loser_to": null,
            "withheld": false,
            "sides": {
                "a": [{"player_ref": ref_a(), "external": false, "external_ref": null}],
                "b": [{"player_ref": ref_b(), "external": false, "external_ref": null}],
            },
            "winner_side": "a",
            "games": [{"game": 1, "a": 21, "b": 10}],
            "court": "leak",
            "walkover_reason": "leak",
        },
        {
            "match_ref": "e".repeat(64),
            "round_number": 1,
            "round_name": "Semi",
            "phase": "bracket",
            "bracket_position": 2,
            "match_number": 2,
            "is_bye": false,
            "is_third_place": false,
            "scheduled_time": null,
            "status": "disputed",
            "winner_to": {"match_ref": match_ref(), "position": "b"},
            "loser_to": null,
            "withheld": true,
            // A withheld slot must never carry sides even if the database sent them.
            "sides": {"a": [{"player_ref": ref_a()}], "b": []},
            "winner_side": "a",
            "games": [{"game": 1, "a": 21, "b": 19}],
        },
        {
            "match_ref": "c".repeat(64),
            "round_number": 1,
            "round_name": null,
            "phase": "group",
            "bracket_position": 3,
            "match_number": 3,
            "is_bye": false,
            "is_third_place": false,
            "scheduled_time": null,
            "status": "completed",
            "winner_to": null,
            "loser_to": null,
            "withheld": false,
            "sides": {
                "a": [{"player_ref": null, "external": true, "external_ref": ext_ref_a(), "name": "leak"}],
                "b": [{"player_ref": null, "external": true, "external_ref": ext_ref_b()}],
            },
            "winner_side": "b",
            "games": [{"game": 1, "a": 9, "b": 15}],
        },
    ])
}

fn answer_all(h: &Harness) {
    let published: HashSet<String> = [ref_a(), ref_b()].into_iter().collect();
    h.set_rpc("data_api_player_published", move |b| {
        if b["p_player_ref"]
            .as_str()
            .is_some_and(|r| published.contains(r))
        {
            json!([{"published": true}])
        } else {
            json!([])
        }
    });
    h.set_rpc("data_api_matches", |_| json!([match_row(0)]));
    h.set_rpc("data_api_match_by_ref", |b| {
        if b["p_match_ref"] == match_ref() {
            json!([match_row(0)])
        } else {
            json!([])
        }
    });
    h.set_rpc("data_api_head_to_head", |_| {
        json!([
            {"relation": "opponents", "discipline": "singles", "matches": 3, "wins": 2, "losses": 1},
            {"relation": "partners", "discipline": "doubles", "matches": 1, "wins": 1, "losses": 0},
        ])
    });
    h.set_rpc("data_api_player_seasons", |_| {
        json!([
            {
                "season_id": SEASON,
                "season_name": "Fall 2026",
                "active": true,
                "start_date": "2026-09-01",
                "discipline": "singles",
                "matches": 3,
                "wins": 2,
                "losses": 1,
                "games_won": 5,
                "games_lost": 3,
                "points_scored": 150,
                "points_allowed": 120,
                "final_singles_elo": null,
                "final_doubles_elo": null,
            },
            {
                "season_id": "44444444-0000-0000-0000-000000000001",
                "season_name": "Summer 2026",
                "active": false,
                "start_date": "2026-05-01",
                "discipline": null,
                "matches": null,
                "wins": null,
                "losses": null,
                "games_won": null,
                "games_lost": null,
                "points_scored": null,
                "points_allowed": null,
                "final_singles_elo": 1210,
                "final_doubles_elo": 1100,
            },
        ])
    });
    h.set_rpc("data_api_rating_history", |_| {
        json!([{
            "at": "2026-09-14T04:11:55+00:00",
            "discipline": "singles",
            "kind": "match",
            "source": "club",
            "match_ref": match_ref(),
            "before": 1200,
            "after": 1216,
            "delta": 16,
            "player_id": "leak",
        }])
    });
    h.set_rpc("data_api_seasons", |b| match b.get("p_season_id") {
        None => json!([season_row()]),
        Some(id) if id == SEASON => json!([season_row()]),
        _ => json!([]),
    });
    h.set_rpc("data_api_season_header", |b| {
        if b["p_season_id"] == SEASON {
            json!([{"id": SEASON, "name": "Fall 2026", "active": true}])
        } else {
            json!([])
        }
    });
    h.set_rpc("data_api_season_standings", |_| {
        json!([{
            "source": "live",
            "player_ref": ref_a(),
            "singles_elo": 1216,
            "doubles_elo": 1000,
            "singles_rank": 1,
            "doubles_rank": 2,
            "matches": 3,
            "wins": 2,
            "losses": 1,
            "full_name": "leak",
        }])
    });
    h.set_rpc("data_api_tournaments", |b| match b.get("p_tournament_id") {
        None => json!([tournament_row()]),
        Some(id) if id == TOURNAMENT => json!([tournament_row()]),
        _ => json!([]),
    });
    h.set_rpc("data_api_tournament_events", |b| {
        if b["p_tournament_id"] == TOURNAMENT {
            json!([event_row()])
        } else {
            json!([])
        }
    });
    h.set_rpc("data_api_tournament_entrants", |_| entrants_v1());
    h.set_rpc("data_api_tournament_draw", |_| draw_v1());
    h.set_rpc("data_api_sessions", |_| {
        json!([{
            "id": "55555555-0000-0000-0000-000000000001",
            "name": "Tuesday drop-in",
            "season_id": SEASON,
            "season_name": "Fall 2026",
            "date": "2027-01-19",
            "starts_at": "2027-01-20T02:00:00+00:00",
            "ends_at": "2027-01-20T04:00:00+00:00",
            "location": "Gym",
            "status": "scheduled",
            "track": "drop_in",
            "require_scan_to_check_in": true,
            "rsvp_going": 12,
            "attended": 0,
            "notes": "leak",
        }])
    });
    h.set_rpc("data_api_club_events", |_| {
        json!([{
            "id": "66666666-0000-0000-0000-000000000001",
            "title": "Social",
            "kind": "social",
            "location": "Hall",
            "starts_at": "2027-01-25T02:00:00+00:00",
            "ends_at": null,
            "status": "published",
            "cancelled_at": null,
            "capacity": 40,
            "cost_cents": 500,
            "signup_opens_at": null,
            "signup_closes_at": null,
            "signups": 7,
            "description": "leak",
        }])
    });
    h.set_rpc("data_api_tournament_events_v2", |b| {
        if b["p_tournament_id"] == TOURNAMENT {
            json!([staged_event_row()])
        } else {
            json!([])
        }
    });
    h.set_rpc("data_api_tournament_entrants_v2", |_| {
        let rows = entrants_v1().as_array().cloned().unwrap();
        let cats = ["mens", "womens"];
        Value::Array(
            rows.iter()
                .enumerate()
                .map(|(i, r)| spread(r, &json!({"team_category": cats[i.min(1)]})))
                .collect(),
        )
    });
    h.set_rpc("data_api_tournament_draw_v2", |_| {
        let rows = draw_v1().as_array().cloned().unwrap();
        let cols = draw_stage_columns();
        Value::Array(
            rows.iter()
                .enumerate()
                .map(|(i, r)| spread(r, &cols[i]))
                .collect(),
        )
    });
}

struct T {
    h: Harness,
    key: String,
}

async fn setup() -> T {
    let h = start().await;
    h.set_players(vec![player_row(&ref_a()), player_row(&ref_b())]);
    answer_all(&h);
    let key = new_key();
    h.grant(&key, &DATA_API_SCOPES);
    T { h, key }
}

impl T {
    async fn get(&self, path: &str) -> Res {
        self.h.get(path, Some(&self.key)).await
    }

    async fn body(&self, path: &str) -> Value {
        let res = self.get(path).await;
        assert_eq!(res.status, 200, "{path}: {}", res.text());
        res.json()
    }

    fn all(&self, fn_name: &str) -> Vec<Value> {
        self.h.all(fn_name)
    }
}

fn concrete(template: &str) -> String {
    let id = if template.starts_with("/v1/seasons") {
        SEASON
    } else {
        TOURNAMENT
    };
    template
        .replacen(":other_ref", &ref_b(), 1)
        .replacen(":match_ref", &match_ref(), 1)
        .replacen(":ref", &ref_a(), 1)
        .replacen(":event_id", EVENT, 1)
        .replacen(":id", id, 1)
}

/// The keyed read routes. The writes have their own file, tests/writes.rs.
fn keyed() -> impl Iterator<Item = &'static data_api_rs::server::RouteDef> {
    ROUTES
        .iter()
        .filter(|r| r.scope.is_some() && r.methods.is_none())
}

fn no_leak(v: &Value) {
    let s = v.to_string();
    assert!(!s.contains("leak"), "leaked: {s}");
}

fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().expect("an object")
}

#[tokio::test]
async fn every_keyed_route_answers_200_with_an_all_scopes_key() {
    let t = setup().await;
    for r in keyed() {
        t.body(&concrete(r.template)).await;
    }
}

#[tokio::test]
async fn every_keyed_route_403s_a_key_without_its_scope() {
    for r in keyed() {
        let t = setup().await;
        let scope = r.scope.unwrap();
        let other = new_key();
        let scopes: Vec<&str> = DATA_API_SCOPES
            .iter()
            .copied()
            .filter(|s| *s != scope)
            .collect();
        t.h.grant_as(
            &other,
            &scopes,
            "77777777-2222-3333-4444-555555555555",
            CONSUMER,
        );
        let res = t.h.get(&concrete(r.template), Some(&other)).await;
        assert_eq!(res.status, 403, "{}", r.template);
        assert_eq!(
            res.json(),
            json!({"error": "forbidden", "detail": format!("this key does not carry {scope}")})
        );
        assert_eq!(t.h.fns(), ["data_api_verify_key"], "{}", r.template);
    }
}

#[tokio::test]
async fn every_keyed_route_405s_a_post_before_auth() {
    for r in keyed() {
        let t = setup().await;
        let res =
            t.h.request(Method::POST, &concrete(r.template), None, &[])
                .await;
        assert_eq!(res.status, 405, "{}", r.template);
        assert_eq!(res.header("allow"), Some("GET"));
        assert!(t.h.calls().is_empty());
    }
}

#[tokio::test]
async fn every_strict_route_400s_an_unknown_parameter_without_asking_the_database() {
    for r in keyed().filter(|r| r.strict) {
        let t = setup().await;
        let res = t.get(&format!("{}?bogus=1", concrete(r.template))).await;
        assert_eq!(res.status, 400, "{}", r.template);
        assert_eq!(
            res.json(),
            json!({"error": "bad_request", "parameter": "bogus"})
        );
        assert_eq!(t.h.fns(), ["data_api_verify_key"], "{}", r.template);
    }
}

/// `template.replace(/:[a-z_]+/g, 'nope')`.
fn nope(template: &str) -> String {
    let mut out = String::new();
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c == ':'
            && chars
                .peek()
                .is_some_and(|n| n.is_ascii_lowercase() || *n == '_')
        {
            while chars
                .peek()
                .is_some_and(|n| n.is_ascii_lowercase() || *n == '_')
            {
                chars.next();
            }
            out.push_str("nope");
        } else {
            out.push(c);
        }
    }
    out
}

#[tokio::test]
async fn every_path_param_route_404s_a_malformed_value_without_asking_the_database() {
    for r in keyed().filter(|r| r.template.contains(':')) {
        let t = setup().await;
        let res = t.get(&nope(r.template)).await;
        assert_eq!(res.status, 404, "{}", r.template);
        assert_eq!(t.h.fns(), ["data_api_verify_key"], "{}", r.template);
    }
}

#[tokio::test]
async fn the_two_routes_that_predate_parameters_still_ignore_the_query_string() {
    let t = setup().await;
    assert_eq!(t.get("/v1/players?bogus=1").await.status, 200);
    assert_eq!(
        t.get(&format!("/v1/players/{}?bogus=1", ref_a()))
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn players_season_fills_the_season_block_from_the_active_season() {
    let t = setup().await;
    t.h.set_rpc("data_api_active_season", |_| {
        json!([spread(&season_row(), &json!({"hidden_flag": false}))])
    });
    let b = t.body("/v1/players").await;
    assert_eq!(
        b["season"],
        json!({"id": SEASON, "name": "Fall 2026", "term": "fall", "year": 2026, "start_date": "2026-09-01", "end_date": "2026-12-15"})
    );
}

#[tokio::test]
async fn players_season_falls_back_to_null_never_503_when_the_season_read_fails() {
    let t = setup().await;
    t.h.fail_fn(Some(("data_api_active_season", 500)));
    let b = t.body("/v1/players").await;
    assert_eq!(b["season"], Value::Null);
    assert_eq!(b["count"], 2);
    let warn =
        t.h.log_lines()
            .into_iter()
            .find(|l| l["msg"] == "season_unavailable");
    assert_eq!(
        warn,
        Some(
            json!({"level": "warn", "msg": "season_unavailable", "fn": "data_api_active_season", "upstream_status": 500})
        )
    );
}

#[tokio::test]
async fn matches_passes_every_filter_through_and_asks_for_one_row_more_than_the_page() {
    let t = setup().await;
    let q = [
        ("season", SEASON.to_uppercase()),
        ("since", "2026-09-01T00:00:00Z".into()),
        ("until", "2026-10-01T00:00:00Z".into()),
        ("player", ref_a()),
        ("opponent", ref_b()),
        ("type", "singles".into()),
        ("source", "club".into()),
        ("rated", "true".into()),
        ("status", "all".into()),
        ("updated_since", "2026-09-02T00:00:00Z".into()),
        ("limit", "5".into()),
        ("offset", "10".into()),
    ]
    .iter()
    .map(|(k, v)| format!("{k}={v}"))
    .collect::<Vec<_>>()
    .join("&");
    t.body(&format!("/v1/matches?{q}")).await;
    assert_eq!(
        t.all("data_api_matches"),
        [json!({
            "p_consumer_id": CONSUMER,
            "p_season": SEASON,
            "p_since": "2026-09-01T00:00:00.000Z",
            "p_until": "2026-10-01T00:00:00.000Z",
            "p_player_ref": ref_a(),
            "p_opponent_ref": ref_b(),
            "p_type": "singles",
            "p_source": "club",
            "p_rated": true,
            "p_status": "all",
            "p_updated_since": "2026-09-02T00:00:00.000Z",
            "p_limit": 6,
            "p_offset": 10,
        })]
    );
}

#[tokio::test]
async fn matches_sets_next_offset_only_when_another_page_follows() {
    let t = setup().await;
    t.h.set_rpc("data_api_matches", |b| {
        let n = b["p_limit"].as_u64().unwrap() as usize;
        Value::Array((0..n).map(match_row).collect())
    });
    let full = t.body("/v1/matches?limit=2&offset=4").await;
    assert_match(
        &full,
        &json!({"count": 2, "limit": 2, "offset": 4, "next_offset": 6}),
    );
    assert_eq!(full["matches"].as_array().unwrap().len(), 2);

    t.h.set_rpc("data_api_matches", |_| json!([match_row(0)]));
    assert_match(
        &t.body("/v1/matches?limit=2&offset=6").await,
        &json!({"count": 1, "next_offset": null}),
    );
}

#[tokio::test]
async fn matches_400s_a_bad_parameter_naming_it() {
    let opponent_alone = format!("opponent={}", ref_b());
    let cases: [(&str, &str); 17] = [
        ("limit=0", "limit"),
        ("limit=501", "limit"),
        ("offset=-1", "offset"),
        ("offset=100001", "offset"),
        ("since=2026-09-01", "since"),
        ("since=2026-09-01T00:00:00%2B01:00", "since"),
        ("until=yesterday", "until"),
        (
            "since=2026-09-02T00:00:00Z&until=2026-09-01T00:00:00Z",
            "until",
        ),
        (
            "since=2026-09-02T00:00:00Z&until=2026-09-02T00:00:00Z",
            "until",
        ),
        ("player=abc", "player"),
        (&opponent_alone, "opponent"),
        ("type=mixed", "type"),
        ("source=ladder", "source"),
        ("rated=1", "rated"),
        ("status=pending", "status"),
        ("season=fall", "season"),
        ("limit=5&limit=6", "limit"),
    ];
    let t = setup().await;
    for (query, parameter) in cases {
        let res = t.get(&format!("/v1/matches?{query}")).await;
        assert_eq!(res.status, 400, "{query}");
        assert_eq!(
            res.json(),
            json!({"error": "bad_request", "parameter": parameter}),
            "{query}"
        );
    }
}

#[tokio::test]
async fn matches_serves_the_whitelisted_shape_and_nothing_else() {
    let t = setup().await;
    let b = t.body("/v1/matches").await;
    assert_eq!(
        keys(&b),
        [
            "generated_at",
            "count",
            "limit",
            "offset",
            "next_offset",
            "matches"
        ]
    );
    assert_eq!(
        b["matches"][0],
        json!({
            "match_ref": match_ref(),
            "source": "club",
            "status": "confirmed",
            "counts_toward_stats": true,
            "played_at": "2026-09-10T04:11:55Z",
            "updated_at": "2026-09-14T05:00:00Z",
            "season": {"id": SEASON, "name": "Fall 2026"},
            "type": "singles",
            "kind": "ranked",
            "rated": true,
            "format": "best_of_3",
            "games_per_match": 3,
            "points_per_game": 21,
            "walkover": null,
            "winner_side": "a",
            "score_summary": "21-15, 21-18",
            "games": [
                {"game": 1, "a": 21, "b": 15},
                {"game": 2, "a": 21, "b": 18},
            ],
            "sides": {
                "a": [{
                    "player_ref": ref_a(),
                    "won": true,
                    "rating": {"before": 1200, "after": 1216, "delta": 16},
                    "points_scored": 42,
                    "points_allowed": 33,
                    "games_won": 2,
                    "games_lost": 0,
                }],
                "b": [{"player_ref": ref_b(), "won": false, "rating": null, "points_scored": 33, "points_allowed": 42, "games_won": 0, "games_lost": 2}],
            },
            "tournament": null,
        })
    );
    no_leak(&b);
}

#[tokio::test]
async fn matches_shapes_the_tournament_block_and_both_walkover_forms() {
    let t = setup().await;
    t.h.set_rpc("data_api_matches", |_| {
        json!([
            spread(
                &match_row(0),
                &json!({
                    "source": "tournament",
                    "walkover": {"winner_side": "b", "reason": "leak"},
                    "tournament": {
                        "id": TOURNAMENT,
                        "event_id": EVENT,
                        "event_type": "mens_singles",
                        "round_number": 2,
                        "round_name": "Final",
                        "phase": null,
                        "is_third_place": false,
                        "stage": 2,
                        "match_label": "final",
                        "handicap_a": 3,
                        "handicap_b": 0,
                        "court": "leak",
                        "court_id": "leak",
                    },
                })
            ),
            spread(
                &match_row(0),
                &json!({"walkover": {"type": "forfeit", "forfeit_side": "b", "reason": "leak"}})
            ),
        ])
    });
    let b = t.body("/v1/matches").await;
    let (tm, c) = (&b["matches"][0], &b["matches"][1]);
    assert_eq!(tm["walkover"], json!({"winner_side": "b"}));
    assert_eq!(
        tm["tournament"],
        json!({
            "id": TOURNAMENT,
            "event_id": EVENT,
            "event_type": "mens_singles",
            "round_number": 2,
            "round_name": "Final",
            "phase": null,
            "is_third_place": false,
            "stage": 2,
            "match_label": "final",
            "handicap_a": 3,
            "handicap_b": 0,
        })
    );
    assert_eq!(
        c["walkover"],
        json!({"type": "forfeit", "forfeit_side": "b"})
    );
    no_leak(&b["matches"]);
}

#[tokio::test]
async fn match_returns_one_match_and_404s_an_unknown_ref() {
    let t = setup().await;
    let b = t.body(&format!("/v1/matches/{}", match_ref())).await;
    assert_eq!(b["match"]["match_ref"], match_ref());
    assert_eq!(
        t.all("data_api_match_by_ref"),
        [json!({"p_consumer_id": CONSUMER, "p_match_ref": match_ref()})]
    );
    assert_eq!(
        t.get(&format!("/v1/matches/{}", "f".repeat(64)))
            .await
            .status,
        404
    );
}

#[tokio::test]
async fn player_subroutes_404_an_unpublished_ref_after_one_check() {
    for tail in [
        "matches".to_string(),
        "seasons".into(),
        "ratings".into(),
        format!("vs/{}", ref_b()),
    ] {
        let t = setup().await;
        let res = t
            .get(&format!("/v1/players/{}/{tail}", "c".repeat(64)))
            .await;
        assert_eq!(res.status, 404, "{tail}");
        assert_eq!(
            t.h.fns(),
            ["data_api_verify_key", "data_api_player_published"],
            "{tail}"
        );
    }
}

#[tokio::test]
async fn player_matches_pins_the_player_from_the_path_and_lets_opponent_stand_alone() {
    let t = setup().await;
    let b = t
        .body(&format!(
            "/v1/players/{}/matches?opponent={}&limit=3",
            ref_a(),
            ref_b()
        ))
        .await;
    assert_eq!(b["player_ref"], ref_a());
    let sent = t.all("data_api_matches");
    assert_eq!(
        sent,
        [
            json!({"p_consumer_id": CONSUMER, "p_opponent_ref": ref_b(), "p_player_ref": ref_a(), "p_limit": 4, "p_offset": 0})
        ]
    );
    // The JSON sent upstream keeps the Node service's key order.
    assert_eq!(
        keys(&sent[0]),
        [
            "p_consumer_id",
            "p_opponent_ref",
            "p_player_ref",
            "p_limit",
            "p_offset"
        ]
    );
    let res = t
        .get(&format!(
            "/v1/players/{}/matches?player={}",
            ref_a(),
            ref_b()
        ))
        .await;
    assert_eq!(res.status, 400);
    assert_eq!(
        res.json(),
        json!({"error": "bad_request", "parameter": "player"})
    );
}

#[tokio::test]
async fn vs_checks_both_refs_folds_the_totals_and_adds_recent_matches() {
    let t = setup().await;
    let b = t
        .body(&format!(
            "/v1/players/{}/vs/{}?type=singles",
            ref_a(),
            ref_b()
        ))
        .await;
    let checked: Vec<Value> = t
        .all("data_api_player_published")
        .into_iter()
        .map(|x| x["p_player_ref"].clone())
        .collect();
    assert_eq!(checked, [json!(ref_a()), json!(ref_b())]);
    assert_eq!(
        t.all("data_api_head_to_head"),
        [
            json!({"p_consumer_id": CONSUMER, "p_player_ref": ref_a(), "p_other_ref": ref_b(), "p_type": "singles"})
        ]
    );
    assert_eq!(
        t.all("data_api_matches"),
        [
            json!({"p_consumer_id": CONSUMER, "p_type": "singles", "p_player_ref": ref_a(), "p_opponent_ref": ref_b(), "p_limit": 10})
        ]
    );
    assert_match(
        &b,
        &json!({
            "player_ref": ref_a(),
            "other_ref": ref_b(),
            "as_opponents": {"singles": {"matches": 3, "wins": 2, "losses": 1}, "doubles": {"matches": 0, "wins": 0, "losses": 0}},
            "as_partners": {"doubles": {"matches": 1, "wins": 1, "losses": 0}},
        }),
    );
    assert_eq!(b["recent"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn vs_404s_a_player_against_themself() {
    let t = setup().await;
    assert_eq!(
        t.get(&format!("/v1/players/{}/vs/{}", ref_a(), ref_a()))
            .await
            .status,
        404
    );
    assert!(t.all("data_api_head_to_head").is_empty());
}

#[tokio::test]
async fn vs_404s_when_the_other_player_is_unpublished() {
    let t = setup().await;
    assert_eq!(
        t.get(&format!("/v1/players/{}/vs/{}", ref_a(), "c".repeat(64)))
            .await
            .status,
        404
    );
    assert!(t.all("data_api_head_to_head").is_empty());
}

#[tokio::test]
async fn seasons_groups_rows_per_season_zero_fills_and_carries_the_final_rating() {
    let t = setup().await;
    let b = t.body(&format!("/v1/players/{}/seasons", ref_a())).await;
    let zero = json!({"matches": 0, "wins": 0, "losses": 0, "games_won": 0, "games_lost": 0, "points_scored": 0, "points_allowed": 0});
    assert_eq!(
        b["seasons"],
        json!([
            {
                "season": {"id": SEASON, "name": "Fall 2026", "active": true, "start_date": "2026-09-01"},
                "singles": {"matches": 3, "wins": 2, "losses": 1, "games_won": 5, "games_lost": 3, "points_scored": 150, "points_allowed": 120},
                "doubles": zero,
                "final_rating": null,
            },
            {
                "season": {"id": "44444444-0000-0000-0000-000000000001", "name": "Summer 2026", "active": false, "start_date": "2026-05-01"},
                "singles": zero,
                "doubles": zero,
                "final_rating": {"singles": 1210, "doubles": 1100},
            },
        ])
    );
}

#[tokio::test]
async fn ratings_pages_the_journal_and_strips_unknown_columns() {
    let t = setup().await;
    let b = t
        .body(&format!(
            "/v1/players/{}/ratings?type=singles&season={SEASON}&limit=1",
            ref_a()
        ))
        .await;
    assert_eq!(
        t.all("data_api_rating_history"),
        [
            json!({"p_consumer_id": CONSUMER, "p_player_ref": ref_a(), "p_type": "singles", "p_season": SEASON, "p_limit": 2, "p_offset": 0})
        ]
    );
    assert_match(
        &b,
        &json!({"player_ref": ref_a(), "count": 1, "limit": 1, "offset": 0, "next_offset": null}),
    );
    assert_eq!(
        b["history"],
        json!([{
            "at": "2026-09-14T04:11:55Z",
            "type": "singles",
            "kind": "match",
            "source": "club",
            "match_ref": match_ref(),
            "before": 1200,
            "after": 1216,
            "delta": 16,
        }])
    );
}

#[tokio::test]
async fn seasons_lists_seasons_with_totals_and_nothing_else() {
    let t = setup().await;
    let b = t.body("/v1/seasons").await;
    assert_eq!(
        t.all("data_api_seasons"),
        [json!({"p_consumer_id": CONSUMER})]
    );
    assert_eq!(
        b["seasons"],
        json!([{
            "id": SEASON,
            "name": "Fall 2026",
            "term": "fall",
            "year": 2026,
            "start_date": "2026-09-01",
            "end_date": "2026-12-15",
            "active": true,
            "totals": {"club_matches": 3, "tournament_matches": 2, "players_with_matches": 4, "sessions": 10, "tournaments": 1, "events": 2},
        }])
    );
}

#[tokio::test]
async fn season_lowercases_the_id_and_404s_an_unknown_one() {
    let t = setup().await;
    t.body(&format!("/v1/seasons/{}", SEASON.to_uppercase()))
        .await;
    assert_eq!(
        t.all("data_api_seasons"),
        [json!({"p_consumer_id": CONSUMER, "p_season_id": SEASON})]
    );
    assert_eq!(
        t.get(&format!("/v1/seasons/{TOURNAMENT}")).await.status,
        404
    );
}

#[tokio::test]
async fn standings_checks_the_season_first_and_whitelists_each_row() {
    let t = setup().await;
    let b = t.body(&format!("/v1/seasons/{SEASON}/standings")).await;
    assert_match(
        &b,
        &json!({"source": "live", "count": 1, "season": {"id": SEASON, "name": "Fall 2026", "active": true}}),
    );
    assert_eq!(
        b["standings"],
        json!([{
            "player_ref": ref_a(),
            "singles_elo": 1216,
            "doubles_elo": 1000,
            "singles_rank": 1,
            "doubles_rank": 2,
            "record": {"matches": 3, "wins": 2, "losses": 1},
        }])
    );
    assert_eq!(
        t.get(&format!("/v1/seasons/{TOURNAMENT}/standings"))
            .await
            .status,
        404
    );
    assert_eq!(t.all("data_api_season_standings").len(), 1);
    // The header, never the totals scan.
    assert!(t.all("data_api_seasons").is_empty());
}

#[tokio::test]
async fn tournaments_lists_filtered_by_season() {
    let t = setup().await;
    let b = t.body(&format!("/v1/tournaments?season={SEASON}")).await;
    assert_eq!(
        t.all("data_api_tournaments"),
        [json!({"p_consumer_id": CONSUMER, "p_season": SEASON})]
    );
    no_leak(&b);
    let first = &b["tournaments"][0];
    assert_match(
        first,
        &json!({"id": TOURNAMENT, "season": {"id": SEASON, "name": "Fall 2026"}, "suspended": false}),
    );
    assert!(first.get("max_events_per_player").is_none());
}

#[tokio::test]
async fn tournament_detail_nests_entrants_under_their_event() {
    let t = setup().await;
    let b = t.body(&format!("/v1/tournaments/{TOURNAMENT}")).await;
    let events = b["tournament"]["events"].as_array().unwrap();
    let args = json!({"p_consumer_id": CONSUMER, "p_tournament_id": TOURNAMENT});
    assert_eq!(
        t.all("data_api_tournament_events_v2"),
        std::slice::from_ref(&args)
    );
    assert_eq!(t.all("data_api_tournament_entrants_v2"), [args]);
    assert!(t.all("data_api_tournament_events").is_empty());
    assert!(t.all("data_api_tournament_entrants").is_empty());
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["external"], false);
    assert_eq!(
        events[0]["entrants"],
        json!([
            {
                "players": [{"player_ref": ref_a()}, {"player_ref": ref_b()}],
                "external": false,
                "external_ref": null,
                "seed": 1,
                "status": "active",
                "final_position": 1,
                "group": null,
                "points": null,
                "elo": {"before": null, "after": null, "change": null},
                "combined_elo": 2216,
                "team_category": "mens",
            },
            // An external team (00269): no players, an anonymous ref, and no name.
            {
                "players": [],
                "external": true,
                "external_ref": ext_ref_a(),
                "seed": null,
                "status": "registered",
                "final_position": null,
                "group": 1,
                "points": 2,
                "elo": {"before": null, "after": null, "change": null},
                "combined_elo": null,
                "team_category": "womens",
            },
        ])
    );
    no_leak(&b);
    assert_eq!(
        t.get(&format!("/v1/tournaments/{SEASON}")).await.status,
        404
    );
}

#[tokio::test]
async fn event_draw_withholds_a_slot_entirely_and_never_serves_a_court() {
    let t = setup().await;
    let b = t
        .body(&format!("/v1/tournaments/{TOURNAMENT}/events/{EVENT}"))
        .await;
    assert_eq!(
        t.all("data_api_tournament_draw_v2"),
        [json!({"p_consumer_id": CONSUMER, "p_event_id": EVENT})]
    );
    assert!(t.all("data_api_tournament_draw").is_empty());
    let (shown, withheld, external) = (&b["draw"][0], &b["draw"][1], &b["draw"][2]);
    assert_match(
        shown,
        &json!({
            "withheld": false,
            "sides": {
                "a": [{"player_ref": ref_a(), "external": false, "external_ref": null}],
                "b": [{"player_ref": ref_b(), "external": false, "external_ref": null}],
            },
        }),
    );
    assert_match(
        external,
        &json!({
            "withheld": false,
            "sides": {
                "a": [{"player_ref": null, "external": true, "external_ref": ext_ref_a()}],
                "b": [{"player_ref": null, "external": true, "external_ref": ext_ref_b()}],
            },
            "winner_side": "b",
        }),
    );
    assert_match(
        withheld,
        &json!({
            "withheld": true,
            "sides": null,
            "winner_side": null,
            "games": null,
            "winner_to": {"match_ref": match_ref(), "position": "b"},
        }),
    );
    no_leak(&b);
    assert!(shown.get("court").is_none());
    assert!(shown.get("court_id").is_none());
    for stage in b["event"]["stages"].as_array().unwrap() {
        assert!(stage.get("courts").is_none());
        for m in stage["matches"].as_array().into_iter().flatten() {
            assert!(m.get("court").is_none());
        }
    }
}

#[tokio::test]
async fn serves_a_staged_event_from_an_allowlist() {
    let t = setup().await;
    let b = t.body(&format!("/v1/tournaments/{TOURNAMENT}")).await;
    let mut event = obj(&b["tournament"]["events"][0]);
    let entrants = event.shift_remove("entrants").unwrap();
    assert_eq!(Value::Object(event.clone()), staged_event());
    assert_eq!(
        event.keys().collect::<Vec<_>>(),
        obj(&staged_event()).keys().collect::<Vec<_>>()
    );
    assert_eq!(entrants.as_array().unwrap().len(), 2);
    no_leak(&b["tournament"]);
}

#[tokio::test]
async fn serves_the_stage_columns_of_a_draw_and_no_head_start_on_a_withheld_slot() {
    let t = setup().await;
    let b = t
        .body(&format!("/v1/tournaments/{TOURNAMENT}/events/{EVENT}"))
        .await;
    assert_eq!(b["event"], staged_event());
    assert_match(
        &b["draw"][0],
        &json!({"stage": 1, "pool_number": 1, "group_number": 2, "slot": 1, "match_label": null, "handicap_a": 3, "handicap_b": 0}),
    );
    assert_match(
        &b["draw"][1],
        &json!({
            "withheld": true,
            "stage": 2,
            "pool_number": null,
            "group_number": null,
            "slot": null,
            "match_label": "final",
            "handicap_a": null,
            "handicap_b": null,
        }),
    );
}

#[tokio::test]
async fn falls_back_to_the_v1_readers_while_postgrest_does_not_know_the_v2_ones() {
    let t = setup().await;
    let with_v2 = t
        .body(&format!("/v1/tournaments/{TOURNAMENT}/events/{EVENT}"))
        .await;
    let event_keys = keys(&with_v2["event"]);
    let draw_keys = keys(&with_v2["draw"][0]);
    let entrant_keys = keys(
        &t.body(&format!("/v1/tournaments/{TOURNAMENT}")).await["tournament"]["events"][0]["entrants"]
            [0],
    );

    let h = start().await;
    h.set_players(vec![player_row(&ref_a()), player_row(&ref_b())]);
    answer_all(&h);
    h.grant(&t.key, &DATA_API_SCOPES);
    for f in [
        "data_api_tournament_events_v2",
        "data_api_tournament_entrants_v2",
        "data_api_tournament_draw_v2",
    ] {
        h.remove_rpc(f);
    }
    let t = T {
        h,
        key: t.key.clone(),
    };

    let tb = t.body(&format!("/v1/tournaments/{TOURNAMENT}")).await;
    let mut event = obj(&tb["tournament"]["events"][0]);
    let entrants = event.shift_remove("entrants").unwrap();
    let mut expect_event_keys = event_keys.clone();
    expect_event_keys.retain(|k| k != "entrants");
    assert_eq!(event.keys().cloned().collect::<Vec<_>>(), expect_event_keys);
    assert_match(
        &Value::Object(event),
        &json!({
            "format": "single_elimination",
            "rated": null,
            "current_stage": null,
            "stages": null,
            "categories": null,
            "head_starts": null,
            "points_table": null,
        }),
    );
    let first = &entrants[0];
    assert_eq!(keys(first), entrant_keys);
    assert_eq!(first["team_category"], Value::Null);

    let b = t
        .body(&format!("/v1/tournaments/{TOURNAMENT}/events/{EVENT}"))
        .await;
    let row = &b["draw"][0];
    assert_eq!(keys(row), draw_keys);
    assert_match(
        row,
        &json!({"stage": null, "match_label": null, "handicap_a": null, "handicap_b": null}),
    );
    no_leak(&json!([tb, b]));

    // Each v2 was asked once: a missing one is not asked again for a minute.
    for f in [
        "data_api_tournament_events_v2",
        "data_api_tournament_entrants_v2",
        "data_api_tournament_draw_v2",
        "data_api_tournament_events",
        "data_api_tournament_entrants",
        "data_api_tournament_draw",
    ] {
        assert_eq!(t.all(f).len(), 1, "{f}");
    }
    let warns: Vec<Value> =
        t.h.log_lines()
            .into_iter()
            .filter(|l| l["msg"] == "v2_unavailable")
            .collect();
    assert_eq!(
        warns,
        [
            json!({"level": "warn", "msg": "v2_unavailable", "fn": "data_api_tournament_events_v2", "upstream_status": 404}),
            json!({"level": "warn", "msg": "v2_unavailable", "fn": "data_api_tournament_entrants_v2", "upstream_status": 404}),
            json!({"level": "warn", "msg": "v2_unavailable", "fn": "data_api_tournament_draw_v2", "upstream_status": 404}),
        ]
    );

    t.h.advance(60_001);
    t.body(&format!("/v1/tournaments/{TOURNAMENT}/events/{EVENT}"))
        .await;
    assert_eq!(t.all("data_api_tournament_events_v2").len(), 2);
}

#[tokio::test]
async fn a_v2_that_fails_is_a_503_never_a_reason_to_read_v1() {
    let t = setup().await;
    t.h.fail_fn(Some(("data_api_tournament_draw_v2", 500)));
    let res = t
        .get(&format!("/v1/tournaments/{TOURNAMENT}/events/{EVENT}"))
        .await;
    assert_eq!(res.status, 503);
    assert!(t.all("data_api_tournament_draw").is_empty());
    assert!(!t.h.log_text().contains("v2_unavailable"));
}

#[tokio::test]
async fn event_404s_when_the_event_is_not_in_that_tournament() {
    let t = setup().await;
    let res = t
        .get(&format!("/v1/tournaments/{TOURNAMENT}/events/{SEASON}"))
        .await;
    assert_eq!(res.status, 404);
    assert!(t.all("data_api_tournament_draw_v2").is_empty());
    assert!(t.all("data_api_tournament_draw").is_empty());
}

#[tokio::test]
async fn sessions_default_to_the_next_30_days() {
    let t = setup().await;
    let b = t.body("/v1/sessions").await;
    assert_match(
        &b,
        &json!({"from": "2027-01-15T08:00:00Z", "to": "2027-02-14T08:00:00Z", "count": 1}),
    );
    assert_eq!(
        t.all("data_api_sessions"),
        [
            json!({"p_consumer_id": CONSUMER, "p_from": "2027-01-15T08:00:00.000Z", "p_to": "2027-02-14T08:00:00.000Z"})
        ]
    );
    assert_match(
        &b["sessions"][0],
        &json!({"counts": {"rsvp_going": 12, "attended": 0}}),
    );
    no_leak(&b);
}

#[tokio::test]
async fn a_lone_to_gets_30_days_before_it() {
    let t = setup().await;
    let b = t.body("/v1/events?to=2026-10-31T00:00:00Z").await;
    assert_match(
        &b,
        &json!({"from": "2026-10-01T00:00:00Z", "to": "2026-10-31T00:00:00Z"}),
    );
    assert_match(
        &b["events"][0],
        &json!({"title": "Social", "counts": {"signups": 7}}),
    );
    no_leak(&b);
}

#[tokio::test]
async fn schedule_400s_a_bad_window_naming_the_parameter() {
    let cases = [
        ("from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z", "to"),
        ("from=2026-01-01T00:00:00Z&to=2027-01-03T00:00:00Z", "to"),
        ("from=today", "from"),
        ("since=2026-10-01T00:00:00Z", "since"),
    ];
    for (query, parameter) in cases {
        let t = setup().await;
        let res = t.get(&format!("/v1/sessions?{query}")).await;
        assert_eq!(res.status, 400, "{query}");
        assert_eq!(
            res.json(),
            json!({"error": "bad_request", "parameter": parameter})
        );
        assert!(t.all("data_api_sessions").is_empty());
    }
}

#[tokio::test]
async fn logs_on_the_new_routes_log_the_template_never_a_ref_id_or_query() {
    let t = setup().await;
    t.get(&format!(
        "/v1/players/{}/vs/{}?type=singles",
        ref_a(),
        ref_b()
    ))
    .await;
    t.get(&format!("/v1/matches/{}", match_ref())).await;
    t.get(&format!("/v1/matches?player={}", ref_a())).await;
    t.get(&format!("/v1/tournaments/{TOURNAMENT}/events/{EVENT}"))
        .await;
    let text = t.h.log_text();
    for secret in [
        ref_a(),
        ref_b(),
        match_ref(),
        TOURNAMENT.into(),
        EVENT.into(),
        "singles".into(),
        t.key.clone(),
    ] {
        assert!(!text.contains(&secret), "{secret}");
    }
    let paths: Vec<Value> =
        t.h.log_lines()
            .into_iter()
            .map(|l| l["path"].clone())
            .collect();
    assert_eq!(
        paths,
        [
            json!("/v1/players/:ref/vs/:other_ref"),
            json!("/v1/matches/:match_ref"),
            json!("/v1/matches"),
            json!("/v1/tournaments/:id/events/:event_id"),
        ]
    );
}

#[test]
fn every_route_scope_is_a_real_scope_and_every_scope_is_used() {
    // Every keyed route, the writes included.
    let used: HashSet<&str> = ROUTES.iter().filter_map(|r| r.scope).collect();
    for s in &used {
        assert!(DATA_API_SCOPES.contains(s), "{s}");
    }
    for s in DATA_API_SCOPES {
        assert!(used.contains(s), "{s}");
    }
}

#[test]
fn every_route_param_is_a_known_parameter() {
    for r in ROUTES {
        for p in r.params {
            assert!(QUERY_PARAMS.iter().any(|(n, _)| n == p), "{p}");
        }
    }
}
