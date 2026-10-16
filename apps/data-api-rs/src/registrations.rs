// The shape check for POST /v1/registrations, run before the database is
// asked. The import function in 00283 repeats every check; this copy exists so
// a script's mistake is a 400 naming the field rather than a refused import.
//
// A port of apps/data-api/src/registrations.ts. The body is one Google Form
// response:
//   { "form_id": "...", "response_id": "...", "submitted_at": "<ISO>"?,
//     "email": "...", "name": "...",
//     "entries": [ { "event_id": "<uuid>", "partner_email"?: "...",
//                    "partner_name"?: "...", "category"?: "..." } ]? }
//
// Nothing here is ever logged: the body carries a typed name and email.
//
// Lengths are counted as JavaScript counts them (UTF-16 code units), and
// whitespace is JavaScript's `\s`, so a name the TypeScript service takes is
// one this one takes.

use serde_json::{Map, Value};

use crate::config::is_js_space;
use crate::js_parse;
use crate::json::Out;
use crate::params::is_uuid;
use crate::predictions::BadBody;
use crate::time;

pub const MAX_ENTRIES: usize = 20;

const TOP_FIELDS: [&str; 6] = [
    "form_id",
    "response_id",
    "submitted_at",
    "email",
    "name",
    "entries",
];
const ENTRY_FIELDS: [&str; 4] = ["event_id", "partner_email", "partner_name", "category"];

fn bad(field: impl Into<String>) -> BadBody {
    BadBody(field.into())
}

/// `/^[A-Za-z0-9_.:-]{1,200}$/`.
fn is_id(s: &str) -> bool {
    (1..=200).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`: one `@`, no whitespace, and a dot in the
/// domain with something either side of it.
fn is_email(s: &str) -> bool {
    if s.chars().any(is_js_space) {
        return false;
    }
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    if local.is_empty() || domain.contains('@') {
        return false;
    }
    domain
        .char_indices()
        .any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

/// `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/`.
fn is_submitted_at(s: &str) -> bool {
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
    let mut rest = &b[19..];
    if let [b'.', tail @ ..] = rest {
        let n = tail.iter().take_while(|c| c.is_ascii_digit()).count();
        if !(1..=6).contains(&n) {
            return false;
        }
        rest = &tail[n..];
    }
    match rest {
        [b'Z'] => true,
        [b'+' | b'-', h1, h2, b':', m1, m2] => [h1, h2, m1, m2].iter().all(|c| c.is_ascii_digit()),
        _ => false,
    }
}

/// `value.trim().replace(/\s+/g, ' ')`.
fn squash(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.trim_matches(is_js_space).chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// A free-text field: absent, null and "" are missing; anything but a string
/// is refused; whitespace is trimmed and collapsed; then it is capped.
fn text(
    value: Option<&Value>,
    field: &str,
    max: usize,
    required: bool,
) -> Result<Option<String>, BadBody> {
    let raw = match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) => Some(s),
        Some(_) => return Err(bad(field)),
    };
    let Some(raw) = raw else {
        return if required { Err(bad(field)) } else { Ok(None) };
    };
    let squashed = squash(raw);
    if squashed.is_empty() {
        return if required { Err(bad(field)) } else { Ok(None) };
    }
    if js_parse::length(&squashed) > max {
        return Err(bad(field));
    }
    Ok(Some(squashed))
}

fn email(value: Option<&Value>, field: &str, required: bool) -> Result<Option<String>, BadBody> {
    let Some(raw) = text(value, field, 254, required)? else {
        return Ok(None);
    };
    let lowered = raw.to_lowercase();
    if !is_email(&lowered) {
        return Err(bad(field));
    }
    Ok(Some(lowered))
}

/// The response as the import function takes it: field order as the
/// TypeScript builds it, so `submitted_at` comes after `entries`.
pub fn parse_registration(body: &Value) -> Result<Out, BadBody> {
    let Value::Object(fields) = body else {
        return Err(bad("body"));
    };
    if let Some(extra) = js_parse::keys(fields)
        .into_iter()
        .find(|k| !TOP_FIELDS.contains(k))
    {
        return Err(bad(extra));
    }

    let form_id = text(fields.get("form_id"), "form_id", 200, true)?.unwrap_or_default();
    if !is_id(&form_id) {
        return Err(bad("form_id"));
    }
    let response_id =
        text(fields.get("response_id"), "response_id", 200, true)?.unwrap_or_default();
    if !is_id(&response_id) {
        return Err(bad("response_id"));
    }

    let submitted_at = match fields.get("submitted_at") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if is_submitted_at(s) && time::parse(s).is_some() => Some(s.clone()),
        Some(_) => return Err(bad("submitted_at")),
    };

    let email_out = email(fields.get("email"), "email", true)?.unwrap_or_default();
    let name = text(fields.get("name"), "name", 120, true)?.unwrap_or_default();

    let entries = match fields.get("entries") {
        None => Vec::new(),
        Some(Value::Array(list)) if list.len() <= MAX_ENTRIES => {
            let mut out = Vec::new();
            for (i, entry) in list.iter().enumerate() {
                out.push(Out::Obj(parse_entry(entry, i)?));
            }
            out
        }
        Some(_) => return Err(bad("entries")),
    };

    let mut payload = vec![
        ("form_id".to_string(), Out::Str(form_id)),
        ("response_id".to_string(), Out::Str(response_id)),
        ("email".to_string(), Out::Str(email_out)),
        ("name".to_string(), Out::Str(name)),
        ("entries".to_string(), Out::Arr(entries)),
    ];
    // `if (submittedAt)`: an empty string cannot pass the pattern, so present
    // means truthy.
    if let Some(at) = submitted_at {
        payload.push(("submitted_at".to_string(), Out::Str(at)));
    }
    Ok(Out::Obj(payload))
}

fn parse_entry(entry: &Value, i: usize) -> Result<Vec<(String, Out)>, BadBody> {
    let prefix = format!("entries[{i}].");
    let Value::Object(fields): &Value = entry else {
        return Err(bad(format!("entries[{i}]")));
    };
    let fields: &Map<String, Value> = fields;
    if let Some(extra) = js_parse::keys(fields)
        .into_iter()
        .find(|k| !ENTRY_FIELDS.contains(k))
    {
        return Err(bad(format!("{prefix}{extra}")));
    }
    let event_id = match fields.get("event_id") {
        Some(Value::String(id)) if is_uuid(id) => id.to_ascii_lowercase(),
        _ => return Err(bad(format!("{prefix}event_id"))),
    };
    let mut out = vec![("event_id".to_string(), Out::Str(event_id))];
    let partner_email = email(
        fields.get("partner_email"),
        &format!("{prefix}partner_email"),
        false,
    )?;
    let partner_name = text(
        fields.get("partner_name"),
        &format!("{prefix}partner_name"),
        120,
        false,
    )?;
    let category = text(
        fields.get("category"),
        &format!("{prefix}category"),
        40,
        false,
    )?;
    for (name, value) in [
        ("partner_email", partner_email),
        ("partner_name", partner_name),
        ("category", category),
    ] {
        if let Some(v) = value {
            out.push((name.to_string(), Out::Str(v)));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_email_as_the_pattern_does() {
        for good in ["a@b.c", "a.b@c.d.e", "x@-.-", "\u{e9}@\u{e9}.\u{e9}"] {
            assert!(is_email(good), "{good}");
        }
        for bad in [
            "a@b",
            "a@.b",
            "a@b.",
            "@b.c",
            "a@b@c.d",
            "a b@c.d",
            "a@b\u{a0}.c",
            "ab.c",
            "a@.",
        ] {
            assert!(!is_email(bad), "{bad}");
        }
    }

    #[test]
    fn squashes_javascript_whitespace() {
        assert_eq!(squash("  Guest \u{a0}\u{3000} Person\n"), "Guest Person");
        assert_eq!(squash("\u{feff}"), "");
    }

    #[test]
    fn reads_submitted_at_as_the_pattern_does() {
        for good in [
            "2026-10-08T10:00:00Z",
            "2026-10-08T10:00:00.5-07:00",
            "2026-10-08T10:00:00+05:30",
        ] {
            assert!(is_submitted_at(good), "{good}");
        }
        for bad in [
            "2026-10-08T10:00:00",
            "2026-10-08T10:00:00+0530",
            "2026-10-08T10:00:00.Z",
            "2026-10-08T10:00Z",
        ] {
            assert!(!is_submitted_at(bad), "{bad}");
        }
    }
}
