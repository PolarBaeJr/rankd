// The parts of the WHATWG URL parser this service relied on through Node's URL:
//
// - `new URL(req.url, 'http://localhost')` turns a request target into the
//   pathname the router matches (dot segments resolved, backslashes read as
//   slashes, some characters percent-encoded) and the query string. An
//   absolute-form or scheme-relative target names its own host, and a target
//   whose host does not parse threw a TypeError, which the handler answered
//   with 503.
// - `new URL(SUPABASE_URL)` at startup, which only asks whether it parses and
//   what its scheme is.
//
// Hosts are checked, not normalised: the pathname is all that is used. A host
// with a non-ASCII character would need IDNA processing, which is not ported;
// it is refused here (a 503 where Node might have answered). Request targets
// are latin-1 widened before parsing, as Node's HTTP parser hands them over.

const SPECIAL: [&str; 6] = ["http", "https", "ws", "wss", "ftp", "file"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub scheme: String,
    /// The serialised pathname, as URL.pathname reads it.
    pub pathname: String,
    /// The query without its `?`, if there was one.
    pub query: Option<String>,
    /// Whether a username or password was present.
    pub credentials: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalid;

fn is_special(scheme: &str) -> bool {
    SPECIAL.contains(&scheme)
}

/// C0 controls, space, `"`, `#`, `<`, `>`, `?`, `^`, backtick, `{`, `}` and
/// everything past `~`.
fn in_path_set(c: char) -> bool {
    let u = c as u32;
    !(0x20..=0x7e).contains(&u)
        || matches!(c, ' ' | '"' | '#' | '<' | '>' | '?' | '^' | '`' | '{' | '}')
}

fn percent_encode_char(out: &mut String, c: char) {
    let mut buf = [0u8; 4];
    for b in c.encode_utf8(&mut buf).bytes() {
        out.push_str(&format!("%{b:02X}"));
    }
}

fn is_single_dot(seg: &str) -> bool {
    seg == "." || seg.eq_ignore_ascii_case("%2e")
}

fn is_double_dot(seg: &str) -> bool {
    matches!(
        seg.to_ascii_lowercase().as_str(),
        ".." | ".%2e" | "%2e." | "%2e%2e"
    )
}

/// Appends path segments to `path` (a list of encoded segments), resolving dot
/// segments the way the path state does.
fn push_path(path: &mut Vec<String>, input: &str, special: bool) {
    if input.is_empty() {
        return;
    }
    let segs: Vec<&str> = if special {
        input.split(['/', '\\']).collect()
    } else {
        input.split('/').collect()
    };
    let last = segs.len() - 1;
    for (i, seg) in segs.into_iter().enumerate() {
        let at_end = i == last;
        if is_double_dot(seg) {
            path.pop();
            if at_end {
                path.push(String::new());
            }
        } else if is_single_dot(seg) {
            if at_end {
                path.push(String::new());
            }
        } else {
            let mut enc = String::new();
            for c in seg.chars() {
                if in_path_set(c) {
                    percent_encode_char(&mut enc, c);
                } else {
                    enc.push(c);
                }
            }
            path.push(enc);
        }
    }
}

fn forbidden_host_char(c: char) -> bool {
    matches!(
        c,
        '\0' | '\t'
            | '\n'
            | '\r'
            | ' '
            | '#'
            | '/'
            | ':'
            | '<'
            | '>'
            | '?'
            | '@'
            | '['
            | '\\'
            | ']'
            | '^'
            | '|'
    )
}

fn forbidden_domain_char(c: char) -> bool {
    forbidden_host_char(c) || (c as u32) < 0x20 || c == '%' || c == '\u{7f}'
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && b[i + 1].is_ascii_hexdigit()
            && b[i + 2].is_ascii_hexdigit()
        {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("00");
            out.push(u8::from_str_radix(hex, 16).unwrap_or(0));
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

/// An IPv4 number part, as the IPv4 parser reads it: decimal, 0x hex or
/// leading-zero octal.
fn ipv4_number(part: &str) -> Option<u64> {
    if part.is_empty() {
        return None;
    }
    let (digits, radix) = if part.len() >= 2 && (part.starts_with("0x") || part.starts_with("0X")) {
        (&part[2..], 16)
    } else if part.len() >= 2 && part.starts_with('0') {
        (&part[1..], 8)
    } else {
        (part, 10)
    };
    if digits.is_empty() {
        return Some(0);
    }
    if !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    // Saturate: anything this large fails the range check below anyway.
    Some(u64::from_str_radix(digits, radix).unwrap_or(u64::MAX))
}

fn ends_in_number(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.last() == Some(&"") {
        if parts.len() == 1 {
            return false;
        }
        parts.pop();
    }
    let last = parts.last().copied().unwrap_or("");
    if !last.is_empty() && last.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    ipv4_number(last).is_some()
}

fn valid_ipv4(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.last() == Some(&"") && parts.len() > 1 {
        parts.pop();
    }
    if parts.len() > 4 {
        return false;
    }
    let mut nums = Vec::new();
    for p in &parts {
        match ipv4_number(p) {
            Some(n) => nums.push(n),
            None => return false,
        }
    }
    let (last, init) = nums.split_last().expect("at least one part");
    if init.iter().any(|n| *n > 255) {
        return false;
    }
    *last < 256u64.pow((5 - nums.len()) as u32)
}

fn valid_host(input: &str, special: bool) -> bool {
    if let Some(inner) = input.strip_prefix('[') {
        return match inner.strip_suffix(']') {
            Some(v6) => v6.parse::<std::net::Ipv6Addr>().is_ok(),
            None => false,
        };
    }
    if !special {
        // An opaque host: only the forbidden host code points are refused.
        return !input.chars().any(forbidden_host_char);
    }
    let decoded = percent_decode(input);
    let Ok(domain) = String::from_utf8(decoded) else {
        return false;
    };
    if domain.is_empty() || !domain.is_ascii() {
        // Non-ASCII needs IDNA, which is not ported.
        return false;
    }
    if domain.chars().any(forbidden_domain_char) {
        return false;
    }
    let lower = domain.to_ascii_lowercase();
    if ends_in_number(&lower) {
        return valid_ipv4(&lower);
    }
    true
}

/// The authority of a special or scheme-relative URL: userinfo, host, port.
fn check_authority(auth: &str, scheme: &str) -> Result<bool, Invalid> {
    let special = is_special(scheme);
    let (credentials, hostport) = match auth.rfind('@') {
        Some(at) => (true, &auth[at + 1..]),
        None => (false, auth),
    };
    // The port starts at the last colon outside brackets.
    let mut colon = None;
    let mut in_brackets = false;
    for (i, c) in hostport.char_indices() {
        match c {
            '[' => in_brackets = true,
            ']' => in_brackets = false,
            ':' if !in_brackets => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let (host, port) = match colon {
        Some(i) => (&hostport[..i], Some(&hostport[i + 1..])),
        None => (hostport, None),
    };
    if let Some(p) = port {
        if !p.chars().all(|c| c.is_ascii_digit()) {
            return Err(Invalid);
        }
        if !p.is_empty() && p.parse::<u64>().map_or(true, |n| n > 65535) {
            return Err(Invalid);
        }
    }
    if host.is_empty() {
        if special && scheme != "file" {
            return Err(Invalid);
        }
        if credentials || port.is_some_and(|p| !p.is_empty()) {
            return Err(Invalid);
        }
        return Ok(credentials);
    }
    if !valid_host(host, special) {
        return Err(Invalid);
    }
    Ok(credentials)
}

fn split_scheme(input: &str) -> Option<(String, &str)> {
    let first = input.chars().next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    for (i, c) in input.char_indices() {
        if c == ':' {
            return Some((input[..i].to_ascii_lowercase(), &input[i + 1..]));
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
            return None;
        }
    }
    None
}

/// Splits `rest` at the first `?` or `#`: (path, query).
fn split_path_query(rest: &str) -> (&str, Option<&str>) {
    let rest = match rest.find('#') {
        Some(i) => &rest[..i],
        None => rest,
    };
    match rest.find('?') {
        Some(i) => (&rest[..i], Some(&rest[i + 1..])),
        None => (rest, None),
    }
}

fn authority_end(s: &str, special: bool) -> usize {
    s.find(|c: char| c == '/' || c == '?' || c == '#' || (special && c == '\\'))
        .unwrap_or(s.len())
}

fn serialise(path: &[String]) -> String {
    let mut s = String::new();
    for seg in path {
        s.push('/');
        s.push_str(seg);
    }
    if s.is_empty() { "/".to_string() } else { s }
}

fn preprocess(input: &str) -> String {
    let trimmed = input.trim_matches(|c: char| (c as u32) <= 0x20);
    trimmed
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect()
}

fn encode_query(q: &str) -> String {
    // The query percent-encode set. Decoding by URLSearchParams undoes it, so
    // only the bytes matter, not the exact set.
    let mut out = String::new();
    for c in q.chars() {
        let u = c as u32;
        if !(0x21..=0x7e).contains(&u) || matches!(c, '"' | '#' | '<' | '>') {
            percent_encode_char(&mut out, c);
        } else {
            out.push(c);
        }
    }
    out
}

/// A URL with a scheme, special or not.
fn parse_with_scheme(scheme: String, rest: &str) -> Result<Parsed, Invalid> {
    let special = is_special(&scheme);
    let mut path = Vec::new();
    let mut credentials = false;
    let after_authority: &str;
    if special {
        // http:, http:/, http://, http:\\ and http:/// all reach the authority,
        // except the same scheme as the base with no slash, which is relative.
        if scheme == "file" {
            // file://host/path, or a path with no host at all.
            let two = rest.len() >= 2 && rest[..2].chars().all(|c| c == '/' || c == '\\');
            if two {
                let after = &rest[2..];
                let end = authority_end(after, true);
                let host = &after[..end];
                if !host.is_empty() && !valid_host(host, true) {
                    return Err(Invalid);
                }
                after_authority = &after[end..];
            } else {
                after_authority = rest;
            }
        } else if scheme == "http"
            && !(rest.starts_with(['/', '\\']) && rest[1..].starts_with(['/', '\\']))
        {
            // The base's own scheme without two slashes is relative to the base:
            // "http:health" and "http:/health" are both /health.
            after_authority = rest;
        } else {
            let stripped = rest.trim_start_matches(['/', '\\']);
            let end = authority_end(stripped, true);
            credentials = check_authority(&stripped[..end], &scheme)?;
            after_authority = &stripped[end..];
        }
        let (p, q) = split_path_query(after_authority);
        push_path(&mut path, p.strip_prefix(['/', '\\']).unwrap_or(p), true);
        return Ok(Parsed {
            scheme,
            pathname: serialise(&path),
            query: q.map(encode_query),
            credentials,
        });
    }
    // Not special.
    let (p, q) = split_path_query(rest);
    if let Some(after) = p.strip_prefix("//") {
        let end = authority_end(after, false);
        credentials = check_authority(&after[..end], &scheme)?;
        let tail = &after[end..];
        push_path(&mut path, tail.strip_prefix('/').unwrap_or(tail), false);
        let pathname = if tail.is_empty() {
            String::new()
        } else {
            serialise(&path)
        };
        return Ok(Parsed {
            scheme,
            pathname,
            query: q.map(encode_query),
            credentials,
        });
    }
    if let Some(abs) = p.strip_prefix('/') {
        push_path(&mut path, abs, false);
        return Ok(Parsed {
            scheme,
            pathname: serialise(&path),
            query: q.map(encode_query),
            credentials,
        });
    }
    // An opaque path: C0 controls and non-ASCII encoded, nothing resolved.
    let mut opaque = String::new();
    for c in p.chars() {
        let u = c as u32;
        if !(0x20..=0x7e).contains(&u) {
            percent_encode_char(&mut opaque, c);
        } else {
            opaque.push(c);
        }
    }
    Ok(Parsed {
        scheme,
        pathname: opaque,
        query: q.map(encode_query),
        credentials,
    })
}

/// `new URL(input, 'http://localhost')`.
pub fn parse_target(input: &str) -> Result<Parsed, Invalid> {
    let input = preprocess(input);
    if let Some((scheme, rest)) = split_scheme(&input) {
        return parse_with_scheme(scheme, rest);
    }
    let mut path = Vec::new();
    let (p, q) = split_path_query(&input);
    if p.starts_with("//") || p.starts_with("\\\\") || p.starts_with("/\\") || p.starts_with("\\/")
    {
        // Scheme-relative: a host of its own.
        let stripped = input.trim_start_matches(['/', '\\']);
        let end = authority_end(stripped, true);
        let credentials = check_authority(&stripped[..end], "http")?;
        let (p, q) = split_path_query(&stripped[end..]);
        push_path(&mut path, p.strip_prefix(['/', '\\']).unwrap_or(p), true);
        return Ok(Parsed {
            scheme: "http".into(),
            pathname: serialise(&path),
            query: q.map(encode_query),
            credentials,
        });
    }
    if let Some(abs) = p.strip_prefix(['/', '\\']) {
        push_path(&mut path, abs, true);
    } else {
        // Relative to the base path "/".
        push_path(&mut path, p, true);
    }
    Ok(Parsed {
        scheme: "http".into(),
        pathname: serialise(&path),
        query: q.map(encode_query),
        credentials: false,
    })
}

/// `new URL(input)` with no base: Some(parsed) where it parses.
pub fn parse_absolute(input: &str) -> Result<Parsed, Invalid> {
    let input = preprocess(input);
    let (scheme, rest) = split_scheme(&input).ok_or(Invalid)?;
    let special = is_special(&scheme);
    if special && scheme != "file" {
        // No base: every special non-file URL needs an authority, whatever
        // slashes precede it.
        let stripped = rest.trim_start_matches(['/', '\\']);
        let end = authority_end(stripped, true);
        let credentials = check_authority(&stripped[..end], &scheme)?;
        let (p, q) = split_path_query(&stripped[end..]);
        let mut path = Vec::new();
        push_path(&mut path, p.strip_prefix(['/', '\\']).unwrap_or(p), true);
        return Ok(Parsed {
            scheme,
            pathname: serialise(&path),
            query: q.map(encode_query),
            credentials,
        });
    }
    parse_with_scheme(scheme, rest)
}

/// URLSearchParams over a query string: (name, value) pairs in order.
pub fn search_params(query: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for part in query.split('&') {
        if part.is_empty() {
            continue;
        }
        let (name, value) = match part.find('=') {
            Some(i) => (&part[..i], &part[i + 1..]),
            None => (part, ""),
        };
        out.push((form_decode(name), form_decode(value)));
    }
    out
}

fn form_decode(s: &str) -> String {
    let plus = s.replace('+', " ");
    String::from_utf8_lossy(&percent_decode(&plus)).into_owned()
}

/// Node hands the request target over as a latin-1 string: each byte one code
/// point.
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|b| *b as char).collect()
}
