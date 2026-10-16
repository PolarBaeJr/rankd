// Startup configuration. Pure: takes an environment lookup, returns a config or
// the message to exit with.
//
// The service reaches the database through PostgREST as the `data_api_reader`
// role, carried by a JWT the owner minted once. It is deliberately never given
// the JWT secret (so it cannot mint a token for any other role) nor the
// service_role key (which bypasses every grant 00241 sets up). The role check
// below is the defence against somebody pasting the service_role key, or the
// anon key, into DATA_API_DB_JWT: it decodes the payload WITHOUT verifying it,
// because the only question is "what does this token claim to be", and
// PostgREST does the verifying.
//
// No error message here ever contains a credential's value.

use crate::{base64, url};

pub const READER_ROLE: &str = "data_api_reader";
pub const DEFAULT_PORT: u16 = 8080;

/// How many PostgREST calls may be in flight at once (upstream.rs).
pub const UPSTREAM_CONCURRENCY_ENV: &str = "DATA_API_UPSTREAM_CONCURRENCY";
pub const DEFAULT_UPSTREAM_CONCURRENCY: usize = 16;
pub const MAX_UPSTREAM_CONCURRENCY: usize = 1024;

#[derive(Clone)]
pub struct Config {
    /// SUPABASE_URL, trimmed, trailing slashes removed.
    pub supabase_url: String,
    pub anon_key: String,
    pub db_jwt: String,
    pub port: u16,
    pub upstream_concurrency: usize,
}

impl std::fmt::Debug for Config {
    // Never prints a credential.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("port", &self.port)
            .field("upstream_concurrency", &self.upstream_concurrency)
            .finish_non_exhaustive()
    }
}

/// JavaScript's WhiteSpace and LineTerminator, which String.prototype.trim and
/// Number() both strip.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `Number(s)` for a string: NaN where JavaScript gives NaN.
pub fn js_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * radix as f64 + c.to_digit(radix).unwrap_or(0) as f64
            });
        }
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // StrUnsignedDecimalLiteral: digits, optional fraction, optional exponent,
    // with at least one digit in the mantissa.
    let b = body.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut mantissa_digits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        mantissa_digits += i - f;
    }
    if mantissa_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    // Rust's parser takes this grammar except a bare trailing or leading dot,
    // which it also accepts ("5." and ".5").
    body.parse::<f64>().map_or(f64::NAN, |n| sign * n)
}

/// The role a JWT claims, read without verifying it.
pub fn jwt_role(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 || parts[1].is_empty() {
        return None;
    }
    // JSON.parse, which unlike Response.json() keeps a byte-order mark and so
    // refuses it.
    let text = String::from_utf8_lossy(&base64::decode_lenient(parts[1])).into_owned();
    let payload: serde_json::Value = serde_json::from_str(&text).ok()?;
    match payload.as_object()?.get("role")? {
        serde_json::Value::String(role) => Some(role.clone()),
        _ => None,
    }
}

pub fn load(env: &dyn Fn(&str) -> Option<String>) -> Result<Config, String> {
    let present = |name: &str| env(name).filter(|v| !js_trim(v).is_empty());
    let missing: Vec<&str> = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "DATA_API_DB_JWT"]
        .into_iter()
        .filter(|name| present(name).is_none())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "missing required environment: {}",
            missing.join(", ")
        ));
    }

    let raw_url = js_trim(&env("SUPABASE_URL").unwrap_or_default()).to_string();
    let parsed =
        url::parse_absolute(&raw_url).map_err(|_| "SUPABASE_URL is not a URL".to_string())?;
    if parsed.scheme != "http" && parsed.scheme != "https" {
        return Err("SUPABASE_URL must be http or https".to_string());
    }

    let db_jwt = js_trim(&env("DATA_API_DB_JWT").unwrap_or_default()).to_string();
    match jwt_role(&db_jwt) {
        Some(role) if role == READER_ROLE => {}
        // The role name is safe to print (it is not the credential) and it is
        // the fastest way for the owner to see which key they pasted.
        Some(role) => {
            let mut quoted = String::new();
            quoted.push('"');
            quoted.push_str(&role);
            quoted.push('"');
            return Err(format!(
                "DATA_API_DB_JWT must carry role \"{READER_ROLE}\", got {quoted}"
            ));
        }
        None => {
            return Err(format!(
                "DATA_API_DB_JWT must carry role \"{READER_ROLE}\", got no readable role"
            ));
        }
    }

    let port = port_from(env("PORT").as_deref())?;
    let upstream_concurrency = upstream_concurrency_from(env(UPSTREAM_CONCURRENCY_ENV).as_deref())?;

    Ok(Config {
        supabase_url: raw_url.trim_end_matches('/').to_string(),
        anon_key: js_trim(&env("SUPABASE_ANON_KEY").unwrap_or_default()).to_string(),
        db_jwt,
        port,
        upstream_concurrency,
    })
}

/// `raw?.trim() ? Number(raw) : 16`, then an integer from 1 to 1024.
pub fn upstream_concurrency_from(raw: Option<&str>) -> Result<usize, String> {
    let n = match raw {
        Some(v) if !js_trim(v).is_empty() => js_to_number(v),
        _ => DEFAULT_UPSTREAM_CONCURRENCY as f64,
    };
    if n.fract() == 0.0 && (1.0..=MAX_UPSTREAM_CONCURRENCY as f64).contains(&n) {
        Ok(n as usize)
    } else {
        Err(format!(
            "{UPSTREAM_CONCURRENCY_ENV} must be an integer between 1 and {MAX_UPSTREAM_CONCURRENCY}"
        ))
    }
}

/// `env.PORT?.trim() ? Number(env.PORT) : 8080`, then an integer in range.
pub fn port_from(raw: Option<&str>) -> Result<u16, String> {
    let n = match raw {
        Some(v) if !js_trim(v).is_empty() => js_to_number(v),
        _ => DEFAULT_PORT as f64,
    };
    if n.fract() == 0.0 && (1.0..=65535.0).contains(&n) {
        Ok(n as u16)
    } else {
        Err("PORT must be an integer between 1 and 65535".to_string())
    }
}
