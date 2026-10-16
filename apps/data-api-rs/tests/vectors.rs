// The JavaScript semantics this crate emulates, checked against vectors that
// Node 24 produced (TZ=UTC). Regenerate them with tests/vectors/generate.mjs if
// the emulation ever has to cover more inputs.

use data_api_rs::json::{self, Out};
use data_api_rs::{config, time, url};
use serde_json::Value;

fn vectors(name: &str) -> Vec<Value> {
    let path = format!("{}/tests/vectors/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).expect("vector file");
    match serde_json::from_str(&text).expect("vector json") {
        Value::Array(v) => v,
        _ => panic!("{name} is not an array"),
    }
}

/// Inputs V8 reads only through its legacy fallback parser, which is not
/// ported: they are NaN here. None of them is ISO 8601 as PostgREST prints it,
/// and none passes the query parameters' timestamp pattern.
const LEGACY_ONLY: [&str; 12] = [
    "2026-01-01 00:00:00+00",
    "2026-01-01 00:00:00",
    "2026-9-14",
    "Mon, 14 Sep 2026 04:11:55 GMT",
    "2026/09/14",
    "09/14/2026",
    " 2026-09-14",
    "1",
    "12",
    "123",
    "12345",
    "2026-09-14Z",
];

#[test]
fn date_parse_matches_v8() {
    let mut failures = Vec::new();
    for v in vectors("dates") {
        let input = v["in"].as_str().unwrap();
        let want = v["iso"].as_str();
        let got = time::parse(input).and_then(time::to_iso);
        if LEGACY_ONLY.contains(&input) {
            assert!(
                want.is_some(),
                "{input:?} is listed as legacy-only but V8 rejects it"
            );
            if got.is_some() {
                failures.push(format!(
                    "{input:?}: legacy-only, expected NaN here, got {got:?}"
                ));
            }
            continue;
        }
        if got.as_deref() != want {
            failures.push(format!("{input:?}: want {want:?}, got {got:?}"));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn to_iso_string_matches_v8() {
    for v in vectors("iso") {
        let ms = v["ms"].as_f64().unwrap() as i64;
        assert_eq!(time::to_iso(ms).as_deref(), v["iso"].as_str(), "{ms}");
    }
}

#[test]
fn json_round_trip_matches_v8() {
    for v in vectors("json") {
        let input = v["in"].as_str().unwrap();
        let parsed = json::parse_body(input.as_bytes()).expect("parses");
        assert_eq!(
            Out::Raw(parsed).to_json(),
            v["out"].as_str().unwrap(),
            "{input}"
        );
    }
}

#[test]
fn port_matches_v8() {
    for v in vectors("ports") {
        let input = v["in"].as_str().unwrap();
        let ok = v["ok"].as_bool().unwrap();
        let got = config::port_from(Some(input));
        assert_eq!(got.is_ok(), ok, "{input:?}: {got:?}");
        if ok {
            assert_eq!(
                got.unwrap().to_string(),
                v["port"].as_str().unwrap(),
                "{input:?}"
            );
        }
    }
}

#[test]
fn request_targets_match_whatwg_url() {
    let mut failures = Vec::new();
    for v in vectors("targets") {
        let input = v["in"].as_str().unwrap();
        let got = url::parse_target(input);
        match (&v["error"], got) {
            (Value::String(_), Err(_)) => {}
            (Value::String(e), Ok(p)) => {
                failures.push(format!("{input:?}: want {e}, got {:?}", p.pathname))
            }
            (_, Err(_)) => {
                failures.push(format!("{input:?}: want {}, got an error", v["pathname"]))
            }
            (_, Ok(p)) => {
                if p.pathname != v["pathname"].as_str().unwrap() {
                    failures.push(format!(
                        "{input:?}: pathname want {}, got {:?}",
                        v["pathname"], p.pathname
                    ));
                }
                let params = p
                    .query
                    .as_deref()
                    .map(url::search_params)
                    .unwrap_or_default();
                let want: Vec<(String, String)> = v["params"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|pair| {
                        (
                            pair[0].as_str().unwrap().to_string(),
                            pair[1].as_str().unwrap().to_string(),
                        )
                    })
                    .collect();
                if params != want {
                    failures.push(format!("{input:?}: params want {want:?}, got {params:?}"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn base_urls_match_whatwg_url() {
    for v in vectors("base-urls") {
        let input = v["in"].as_str().unwrap();
        let got = url::parse_absolute(input);
        assert_eq!(
            got.is_ok(),
            v["ok"].as_bool().unwrap(),
            "{input:?}: {got:?}"
        );
        if let (Ok(p), Some(protocol)) = (got, v["protocol"].as_str()) {
            assert_eq!(format!("{}:", p.scheme), protocol, "{input:?}");
        }
    }
}

#[test]
fn js_string_matches_v8() {
    for v in vectors("strings") {
        assert_eq!(
            json::js_string(Some(&v["in"])),
            v["out"].as_str().unwrap(),
            "{}",
            v["in"]
        );
    }
}
