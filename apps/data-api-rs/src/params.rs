// Query parameter parsing. Every parser either returns a value for the RPC or
// names the parameter it refuses, which the handler turns into
// 400 {"error":"bad_request","parameter":"<name>"}.
//
// TIMESTAMPS MUST BE UTC AND END IN `Z`. An offset or a bare date would be read
// in whatever zone the database happens to use, and its tzdata is stale after
// 2026-11-01, so the only unambiguous form is the one accepted.

use crate::time;

pub const MAX_LIMIT: i64 = 500;
pub const DEFAULT_LIMIT: i64 = 100;
pub const MAX_OFFSET: i64 = 100_000;
pub const DEFAULT_WINDOW_DAYS: i64 = 30;
pub const MAX_WINDOW_DAYS: i64 = 366;

const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Uuid,
    Timestamp,
    Ref,
    Enum(&'static [&'static str]),
    Bool,
    Int { min: i64, max: i64 },
}

/// Every query parameter any route accepts, in documentation order. The drift
/// test checks each one appears in the served documentation and in API.md.
pub const QUERY_PARAMS: [(&str, Kind); 14] = [
    ("season", Kind::Uuid),
    ("since", Kind::Timestamp),
    ("until", Kind::Timestamp),
    ("player", Kind::Ref),
    ("opponent", Kind::Ref),
    ("type", Kind::Enum(&["singles", "doubles"])),
    ("source", Kind::Enum(&["club", "tournament"])),
    ("rated", Kind::Bool),
    ("status", Kind::Enum(&["final", "voided", "all"])),
    ("updated_since", Kind::Timestamp),
    (
        "limit",
        Kind::Int {
            min: 1,
            max: MAX_LIMIT,
        },
    ),
    (
        "offset",
        Kind::Int {
            min: 0,
            max: MAX_OFFSET,
        },
    ),
    ("from", Kind::Timestamp),
    ("to", Kind::Timestamp),
];

#[derive(Debug, Clone, PartialEq)]
pub enum ParamValue {
    Str(String),
    Int(i64),
    Bool(bool),
}

/// Parsed parameters by name.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Params(Vec<(&'static str, ParamValue)>);

impl Params {
    pub fn get(&self, name: &str) -> Option<&ParamValue> {
        self.0.iter().find(|(n, _)| *n == name).map(|(_, v)| v)
    }

    fn str(&self, name: &str) -> Option<&str> {
        match self.get(name) {
            Some(ParamValue::Str(s)) => Some(s),
            _ => None,
        }
    }

    pub fn int(&self, name: &str) -> Option<i64> {
        match self.get(name) {
            Some(ParamValue::Int(n)) => Some(*n),
            _ => None,
        }
    }
}

/// The parameter a request is refused for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadParam(pub String);

fn bad(name: &str) -> BadParam {
    BadParam(name.to_string())
}

fn hex_run(s: &[u8], f: impl Fn(u8) -> bool) -> bool {
    s.iter().all(|b| f(*b))
}

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// data_api_player_ref's and data_api_match_ref's output: `/^[0-9a-f]{64}$/`.
pub fn is_ref(s: &str) -> bool {
    s.len() == 64
        && hex_run(s.as_bytes(), |c| {
            c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
        })
}

/// `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/`.
fn is_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    let d = |r: std::ops::Range<usize>| b.get(r).is_some_and(|x| x.iter().all(u8::is_ascii_digit));
    if b.len() < 17
        || !(d(0..4) && b[4] == b'-' && d(5..7) && b[7] == b'-' && d(8..10) && b[10] == b'T')
        || !(d(11..13) && b[13] == b':' && d(14..16))
    {
        return false;
    }
    let rest = &b[16..];
    match rest {
        [b'Z'] => true,
        [b':', x, y, tail @ ..] if x.is_ascii_digit() && y.is_ascii_digit() => match tail {
            [b'Z'] => true,
            [b'.', frac @ .., b'Z'] => {
                (1..=6).contains(&frac.len()) && frac.iter().all(u8::is_ascii_digit)
            }
            _ => false,
        },
        _ => false,
    }
}

fn parse_one(name: &'static str, kind: Kind, raw: &str) -> Result<ParamValue, BadParam> {
    match kind {
        Kind::Uuid => {
            if !is_uuid(raw) {
                return Err(bad(name));
            }
            Ok(ParamValue::Str(raw.to_ascii_lowercase()))
        }
        Kind::Timestamp => {
            if !is_timestamp(raw) {
                return Err(bad(name));
            }
            let t = time::parse(raw).ok_or_else(|| bad(name))?;
            Ok(ParamValue::Str(time::to_iso(t).ok_or_else(|| bad(name))?))
        }
        Kind::Ref => {
            if !is_ref(raw) {
                return Err(bad(name));
            }
            Ok(ParamValue::Str(raw.to_string()))
        }
        Kind::Enum(values) => {
            if !values.contains(&raw) {
                return Err(bad(name));
            }
            Ok(ParamValue::Str(raw.to_string()))
        }
        Kind::Bool => match raw {
            "true" => Ok(ParamValue::Bool(true)),
            "false" => Ok(ParamValue::Bool(false)),
            _ => Err(bad(name)),
        },
        Kind::Int { min, max } => {
            if raw.is_empty() || raw.len() > 7 || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad(name));
            }
            let n: i64 = raw.parse().map_err(|_| bad(name))?;
            if n < min || n > max {
                return Err(bad(name));
            }
            Ok(ParamValue::Int(n))
        }
    }
}

/// Parses the query string against the names a route accepts. A name the route
/// does not accept, a repeated name, or a value that does not parse is a
/// BadParam. `strict: false` ignores the query string entirely, which is what
/// the two routes that predate parameters have always done.
pub fn parse_query(
    search: &[(String, String)],
    allowed: &[&'static str],
    strict: bool,
) -> Result<Params, BadParam> {
    let mut out = Params::default();
    if !strict {
        return Ok(out);
    }
    for (name, raw) in search {
        let Some(&known) = allowed.iter().find(|a| **a == name) else {
            return Err(BadParam(name.clone()));
        };
        if out.get(known).is_some() {
            return Err(BadParam(name.clone()));
        }
        let kind = QUERY_PARAMS
            .iter()
            .find(|(n, _)| *n == known)
            .map(|(_, k)| *k)
            .expect("known parameter");
        out.0.push((known, parse_one(known, kind, raw)?));
    }
    if let (Some(since), Some(until)) = (out.str("since"), out.str("until")) {
        // String order, as JavaScript compares the two ISO strings.
        if until <= since {
            return Err(bad("until"));
        }
    }
    if out.get("opponent").is_some() && out.get("player").is_none() && allowed.contains(&"player") {
        return Err(bad("opponent"));
    }
    Ok(out)
}

/// The schedule window. Defaults to the next 30 days from now; one bound given
/// alone gets a 30-day window on its other side; wider than 366 days, or an end
/// not after the start, is refused.
pub fn schedule_window(params: &Params, now_ms: i64) -> Result<(String, String), BadParam> {
    let mut from = params.str("from").and_then(time::parse);
    let mut to = params.str("to").and_then(time::parse);
    if from.is_none() && to.is_none() {
        from = Some(now_ms);
    }
    let from = match from {
        Some(f) => f,
        None => to.expect("one bound") - DEFAULT_WINDOW_DAYS * DAY_MS,
    };
    let to = *to.get_or_insert(from + DEFAULT_WINDOW_DAYS * DAY_MS);
    if to <= from || to - from > MAX_WINDOW_DAYS * DAY_MS {
        return Err(bad("to"));
    }
    match (time::to_iso(from), time::to_iso(to)) {
        (Some(f), Some(t)) => Ok((f, t)),
        // toISOString's RangeError; not reachable from a pattern-checked bound.
        _ => Err(bad("to")),
    }
}
