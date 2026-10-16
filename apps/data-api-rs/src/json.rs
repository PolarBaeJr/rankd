// JSON output with JavaScript's semantics.
//
// The Node service built every response with JSON.stringify over values that
// came out of JSON.parse. Three things about that pair are not what serde_json
// does by default, and each is visible in a response body:
//
// - Every number is an IEEE double, printed the way Number.prototype.toString
//   prints it (1.0 is `1`, 1e21 is `1e+21`, an integer past 2^53 rounds).
// - An object's keys come out with the array-index keys (canonical integers
//   below 2^32 - 1) first, ascending, and the rest in insertion order.
// - `undefined` is dropped from an object and printed as null in an array.
//
// Upstream values pass through as serde_json::Value (with preserve_order, so a
// repeated key keeps its first position and its last value, as JSON.parse
// does) and are re-serialised here, never by serde_json's own writer.

use serde_json::Value;

/// A response value. `Raw` is an upstream value passed through unchanged.
#[derive(Debug, Clone)]
pub enum Out {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Raw(Value),
    Arr(Vec<Out>),
    Obj(Vec<(String, Out)>),
}

impl Out {
    pub fn str(s: impl Into<String>) -> Out {
        Out::Str(s.into())
    }

    pub fn obj<const N: usize>(fields: [(&str, Out); N]) -> Out {
        Out::Obj(
            fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        )
    }

    /// The fields of an object, for `{...spread, more}`. Anything else spreads
    /// to nothing.
    pub fn into_fields(self) -> Vec<(String, Out)> {
        match self {
            Out::Obj(fields) => fields,
            _ => Vec::new(),
        }
    }

    pub fn to_json(&self) -> String {
        let mut s = String::new();
        write_out(&mut s, self);
        s
    }
}

impl From<Option<&Value>> for Out {
    /// `orNull`: a missing value is null, anything else passes through.
    fn from(v: Option<&Value>) -> Out {
        match v {
            None => Out::Null,
            Some(v) => Out::Raw(v.clone()),
        }
    }
}

/// A JavaScript number as Number.prototype.toString prints it.
pub fn js_number(n: f64) -> String {
    if !n.is_finite() {
        // JSON.stringify prints NaN and the infinities as null.
        return "null".to_string();
    }
    if n == 0.0 {
        return "0".to_string();
    }
    let mut buf = ryu_js::Buffer::new();
    buf.format_finite(n).to_string()
}

/// The f64 JSON.parse would have produced for a serde_json number.
pub fn value_f64(n: &serde_json::Number) -> f64 {
    n.as_f64().unwrap_or(f64::NAN)
}

/// Whether a key is an array index, which JavaScript orders before every other
/// key of an object.
fn is_array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    if n < u32::MAX as u64 {
        Some(n as u32)
    } else {
        None
    }
}

/// Keys in JavaScript's own-property order.
fn js_key_order<'a, T>(entries: impl Iterator<Item = (&'a str, T)>) -> Vec<(&'a str, T)> {
    let mut index: Vec<(u32, &'a str, T)> = Vec::new();
    let mut named: Vec<(&'a str, T)> = Vec::new();
    for (k, v) in entries {
        match is_array_index(k) {
            Some(i) => index.push((i, k, v)),
            None => named.push((k, v)),
        }
    }
    if index.is_empty() {
        return named;
    }
    index.sort_by_key(|(i, _, _)| *i);
    let mut out: Vec<(&'a str, T)> = index.into_iter().map(|(_, k, v)| (k, v)).collect();
    out.extend(named);
    out
}

/// Bare keys in JavaScript's own-property order, as `Object.keys` lists them.
pub fn js_key_order_of<'a>(keys: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    js_key_order(keys.map(|k| (k, ())))
        .into_iter()
        .map(|(k, _)| k)
        .collect()
}

pub fn write_str(s: &mut String, v: &str) {
    s.push('"');
    for c in v.chars() {
        match c {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            '\u{08}' => s.push_str("\\b"),
            '\u{0c}' => s.push_str("\\f"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            '\t' => s.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                s.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => s.push(c),
        }
    }
    s.push('"');
}

pub fn write_value(s: &mut String, v: &Value) {
    match v {
        Value::Null => s.push_str("null"),
        Value::Bool(b) => s.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => s.push_str(&js_number(value_f64(n))),
        Value::String(t) => write_str(s, t),
        Value::Array(a) => {
            s.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                write_value(s, x);
            }
            s.push(']');
        }
        Value::Object(o) => {
            s.push('{');
            for (i, (k, x)) in js_key_order(o.iter().map(|(k, v)| (k.as_str(), v)))
                .into_iter()
                .enumerate()
            {
                if i > 0 {
                    s.push(',');
                }
                write_str(s, k);
                s.push(':');
                write_value(s, x);
            }
            s.push('}');
        }
    }
}

pub fn write_out(s: &mut String, v: &Out) {
    match v {
        Out::Undef | Out::Null => s.push_str("null"),
        Out::Bool(b) => s.push_str(if *b { "true" } else { "false" }),
        Out::Num(n) => s.push_str(&js_number(*n)),
        Out::Str(t) => write_str(s, t),
        Out::Raw(x) => write_value(s, x),
        Out::Arr(a) => {
            s.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                write_out(s, x);
            }
            s.push(']');
        }
        Out::Obj(o) => {
            s.push('{');
            let mut first = true;
            for (k, x) in js_key_order(o.iter().map(|(k, v)| (k.as_str(), v))) {
                if matches!(x, Out::Undef) {
                    continue;
                }
                if !first {
                    s.push(',');
                }
                first = false;
                write_str(s, k);
                s.push(':');
                write_out(s, x);
            }
            s.push('}');
        }
    }
}

/// JSON.parse of a response body: a leading byte-order mark is dropped and an
/// invalid UTF-8 sequence decodes to U+FFFD, as Response.json() does.
pub fn parse_body(bytes: &[u8]) -> Option<Value> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let text = String::from_utf8_lossy(bytes);
    serde_json::from_str(&text).ok()
}

/// JavaScript truthiness of a value that may be missing (undefined).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => {
            let f = value_f64(n);
            f != 0.0 && !f.is_nan()
        }
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `a === b` for two parsed values. Two objects or arrays are never the same
/// reference here, so they are never equal.
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => value_f64(x) == value_f64(y),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `a === "literal"`.
pub fn is_str(v: Option<&Value>, s: &str) -> bool {
    matches!(v, Some(Value::String(x)) if x == s)
}

/// `String(value)`.
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(v) => js_string_value(v),
    }
}

fn js_string_value(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let f = value_f64(n);
            if f.is_nan() {
                "NaN".to_string()
            } else if f.is_infinite() {
                if f > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
            } else {
                js_number(f)
            }
        }
        Value::String(s) => s.clone(),
        // Array.prototype.join: null and undefined elements print as empty.
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string_value(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// A property read, `row.key`, that throws a TypeError on null as JavaScript
/// does. Every other non-object has no such property.
pub fn get<'a>(row: &'a Value, key: &str) -> Result<Option<&'a Value>, TypeError> {
    match row {
        Value::Null => Err(TypeError),
        Value::Object(o) => Ok(o.get(key)),
        _ => Ok(None),
    }
}

/// `row?.key`: null-safe.
pub fn get_opt<'a>(row: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match row {
        Some(Value::Object(o)) => o.get(key),
        _ => None,
    }
}

/// Reading a property of null: the error the Node service logged as
/// handler_failed with error "TypeError".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypeError;
