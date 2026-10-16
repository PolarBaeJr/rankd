// Shapers. Each builds its output from a fixed field list, so a column the
// database grows can never reach a consumer by accident.
//
// A row that is null cannot be read (the TypeError the Node service answered
// with 503); `get` returns that error. Any other non-object row simply has no
// fields, and a nested value that is not an object reads as empty, exactly as
// the JavaScript did.

use serde_json::{Map, Value};

use crate::json::{Out, TypeError, get, get_opt, is_str, truthy};
use crate::time;

pub type Shaped = Result<Out, TypeError>;

pub const PLAYER_FIELDS: [&str; 12] = [
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
];

pub const EVENT_FIELDS: [&str; 16] = [
    "id",
    "event_type",
    "format",
    "match_format",
    "games_per_match",
    "points_per_game",
    "max_participants",
    "seeding_method",
    "elo_multiplier",
    "placement_bonus_enabled",
    "status",
    "group_count",
    "qualifiers_per_group",
    "seeded_from_event_id",
    "rated",
    "current_stage",
];

/// STAGE_TIEBREAKS in packages/shared staged-format/schema.ts.
pub const STAGE_TIEBREAKS: [&str; 7] = [
    "wins",
    "point_diff",
    "points_for",
    "points_against_low",
    "game_diff",
    "h2h",
    "seed",
];

/// Second precision, `Z`, as API.md prints it. PostgREST sends `+00:00` and
/// micros. A non-string, or a string Date.parse cannot read, passes through.
pub fn iso_seconds(v: Option<&Value>) -> Out {
    match v {
        None => Out::Undef,
        Some(Value::String(s)) => match time::iso_seconds(s) {
            Some(iso) => Out::Str(iso),
            None => Out::Str(s.clone()),
        },
        Some(other) => Out::Raw(other.clone()),
    }
}

/// `isoSeconds(orNull(v))`.
fn iso_or_null(v: Option<&Value>) -> Out {
    match v {
        None => Out::Null,
        some => iso_seconds(some),
    }
}

fn as_object(v: Option<&Value>) -> Option<&Map<String, Value>> {
    match v {
        Some(Value::Object(o)) => Some(o),
        _ => None,
    }
}

fn as_array(v: Option<&Value>) -> &[Value] {
    match v {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

/// `orNull(o.key)` where `o` is `asObject(x) ?? {}`.
fn of(o: Option<&Map<String, Value>>, key: &str) -> Out {
    Out::from(o.and_then(|o| o.get(key)))
}

pub fn num(v: Option<&Value>) -> Out {
    match v {
        Some(Value::Number(n)) => Out::Raw(Value::Number(n.clone())),
        _ => Out::Num(0.0),
    }
}

fn num_or_null(v: Option<&Value>) -> Out {
    match v {
        Some(n @ Value::Number(_)) => Out::Raw(n.clone()),
        _ => Out::Null,
    }
}

fn bool_or_null(v: Option<&Value>) -> Out {
    match v {
        Some(b @ Value::Bool(_)) => Out::Raw(b.clone()),
        _ => Out::Null,
    }
}

fn str_or_null(v: Option<&Value>) -> Out {
    match v {
        Some(s @ Value::String(_)) => Out::Raw(s.clone()),
        _ => Out::Null,
    }
}

fn num_or_auto(v: Option<&Value>) -> Out {
    match v {
        Some(n @ Value::Number(_)) => Out::Raw(n.clone()),
        Some(s) if is_str(Some(s), "auto") => Out::str("auto"),
        _ => Out::Null,
    }
}

fn f(row: &Value, key: &str) -> Shaped {
    Ok(Out::from(get(row, key)?))
}

pub fn shape_player(row: &Value) -> Shaped {
    let mut out = Vec::new();
    for field in PLAYER_FIELDS {
        let v = get(row, field)?;
        out.push((
            field.to_string(),
            if field == "updated_at" {
                iso_seconds(v)
            } else {
                Out::from(v)
            },
        ));
    }
    Ok(Out::Obj(out))
}

fn shape_games(v: Option<&Value>) -> Out {
    Out::Arr(
        as_array(v)
            .iter()
            .map(|g| {
                let o = as_object(Some(g));
                Out::obj([
                    ("game", of(o, "game")),
                    ("a", of(o, "a")),
                    ("b", of(o, "b")),
                ])
            })
            .collect(),
    )
}

fn shape_rating(v: Option<&Value>) -> Out {
    match as_object(v) {
        Some(o) => Out::obj([
            ("before", of(Some(o), "before")),
            ("after", of(Some(o), "after")),
            ("delta", of(Some(o), "delta")),
        ]),
        None => Out::Null,
    }
}

fn shape_side(v: Option<&Value>) -> Out {
    Out::Arr(
        as_array(v)
            .iter()
            .map(|p| {
                let o = as_object(Some(p));
                Out::obj([
                    ("player_ref", of(o, "player_ref")),
                    ("won", of(o, "won")),
                    ("rating", shape_rating(o.and_then(|o| o.get("rating")))),
                    ("points_scored", of(o, "points_scored")),
                    ("points_allowed", of(o, "points_allowed")),
                    ("games_won", of(o, "games_won")),
                    ("games_lost", of(o, "games_lost")),
                ])
            })
            .collect(),
    )
}

// A draw side. An external team (00269) is one element with no player_ref and
// an external_ref; a member is one element each, with external false.
fn shape_ref_side(v: Option<&Value>) -> Out {
    Out::Arr(
        as_array(v)
            .iter()
            .map(|p| {
                let o = as_object(Some(p));
                Out::obj([
                    ("player_ref", of(o, "player_ref")),
                    (
                        "external",
                        Out::Bool(matches!(
                            o.and_then(|o| o.get("external")),
                            Some(Value::Bool(true))
                        )),
                    ),
                    ("external_ref", of(o, "external_ref")),
                ])
            })
            .collect(),
    )
}

fn shape_season_ref(id: Option<&Value>, name: Option<&Value>) -> Out {
    if truthy(id) {
        Out::obj([("id", Out::from(id)), ("name", Out::from(name))])
    } else {
        Out::Null
    }
}

fn shape_walkover(v: Option<&Value>) -> Out {
    let Some(o) = as_object(v) else {
        return Out::Null;
    };
    // Club walkovers carry a type and the forfeiting side; tournament walkovers
    // record only who advanced.
    if o.contains_key("type") {
        Out::obj([
            ("type", of(Some(o), "type")),
            ("forfeit_side", of(Some(o), "forfeit_side")),
        ])
    } else {
        Out::obj([("winner_side", of(Some(o), "winner_side"))])
    }
}

fn shape_match_tournament(v: Option<&Value>) -> Out {
    let Some(o) = as_object(v) else {
        return Out::Null;
    };
    let o = Some(o);
    Out::obj([
        ("id", of(o, "id")),
        ("event_id", of(o, "event_id")),
        ("event_type", of(o, "event_type")),
        ("round_number", of(o, "round_number")),
        ("round_name", of(o, "round_name")),
        ("phase", of(o, "phase")),
        ("is_third_place", of(o, "is_third_place")),
        ("stage", of(o, "stage")),
        ("match_label", of(o, "match_label")),
        ("handicap_a", of(o, "handicap_a")),
        ("handicap_b", of(o, "handicap_b")),
    ])
}

pub fn shape_match(row: &Value) -> Shaped {
    let sides = as_object(get(row, "sides")?);
    Ok(Out::obj([
        ("match_ref", f(row, "match_ref")?),
        ("source", f(row, "source")?),
        ("status", f(row, "status")?),
        ("counts_toward_stats", f(row, "counts_toward_stats")?),
        ("played_at", iso_or_null(get(row, "played_at")?)),
        ("updated_at", iso_or_null(get(row, "updated_at")?)),
        (
            "season",
            shape_season_ref(get(row, "season_id")?, get(row, "season_name")?),
        ),
        ("type", f(row, "discipline")?),
        ("kind", f(row, "kind")?),
        ("rated", f(row, "rated")?),
        ("format", f(row, "format")?),
        ("games_per_match", f(row, "games_per_match")?),
        ("points_per_game", f(row, "points_per_game")?),
        ("walkover", shape_walkover(get(row, "walkover")?)),
        ("winner_side", f(row, "winner_side")?),
        ("score_summary", f(row, "score_summary")?),
        ("games", shape_games(get(row, "games")?)),
        (
            "sides",
            Out::obj([
                ("a", shape_side(sides.and_then(|s| s.get("a")))),
                ("b", shape_side(sides.and_then(|s| s.get("b")))),
            ]),
        ),
        (
            "tournament",
            shape_match_tournament(get(row, "tournament")?),
        ),
    ]))
}

pub fn shape_active_season(row: &Value) -> Shaped {
    Ok(Out::obj([
        ("id", f(row, "id")?),
        ("name", f(row, "name")?),
        ("term", f(row, "term")?),
        ("year", f(row, "year")?),
        ("start_date", f(row, "start_date")?),
        ("end_date", f(row, "end_date")?),
    ]))
}

pub fn shape_season(row: &Value) -> Shaped {
    let mut out = shape_active_season(row)?.into_fields();
    out.push(("active".into(), f(row, "active")?));
    out.push((
        "totals".into(),
        Out::obj([
            ("club_matches", num(get(row, "club_matches")?)),
            ("tournament_matches", num(get(row, "tournament_matches")?)),
            (
                "players_with_matches",
                num(get(row, "players_with_matches")?),
            ),
            ("sessions", num(get(row, "sessions")?)),
            ("tournaments", num(get(row, "tournaments")?)),
            ("events", num(get(row, "events")?)),
        ]),
    ));
    Ok(Out::Obj(out))
}

pub fn shape_tournament(row: &Value) -> Shaped {
    Ok(Out::obj([
        ("id", f(row, "id")?),
        ("name", f(row, "name")?),
        (
            "season",
            shape_season_ref(get(row, "season_id")?, get(row, "season_name")?),
        ),
        ("start_date", f(row, "start_date")?),
        ("end_date", f(row, "end_date")?),
        ("status", f(row, "status")?),
        ("suspended", f(row, "suspended")?),
        ("event_multiplier", f(row, "event_multiplier")?),
        (
            "placement_bonus_enabled",
            f(row, "placement_bonus_enabled")?,
        ),
    ]))
}

// The structure of a staged event (00272). The database already rebuilds each
// of these from an allowlist; they are rebuilt again here, so a key the stored
// config grows (a stage's courts, say) cannot reach a consumer either way. A
// v1 row has none of them and every one comes back null.
fn shape_scoring(v: Option<&Value>) -> Out {
    let Some(o) = as_object(v) else {
        return Out::Null;
    };
    let forfeit = match as_object(o.get("forfeit")) {
        Some(fo) => Out::obj([
            ("winner", num_or_null(fo.get("winner"))),
            ("loser", num_or_null(fo.get("loser"))),
        ]),
        None => Out::Null,
    };
    Out::obj([
        ("best_of", num_or_null(o.get("best_of"))),
        ("target", num_or_null(o.get("target"))),
        ("win_by_two", bool_or_null(o.get("win_by_two"))),
        ("cap", num_or_null(o.get("cap"))),
        ("handicap", bool_or_null(o.get("handicap"))),
        ("forfeit", forfeit),
    ])
}

fn shape_stages(v: Option<&Value>) -> Out {
    let Some(Value::Array(stages)) = v else {
        return Out::Null;
    };
    Out::Arr(
        stages
            .iter()
            .map(|s| {
                let o = as_object(Some(s));
                let g = |k: &str| o.and_then(|o| o.get(k));
                let tiebreaks = match g("tiebreaks") {
                    Some(Value::Array(t)) => Out::Arr(
                        t.iter()
                            .filter(|x| matches!(x, Value::String(s) if STAGE_TIEBREAKS.contains(&s.as_str())))
                            .map(|x| Out::Raw(x.clone()))
                            .collect(),
                    ),
                    _ => Out::Null,
                };
                let matches = match g("matches") {
                    Some(Value::Array(ms)) => Out::Arr(
                        ms.iter()
                            .map(|m| {
                                let d = as_object(Some(m));
                                let h = |k: &str| d.and_then(|d| d.get(k));
                                Out::obj([
                                    ("label", str_or_null(h("label"))),
                                    ("name", str_or_null(h("name"))),
                                    ("winner_place", num_or_null(h("winner_place"))),
                                    ("loser_place", num_or_null(h("loser_place"))),
                                ])
                            })
                            .collect(),
                    ),
                    _ => Out::Null,
                };
                Out::obj([
                    ("index", num_or_null(g("index"))),
                    ("key", str_or_null(g("key"))),
                    ("name", str_or_null(g("name"))),
                    ("kind", str_or_null(g("kind"))),
                    ("rated", bool_or_null(g("rated"))),
                    ("scoring", shape_scoring(g("scoring"))),
                    ("pools", num_or_null(g("pools"))),
                    ("groups_per_pool", num_or_null(g("groups_per_pool"))),
                    ("group_size", num_or_auto(g("group_size"))),
                    ("tiebreaks", tiebreaks),
                    ("size", num_or_auto(g("size"))),
                    ("third_place", bool_or_null(g("third_place"))),
                    ("matches", matches),
                ])
            })
            .collect(),
    )
}

fn shape_categories(v: Option<&Value>) -> Out {
    let Some(Value::Array(cats)) = v else {
        return Out::Null;
    };
    Out::Arr(
        cats.iter()
            .map(|c| {
                let o = as_object(Some(c));
                Out::obj([
                    ("key", str_or_null(o.and_then(|o| o.get("key")))),
                    ("label", str_or_null(o.and_then(|o| o.get("label")))),
                ])
            })
            .collect(),
    )
}

/// A key JavaScript would not keep as an own property of a plain object:
/// assigning `__proto__` sets the prototype instead, so it never reached the
/// output.
const PROTO: &str = "__proto__";

fn shape_head_starts(v: Option<&Value>) -> Out {
    let Some(o) = as_object(v) else {
        return Out::Null;
    };
    let mut out = Vec::new();
    for (row, cols) in o {
        let Some(c) = as_object(Some(cols)) else {
            continue;
        };
        if row == PROTO {
            continue;
        }
        let starts = c
            .iter()
            .filter(|(col, start)| *col != PROTO && start.is_number())
            .map(|(col, start)| (col.clone(), Out::Raw(start.clone())))
            .collect();
        out.push((row.clone(), Out::Obj(starts)));
    }
    Out::Obj(out)
}

fn shape_points_table(v: Option<&Value>) -> Out {
    let Some(o) = as_object(v) else {
        return Out::Null;
    };
    let rest = match o.get("rest") {
        Some(n @ Value::Number(_)) => Out::Raw(n.clone()),
        _ => Out::Num(0.0),
    };
    Out::obj([
        (
            "by_place",
            Out::Arr(
                as_array(o.get("by_place"))
                    .iter()
                    .filter(|n| n.is_number())
                    .map(|n| Out::Raw(n.clone()))
                    .collect(),
            ),
        ),
        ("rest", rest),
        ("participation", num_or_null(o.get("participation"))),
        ("per_win", num_or_null(o.get("per_win"))),
    ])
}

pub fn shape_event(row: &Value) -> Shaped {
    let mut out = Vec::new();
    for field in EVENT_FIELDS {
        out.push((field.to_string(), f(row, field)?));
    }
    // An event of external teams (00269): unrated, and its entrants have no
    // player_refs.
    out.push((
        "external".into(),
        Out::Bool(matches!(
            get(row, "external_event")?,
            Some(Value::Bool(true))
        )),
    ));
    out.push(("stages".into(), shape_stages(get(row, "stages")?)));
    out.push((
        "categories".into(),
        shape_categories(get(row, "categories")?),
    ));
    out.push((
        "head_starts".into(),
        shape_head_starts(get(row, "head_starts")?),
    ));
    out.push((
        "points_table".into(),
        shape_points_table(get(row, "points_table")?),
    ));
    Ok(Out::Obj(out))
}

pub fn shape_entrant(row: &Value) -> Shaped {
    Ok(Out::obj([
        (
            "players",
            Out::Arr(
                as_array(get(row, "player_refs")?)
                    .iter()
                    .map(|r| Out::obj([("player_ref", Out::Raw(r.clone()))]))
                    .collect(),
            ),
        ),
        (
            "external",
            Out::Bool(matches!(get(row, "external")?, Some(Value::Bool(true)))),
        ),
        ("external_ref", f(row, "external_ref")?),
        ("seed", f(row, "seed")?),
        ("status", f(row, "status")?),
        ("final_position", f(row, "final_position")?),
        ("group", f(row, "group_number")?),
        ("points", f(row, "points")?),
        (
            "elo",
            Out::obj([
                ("before", f(row, "elo_before")?),
                ("after", f(row, "elo_after")?),
                ("change", f(row, "elo_change")?),
            ]),
        ),
        ("combined_elo", f(row, "combined_elo")?),
        ("team_category", f(row, "team_category")?),
    ]))
}

fn shape_link(v: Option<&Value>) -> Out {
    match as_object(v) {
        Some(o) => Out::obj([
            ("match_ref", of(Some(o), "match_ref")),
            ("position", of(Some(o), "position")),
        ]),
        None => Out::Null,
    }
}

pub fn shape_draw_row(row: &Value) -> Shaped {
    // A withheld slot keeps its place in the bracket and loses everything that
    // would say who played it.
    let withheld = matches!(get(row, "withheld")?, Some(Value::Bool(true)));
    let sides = as_object(get(row, "sides")?);
    let hide = |v: Out| if withheld { Out::Null } else { v };
    Ok(Out::obj([
        ("match_ref", f(row, "match_ref")?),
        ("round_number", f(row, "round_number")?),
        ("round_name", f(row, "round_name")?),
        ("phase", f(row, "phase")?),
        ("bracket_position", f(row, "bracket_position")?),
        ("match_number", f(row, "match_number")?),
        ("is_bye", f(row, "is_bye")?),
        ("is_third_place", f(row, "is_third_place")?),
        ("scheduled_time", iso_or_null(get(row, "scheduled_time")?)),
        ("status", f(row, "status")?),
        ("winner_to", shape_link(get(row, "winner_to")?)),
        ("loser_to", shape_link(get(row, "loser_to")?)),
        ("withheld", Out::Bool(withheld)),
        (
            "sides",
            match sides {
                Some(s) if !withheld => Out::obj([
                    ("a", shape_ref_side(s.get("a"))),
                    ("b", shape_ref_side(s.get("b"))),
                ]),
                _ => Out::Null,
            },
        ),
        ("winner_side", hide(f(row, "winner_side")?)),
        ("games", hide(shape_games(get(row, "games")?))),
        ("stage", f(row, "stage")?),
        ("pool_number", f(row, "pool_number")?),
        ("group_number", f(row, "group_number")?),
        ("slot", f(row, "slot")?),
        ("match_label", f(row, "match_label")?),
        ("handicap_a", hide(f(row, "handicap_a")?)),
        ("handicap_b", hide(f(row, "handicap_b")?)),
    ]))
}

pub fn shape_session(row: &Value) -> Shaped {
    Ok(Out::obj([
        ("id", f(row, "id")?),
        ("name", f(row, "name")?),
        (
            "season",
            shape_season_ref(get(row, "season_id")?, get(row, "season_name")?),
        ),
        ("date", f(row, "date")?),
        ("starts_at", iso_or_null(get(row, "starts_at")?)),
        ("ends_at", iso_or_null(get(row, "ends_at")?)),
        ("location", f(row, "location")?),
        ("status", f(row, "status")?),
        ("track", f(row, "track")?),
        (
            "require_scan_to_check_in",
            f(row, "require_scan_to_check_in")?,
        ),
        (
            "counts",
            Out::obj([
                ("rsvp_going", num(get(row, "rsvp_going")?)),
                ("attended", num(get(row, "attended")?)),
            ]),
        ),
    ]))
}

pub fn shape_club_event(row: &Value) -> Shaped {
    Ok(Out::obj([
        ("id", f(row, "id")?),
        ("title", f(row, "title")?),
        ("kind", f(row, "kind")?),
        ("location", f(row, "location")?),
        ("starts_at", iso_or_null(get(row, "starts_at")?)),
        ("ends_at", iso_or_null(get(row, "ends_at")?)),
        ("status", f(row, "status")?),
        ("cancelled_at", iso_or_null(get(row, "cancelled_at")?)),
        ("capacity", f(row, "capacity")?),
        ("cost_cents", f(row, "cost_cents")?),
        ("signup_opens_at", iso_or_null(get(row, "signup_opens_at")?)),
        (
            "signup_closes_at",
            iso_or_null(get(row, "signup_closes_at")?),
        ),
        ("counts", Out::obj([("signups", num(get(row, "signups")?))])),
    ]))
}

pub fn shape_history(row: &Value) -> Shaped {
    Ok(Out::obj([
        ("at", iso_or_null(get(row, "at")?)),
        ("type", f(row, "discipline")?),
        ("kind", f(row, "kind")?),
        ("source", f(row, "source")?),
        ("match_ref", f(row, "match_ref")?),
        ("before", f(row, "before")?),
        ("after", f(row, "after")?),
        ("delta", f(row, "delta")?),
    ]))
}

/// `{matches, wins, losses}` of a row that may be missing (`row?.x`).
pub fn win_loss(row: Option<&Value>) -> Out {
    Out::Obj(win_loss_fields(row))
}

fn win_loss_fields(row: Option<&Value>) -> Vec<(String, Out)> {
    ["matches", "wins", "losses"]
        .into_iter()
        .map(|k| (k.to_string(), num(get_opt(row, k))))
        .collect()
}

pub fn season_record(row: Option<&Value>) -> Out {
    let mut out = win_loss_fields(row);
    for k in ["games_won", "games_lost", "points_scored", "points_allowed"] {
        out.push((k.to_string(), num(get_opt(row, k))));
    }
    Out::Obj(out)
}

/// `rows.map(shaper)`.
pub fn map_rows(rows: &[Value], shaper: fn(&Value) -> Shaped) -> Shaped {
    rows.iter()
        .map(shaper)
        .collect::<Result<Vec<_>, _>>()
        .map(Out::Arr)
}
