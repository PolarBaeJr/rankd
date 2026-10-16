// The shape check for POST and DELETE /v1/predictions, run before the database
// is asked. Each refusal names the field, which the handler turns into
// 400 {"error":"bad_request","field":"<path>"}. The write function in 00282
// repeats every check; this copy exists so a caller's mistake is a 400 that
// says where, rather than a refused row that says only what.
//
// A port of apps/data-api/src/predictions.ts. Where a body has more than one
// fault, the one named is the one the TypeScript reaches first, so the keys of
// an object are walked in JavaScript's order (array indexes first).

use serde_json::{Map, Value};

use crate::js_parse;
use crate::params::is_ref;
use crate::time;

pub const MAX_BATCH: usize = 100;
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// How far ahead of the server clock a `made_at` may be.
pub const MADE_AT_SKEW_MS: i64 = 5 * 60_000;

const PREDICTION_FIELDS: [&str; 6] = [
    "format",
    "side_a",
    "side_b",
    "probability",
    "model",
    "made_at",
];
const MATCHUP_FIELDS: [&str; 3] = ["format", "side_a", "side_b"];

/// A refused body, naming the field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadBody(pub String);

fn bad(field: impl Into<String>) -> BadBody {
    BadBody(field.into())
}

/// `/^[A-Za-z0-9 ._:+-]{1,64}$/`.
fn is_model(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'_' | b':' | b'+' | b'-')
        })
}

/// `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/`.
fn is_made_at(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |from: usize, to: usize| {
        b.get(from..to)
            .is_some_and(|x| x.iter().all(u8::is_ascii_digit))
    };
    if b.len() < 20
        || !(digits(0, 4) && b[4] == b'-' && digits(5, 7) && b[7] == b'-' && digits(8, 10))
        || !(b[10] == b'T' && digits(11, 13) && b[13] == b':' && digits(14, 16) && b[16] == b':')
        || !digits(17, 19)
    {
        return false;
    }
    match &b[19..] {
        [b'Z'] => true,
        [b'.', fraction @ .., b'Z'] => {
            (1..=6).contains(&fraction.len()) && fraction.iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

/// The items of a batch: `{"<wrapper>": [...]}`, or one bare item. Returns each
/// item with the prefix its field names are reported under.
fn items_of<'a>(body: &'a Value, wrapper: &str) -> Result<Vec<(&'a Value, String)>, BadBody> {
    let Value::Object(fields) = body else {
        return Err(bad("body"));
    };
    let Some(list) = fields.get(wrapper) else {
        return Ok(vec![(body, String::new())]);
    };
    if let Some(other) = js_parse::keys(fields).into_iter().find(|k| *k != wrapper) {
        return Err(bad(other));
    }
    match list {
        Value::Array(items) if (1..=MAX_BATCH).contains(&items.len()) => Ok(items
            .iter()
            .enumerate()
            .map(|(i, item)| (item, format!("{wrapper}[{i}].")))
            .collect()),
        _ => Err(bad(wrapper)),
    }
}

fn check_matchup<'a>(
    item: &'a Value,
    prefix: &str,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, BadBody> {
    let Value::Object(fields) = item else {
        return Err(bad(if prefix.is_empty() {
            "body".to_string()
        } else {
            prefix[..prefix.len() - 1].to_string()
        }));
    };
    if let Some(extra) = js_parse::keys(fields)
        .into_iter()
        .find(|k| !allowed.contains(k))
    {
        return Err(bad(format!("{prefix}{extra}")));
    }
    if let Some(missing) = allowed.iter().find(|k| !fields.contains_key(**k)) {
        return Err(bad(format!("{prefix}{missing}")));
    }
    let size = match fields.get("format") {
        Some(Value::String(f)) if f == "singles" => 1,
        Some(Value::String(f)) if f == "doubles" => 2,
        _ => return Err(bad(format!("{prefix}format"))),
    };
    let mut seen: Vec<&str> = Vec::new();
    for side in ["side_a", "side_b"] {
        let refused = || bad(format!("{prefix}{side}"));
        let Some(Value::Array(refs)) = fields.get(side) else {
            return Err(refused());
        };
        if refs.len() != size {
            return Err(refused());
        }
        for r in refs {
            match r {
                Value::String(r) if is_ref(r) && !seen.contains(&r.as_str()) => seen.push(r),
                _ => return Err(refused()),
            }
        }
    }
    Ok(fields)
}

/// The body of POST /v1/predictions, as the items the write function takes:
/// each one the object the caller sent, unchanged.
pub fn parse_predictions(body: &Value, now_ms: i64) -> Result<Vec<Value>, BadBody> {
    let mut out = Vec::new();
    for (item, prefix) in items_of(body, "predictions")? {
        let p = check_matchup(item, &prefix, &PREDICTION_FIELDS)?;
        let probability = match p.get("probability") {
            Some(Value::Number(n)) => crate::json::value_f64(n),
            _ => f64::NAN,
        };
        if !probability.is_finite() || !(0.0..=1.0).contains(&probability) {
            return Err(bad(format!("{prefix}probability")));
        }
        if !matches!(p.get("model"), Some(Value::String(m)) if is_model(m)) {
            return Err(bad(format!("{prefix}model")));
        }
        let made = match p.get("made_at") {
            Some(Value::String(s)) if is_made_at(s) => time::parse(s),
            _ => None,
        };
        if made.is_none_or(|t| t > now_ms + MADE_AT_SKEW_MS) {
            return Err(bad(format!("{prefix}made_at")));
        }
        out.push(item.clone());
    }
    Ok(out)
}

/// The body of DELETE /v1/predictions, as the items the delete function takes.
pub fn parse_matchups(body: &Value) -> Result<Vec<Value>, BadBody> {
    let mut out = Vec::new();
    for (item, prefix) in items_of(body, "matchups")? {
        check_matchup(item, &prefix, &MATCHUP_FIELDS)?;
        out.push(item.clone());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_made_at_as_the_pattern_does() {
        for good in [
            "2027-01-15T08:00:00Z",
            "2027-01-15T08:00:00.1Z",
            "2027-01-15T08:00:00.123456Z",
        ] {
            assert!(is_made_at(good), "{good}");
        }
        for bad in [
            "2027-01-15T08:00:00",
            "2027-01-15T08:00:00.Z",
            "2027-01-15T08:00:00.1234567Z",
            "2027-01-15T08:00:00+00:00",
            "2027-01-15 08:00:00Z",
            "2027-01-15T08:00Z",
            "2027-01-15T08:00:00z",
        ] {
            assert!(!is_made_at(bad), "{bad}");
        }
    }

    #[test]
    fn reads_model_as_the_pattern_does() {
        assert!(is_model("elo-v3 1.2:a+b_c"));
        assert!(!is_model(""));
        assert!(!is_model(&"a".repeat(65)));
        assert!(!is_model("elo\nv3"));
        assert!(!is_model("\u{e9}lo"));
    }
}
