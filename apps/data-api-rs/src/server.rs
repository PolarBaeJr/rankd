// The request handler. Everything it needs is passed in, so tests drive it with
// a fake upstream and a hand-moved clock.
//
// ORDER OF CHECKS: route (404), the public docs and changelog pages (served
// here, GET and HEAD only, 405 otherwise), method (405), key (401, or 429 from
// the per-address failed-auth bucket), per-key rate (429), scope (403), query
// parameters (400), path ref and id format (404), then for a write the body
// (415, 413, 400), database. A caller learns nothing about keys from a route
// that does not exist, and a malformed ref never costs a database call: the
// by-ref functions rehash the whole eligible roster on every call.
//
// A port of apps/data-api/src/server.ts, which is the source of truth: where
// the two differ, this one is wrong.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::BodyExt;
use hyper::body::Incoming;
use serde_json::Value;

use crate::auth::{BearerResult, KeyVerifier, VerifiedKey};
use crate::changelog_page::CHANGELOG_HTML;
use crate::config::js_trim;
use crate::docs_page::{DOCS_CSP, DOCS_HTML};
use crate::json::{Out, TypeError, get, get_opt, is_str, js_string, strict_eq, truthy};
use crate::params::{self, BadParam, DEFAULT_LIMIT, ParamValue, Params, is_ref, is_uuid};
use crate::predictions::{BadBody, MAX_BODY_BYTES, parse_matchups, parse_predictions};
use crate::rate_limit::{Clock, TokenBuckets};
use crate::registrations::parse_registration;
use crate::rpc_cache::{REGISTRATION_READS, RpcCache};
use crate::shape::{self, Shaped};
use crate::upstream::{Rows, Upstream, UpstreamError};
use crate::{js_parse, time, url};

/// Node's server.requestTimeout: a body still arriving after this is dropped.
const BODY_TIMEOUT: Duration = Duration::from_secs(300);

pub type Log = Arc<dyn Fn(String) + Send + Sync>;

pub struct Deps {
    pub upstream: Arc<Upstream>,
    pub version: String,
    pub now: Clock,
    pub log: Log,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteName {
    Health,
    Docs,
    Changelog,
    Players,
    Player,
    PlayerMatches,
    PlayerVs,
    PlayerSeasons,
    PlayerRatings,
    Matches,
    Match,
    Seasons,
    Season,
    SeasonStandings,
    Tournaments,
    Tournament,
    TournamentEvent,
    Sessions,
    Events,
    Predictions,
    Registrations,
}

pub struct RouteDef {
    pub name: RouteName,
    pub template: &'static str,
    /// None for the three routes that need no key.
    pub scope: Option<&'static str>,
    pub params: &'static [&'static str],
    /// False only for the routes that predate query parameters and ignore them.
    pub strict: bool,
    /// None means GET only.
    pub methods: Option<&'static [&'static str]>,
}

const GET_ONLY: &[&str] = &["GET"];

const MATCH_PARAMS: &[&str] = &[
    "season",
    "since",
    "until",
    "player",
    "opponent",
    "type",
    "source",
    "rated",
    "status",
    "updated_since",
    "limit",
    "offset",
];

// The player is the path, so `opponent` stands alone here.
const PLAYER_MATCH_PARAMS: &[&str] = &[
    "season",
    "since",
    "until",
    "opponent",
    "type",
    "source",
    "rated",
    "status",
    "updated_since",
    "limit",
    "offset",
];

/// Every route the service answers. Public for the drift test, which checks
/// each template, scope and parameter appears in the documentation.
pub const ROUTES: &[RouteDef] = &[
    RouteDef {
        name: RouteName::Health,
        template: "/health",
        scope: None,
        params: &[],
        strict: false,
        methods: None,
    },
    RouteDef {
        name: RouteName::Docs,
        template: "/documentations",
        scope: None,
        params: &[],
        strict: false,
        methods: None,
    },
    RouteDef {
        name: RouteName::Changelog,
        template: "/changelog",
        scope: None,
        params: &[],
        strict: false,
        methods: None,
    },
    RouteDef {
        name: RouteName::Players,
        template: "/v1/players",
        scope: Some("players:read"),
        params: &[],
        strict: false,
        methods: None,
    },
    RouteDef {
        name: RouteName::Player,
        template: "/v1/players/:ref",
        scope: Some("players:read"),
        params: &[],
        strict: false,
        methods: None,
    },
    RouteDef {
        name: RouteName::PlayerMatches,
        template: "/v1/players/:ref/matches",
        scope: Some("matches:read"),
        params: PLAYER_MATCH_PARAMS,
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::PlayerVs,
        template: "/v1/players/:ref/vs/:other_ref",
        scope: Some("matches:read"),
        params: &["type", "season"],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::PlayerSeasons,
        template: "/v1/players/:ref/seasons",
        scope: Some("matches:read"),
        params: &[],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::PlayerRatings,
        template: "/v1/players/:ref/ratings",
        scope: Some("ratings:history:read"),
        params: &["type", "season", "since", "until", "limit", "offset"],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::Matches,
        template: "/v1/matches",
        scope: Some("matches:read"),
        params: MATCH_PARAMS,
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::Match,
        template: "/v1/matches/:match_ref",
        scope: Some("matches:read"),
        params: &[],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::Seasons,
        template: "/v1/seasons",
        scope: Some("seasons:read"),
        params: &[],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::Season,
        template: "/v1/seasons/:id",
        scope: Some("seasons:read"),
        params: &[],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::SeasonStandings,
        template: "/v1/seasons/:id/standings",
        scope: Some("seasons:read"),
        params: &[],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::Tournaments,
        template: "/v1/tournaments",
        scope: Some("tournaments:read"),
        params: &["season"],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::Tournament,
        template: "/v1/tournaments/:id",
        scope: Some("tournaments:read"),
        params: &[],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::TournamentEvent,
        template: "/v1/tournaments/:id/events/:event_id",
        scope: Some("tournaments:read"),
        params: &[],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::Sessions,
        template: "/v1/sessions",
        scope: Some("schedule:read"),
        params: &["from", "to"],
        strict: true,
        methods: None,
    },
    RouteDef {
        name: RouteName::Events,
        template: "/v1/events",
        scope: Some("schedule:read"),
        params: &["from", "to"],
        strict: true,
        methods: None,
    },
    // The writes. No read route shares either path, so a GET here is a 405.
    RouteDef {
        name: RouteName::Predictions,
        template: "/v1/predictions",
        scope: Some("predictions:write"),
        params: &[],
        strict: true,
        methods: Some(&["POST", "DELETE"]),
    },
    RouteDef {
        name: RouteName::Registrations,
        template: "/v1/registrations",
        scope: Some("registrations:write"),
        params: &[],
        strict: true,
        methods: Some(&["POST"]),
    },
];

/// Path variables that name a player or a match: 404 unless a 64-hex digest.
const REF_VARS: [&str; 3] = ["ref", "other_ref", "match_ref"];
/// Path variables that name a club object by its uuid: 404 unless a uuid.
const ID_VARS: [&str; 2] = ["id", "event_id"];

/// How long a v2 reader PostgREST does not know is skipped before it is asked again.
const V2_RETRY_MS: i64 = 60_000;

const KEY_RATE: (u32, u32) = (60, 60_000);
const FAILED_AUTH_RATE: (u32, u32) = (30, 60_000);
const VS_RECENT: usize = 10;

const MATCH_ARGS: [(&str, &str); 10] = [
    ("season", "p_season"),
    ("since", "p_since"),
    ("until", "p_until"),
    ("player", "p_player_ref"),
    ("opponent", "p_opponent_ref"),
    ("type", "p_type"),
    ("source", "p_source"),
    ("rated", "p_rated"),
    ("status", "p_status"),
    ("updated_since", "p_updated_since"),
];

struct Matched {
    def: &'static RouteDef,
    /// Path segments named by `:name` in the template, in template order.
    vars: Vec<(&'static str, String)>,
}

fn match_route(pathname: &str) -> Option<Matched> {
    let path = match pathname {
        "/documentations/" => "/documentations",
        "/changelog/" => "/changelog",
        other => other,
    };
    let segments: Vec<&str> = path.split('/').collect();
    'routes: for def in ROUTES {
        let parts: Vec<&'static str> = def.template.split('/').collect();
        if parts.len() != segments.len() {
            continue;
        }
        let mut vars = Vec::new();
        for (part, seg) in parts.iter().zip(&segments) {
            if let Some(name) = part.strip_prefix(':') {
                if seg.is_empty() {
                    continue 'routes;
                }
                vars.push((name, seg.to_string()));
            } else if part != seg {
                continue 'routes;
            }
        }
        return Some(Matched { def, vars });
    }
    None
}

/// What a request failed with, logged by name.
#[derive(Debug)]
pub enum Failure {
    Upstream(UpstreamError),
    /// A JavaScript error by its name: TypeError for a null row or a request
    /// target whose host does not parse.
    Error(&'static str),
}

impl From<UpstreamError> for Failure {
    fn from(e: UpstreamError) -> Self {
        Failure::Upstream(e)
    }
}

impl From<TypeError> for Failure {
    fn from(_: TypeError) -> Self {
        Failure::Error("TypeError")
    }
}

/// A finished response: status, headers in order, body. `head` marks a HEAD
/// request, whose body is dropped on the wire with its Content-Length kept.
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

/// What the HTTP layer hands the handler.
pub struct RequestInfo {
    pub method: String,
    /// The request target, latin-1 widened.
    pub target: String,
    pub authorization: Option<String>,
    /// Every X-Forwarded-For header, in order.
    pub forwarded_for: Vec<String>,
    /// The socket peer's address.
    pub peer: String,
    /// The first Content-Type header, latin-1 widened.
    pub content_type: Option<String>,
    /// The request body, taken by the write that reads it. A route that never
    /// reads it leaves it to the HTTP layer.
    pub body: Mutex<Option<Incoming>>,
}

/// What the request log line reports, kept outside the handler's task so a
/// panic still logs the route it happened on.
#[derive(Debug, Clone)]
pub struct Ctx {
    pub path: &'static str,
    pub key: Option<String>,
}

impl Default for Ctx {
    fn default() -> Self {
        Self {
            path: "(unmatched)",
            key: None,
        }
    }
}

fn send(status: u16, body: Out, extra: Vec<(&'static str, String)>) -> Reply {
    let payload = body.to_json().into_bytes();
    let mut headers = vec![
        (
            "content-type",
            "application/json; charset=utf-8".to_string(),
        ),
        ("cache-control", "no-store".to_string()),
        ("x-content-type-options", "nosniff".to_string()),
        ("content-length", payload.len().to_string()),
    ];
    headers.extend(extra);
    Reply {
        status,
        headers,
        body: payload,
    }
}

// Static and public, so it is cacheable, unlike every JSON response. The two
// pages share one stylesheet, so one CSP covers both.
fn send_html(body: &str) -> Reply {
    Reply {
        status: 200,
        headers: vec![
            ("content-type", "text/html; charset=utf-8".to_string()),
            ("cache-control", "public, max-age=300".to_string()),
            ("content-security-policy", DOCS_CSP.clone()),
            ("x-content-type-options", "nosniff".to_string()),
            ("referrer-policy", "no-referrer".to_string()),
            // Bytes, not characters: the changelog's footer is not ASCII.
            ("content-length", body.len().to_string()),
        ],
        body: body.as_bytes().to_vec(),
    }
}

fn bad_body(field: String) -> Reply {
    send(
        400,
        Out::obj([
            ("error", Out::str("bad_request")),
            ("field", Out::Str(field)),
        ]),
        vec![],
    )
}

/// `typeof v === 'number' ? v : 0`, as a number.
fn num_f64(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => crate::json::value_f64(n),
        _ => 0.0,
    }
}

/// The string a result's status compares as, for the counts.
fn status_text(v: &Out) -> Option<&str> {
    match v {
        Out::Str(s) => Some(s),
        Out::Raw(Value::String(s)) => Some(s),
        _ => None,
    }
}

fn count(statuses: &[Option<&str>], wanted: &str) -> Out {
    Out::Num(statuses.iter().filter(|s| **s == Some(wanted)).count() as f64)
}

fn ok(body: Out) -> Reply {
    send(200, body, vec![])
}

fn not_found() -> Reply {
    send(404, Out::obj([("error", Out::str("not_found"))]), vec![])
}

// ONE body and ONE header set for all five 401 cases, so nothing about the
// response says which of missing, malformed, unknown, expired or revoked it was.
fn unauthorized() -> Reply {
    send(
        401,
        Out::obj([("error", Out::str("unauthorized"))]),
        vec![("www-authenticate", "Bearer".to_string())],
    )
}

fn rate_limited(retry_after: i64) -> Reply {
    send(
        429,
        Out::obj([("error", Out::str("rate_limited"))]),
        vec![("retry-after", retry_after.to_string())],
    )
}

fn method_not_allowed(allow: &str) -> Reply {
    send(
        405,
        Out::obj([("error", Out::str("method_not_allowed"))]),
        vec![("allow", allow.to_string())],
    )
}

/// net.isIP: 4, 6 or 0. IPv6 may carry a zone id, as Node allows.
fn is_ip(s: &str) -> u8 {
    if s.parse::<Ipv4Addr>().is_ok() {
        return 4;
    }
    let addr = match s.split_once('%') {
        Some((a, zone)) => {
            if zone.is_empty()
                || !zone
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '_'))
            {
                return 0;
            }
            a
        }
        None => s,
    };
    if addr.parse::<Ipv6Addr>().is_ok() {
        6
    } else {
        0
    }
}

fn is_private(ip: &str) -> bool {
    let v4 = ip.strip_prefix("::ffff:").unwrap_or(ip);
    if is_ip(v4) == 4 {
        let octets: Vec<u32> = v4.split('.').map(|p| p.parse().unwrap_or(0)).collect();
        let (a, b) = (octets[0], octets[1]);
        return a == 10
            || a == 127
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 100 && (64..=127).contains(&b));
    }
    let lower = ip.to_lowercase();
    lower == "::1"
        || lower.starts_with("fc")
        || lower.starts_with("fd")
        || lower.starts_with("fe80")
}

/// The address the failed-auth bucket is keyed on. Behind the edge the socket
/// peer is the proxy, which would make the bucket one global bucket, so when
/// the peer is a private address X-Forwarded-For is walked from the right and
/// the first public address is taken: everything to its right was appended by
/// our own hops, everything to its left is client-supplied. A public peer
/// (nothing in front of us) is used as-is and its header is ignored.
pub fn client_ip(peer: &str, forwarded_for: &[String]) -> String {
    if !is_private(peer) {
        return peer.to_string();
    }
    let joined = forwarded_for.join(", ");
    let list: Vec<&str> = joined
        .split(',')
        .map(|s| s.trim_matches(crate::config::is_js_space))
        .filter(|s| !s.is_empty())
        .collect();
    for ip in list.iter().rev() {
        if is_ip(ip) != 0 && !is_private(ip) {
            return ip.to_string();
        }
    }
    peer.to_string()
}

fn page_of(params: &Params) -> (i64, i64) {
    (
        params.int("limit").unwrap_or(DEFAULT_LIMIT),
        params.int("offset").unwrap_or(0),
    )
}

fn param_out(v: &ParamValue) -> Out {
    match v {
        ParamValue::Str(s) => Out::str(s.clone()),
        ParamValue::Int(n) => Out::Num(*n as f64),
        ParamValue::Bool(b) => Out::Bool(*b),
    }
}

fn filter_args(params: &Params, map: &[(&str, &str)]) -> Vec<(String, Out)> {
    map.iter()
        .filter_map(|(name, arg)| params.get(name).map(|v| (arg.to_string(), param_out(v))))
        .collect()
}

/// The database is asked for limit+1 rows, so a page knows whether another
/// follows without a count query.
fn paged(rows: &[Value], limit: i64, offset: i64) -> (&[Value], Vec<(String, Out)>) {
    let more = rows.len() as i64 > limit;
    let kept = if more { &rows[..limit as usize] } else { rows };
    let envelope = vec![
        ("count".to_string(), Out::Num(kept.len() as f64)),
        ("limit".to_string(), Out::Num(limit as f64)),
        ("offset".to_string(), Out::Num(offset as f64)),
        (
            "next_offset".to_string(),
            if more {
                Out::Num((offset + limit) as f64)
            } else {
                Out::Null
            },
        ),
    ];
    (kept, envelope)
}

/// `array.find(pred)`, where reading a null element throws.
fn find(
    rows: &[Value],
    pred: impl Fn(&Value) -> Result<bool, TypeError>,
) -> Result<Option<&Value>, TypeError> {
    for r in rows {
        if pred(r)? {
            return Ok(Some(r));
        }
    }
    Ok(None)
}

fn args(fields: Vec<(String, Out)>) -> Out {
    Out::Obj(fields)
}

fn kv(k: &str, v: Out) -> (String, Out) {
    (k.to_string(), v)
}

pub struct Handler {
    deps: Deps,
    verifier: KeyVerifier,
    key_buckets: Mutex<TokenBuckets>,
    fail_buckets: Mutex<TokenBuckets>,
    cache: RpcCache,
    v2_missing_until: Mutex<HashMap<String, i64>>,
}

impl Handler {
    pub fn new(deps: Deps) -> Self {
        let now = Arc::clone(&deps.now);
        Self {
            verifier: KeyVerifier::new(Arc::clone(&deps.upstream), Arc::clone(&now)),
            key_buckets: Mutex::new(TokenBuckets::new(
                KEY_RATE.0,
                KEY_RATE.1,
                1000,
                Arc::clone(&now),
            )),
            fail_buckets: Mutex::new(TokenBuckets::new(
                FAILED_AUTH_RATE.0,
                FAILED_AUTH_RATE.1,
                10_000,
                Arc::clone(&now),
            )),
            cache: RpcCache::new(Arc::clone(&now)),
            v2_missing_until: Mutex::new(HashMap::new()),
            deps,
        }
    }

    pub fn now(&self) -> i64 {
        (self.deps.now)()
    }

    pub fn log(&self, line: Out) {
        (self.deps.log)(line.to_json());
    }

    // Reads only. The verifier talks to the upstream directly, uncached here.
    // Every read function takes the consumer first, and the cache keys on it.
    async fn rpc(&self, consumer: &str, fn_name: &str, a: Out) -> Result<Rows, UpstreamError> {
        self.cache
            .get(&self.deps.upstream, consumer, fn_name, a.to_json())
            .await
    }

    // A v2 reader is newer than the image that calls it only during a rollout:
    // images update before migrations run. Until PostgREST knows the v2 (404,
    // PGRST202) the v1 answers, without the newer fields. Any other failure of
    // the v2 is a failure, never a reason to read v1.
    async fn rpc_prefer(
        &self,
        consumer: &str,
        v2: &str,
        v1: &str,
        a: Out,
    ) -> Result<Rows, UpstreamError> {
        let until = self
            .v2_missing_until
            .lock()
            .expect("v2 lock")
            .get(v2)
            .copied();
        if until.is_none_or(|u| u <= self.now()) {
            match self.rpc(consumer, v2, a.clone()).await {
                Ok(rows) => return Ok(rows),
                Err(e) if e.fn_name == v2 && e.status == 404 => {
                    self.v2_missing_until
                        .lock()
                        .expect("v2 lock")
                        .insert(v2.to_string(), self.now() + V2_RETRY_MS);
                    self.log(Out::obj([
                        ("level", Out::str("warn")),
                        ("msg", Out::str("v2_unavailable")),
                        ("fn", Out::str(v2)),
                        ("upstream_status", Out::Num(404.0)),
                    ]));
                }
                Err(e) => return Err(e),
            }
        }
        self.rpc(consumer, v1, a).await
    }

    /// The verified key and its hash (the writes send the hash), or the reply.
    async fn authenticate(
        &self,
        req: &RequestInfo,
    ) -> Result<Result<(VerifiedKey, String), Reply>, Failure> {
        let ip = client_ip(&req.peer, &req.forwarded_for);
        let key = match self.verifier.inspect(req.authorization.as_deref()) {
            BearerResult::Malformed => None,
            BearerResult::Cached(hash, value) => value.map(|k| (k, hash)),
            BearerResult::Uncached(hash) => {
                // Only a lookup that would reach the database is gated by the
                // failed-auth bucket, so a valid cached key never pays for
                // somebody else's guessing.
                let gate = self.fail_buckets.lock().expect("bucket lock").check(&ip);
                if !gate.ok {
                    return Ok(Err(rate_limited(gate.retry_after)));
                }
                self.verifier.verify(&hash).await?.map(|k| (k, hash))
            }
        };
        match key {
            Some(k) => Ok(Ok(k)),
            None => {
                self.fail_buckets.lock().expect("bucket lock").take(&ip);
                Ok(Err(unauthorized()))
            }
        }
    }

    async fn published(&self, consumer: &str, r: &str) -> Result<bool, UpstreamError> {
        let rows = self
            .rpc(
                consumer,
                "data_api_player_published",
                Out::obj([
                    ("p_consumer_id", Out::str(consumer)),
                    ("p_player_ref", Out::str(r)),
                ]),
            )
            .await?;
        Ok(matches!(
            get_opt(rows.first(), "published"),
            Some(Value::Bool(true))
        ))
    }

    /// The season block of /v1/players. A failure here degrades to null, never 503.
    async fn active_season(&self, consumer: &str) -> Result<Out, Failure> {
        match self
            .rpc(
                consumer,
                "data_api_active_season",
                Out::obj([("p_consumer_id", Out::str(consumer))]),
            )
            .await
        {
            Ok(rows) => match rows.first() {
                Some(row) if truthy(Some(row)) => Ok(shape::shape_active_season(row)?),
                _ => Ok(Out::Null),
            },
            Err(e) => {
                self.log(Out::obj([
                    ("level", Out::str("warn")),
                    ("msg", Out::str("season_unavailable")),
                    ("fn", Out::str(e.fn_name.clone())),
                    ("upstream_status", Out::Num(e.status as f64)),
                ]));
                Ok(Out::Null)
            }
        }
    }

    /// The JSON body of a write, or the reply already decided. A body over the
    /// cap is read to its end and dropped, so the 413 reaches a client still
    /// sending. Never logged.
    async fn read_body(&self, req: &RequestInfo) -> Result<Result<Value, Reply>, Failure> {
        let declared = req.content_type.as_deref().unwrap_or("");
        let media = declared.split(';').next().unwrap_or("");
        // `.trim().toLowerCase()`: no latin-1 character lowercases into ASCII,
        // so an ASCII-insensitive compare is the same test.
        if !js_trim(media).eq_ignore_ascii_case("application/json") {
            return Ok(Err(send(
                415,
                Out::obj([("error", Out::str("unsupported_media_type"))]),
                vec![],
            )));
        }
        let body = req.body.lock().expect("body lock").take();
        let mut kept: Vec<u8> = Vec::new();
        let mut size = 0usize;
        if let Some(mut body) = body {
            let read = async {
                while let Some(frame) = body.frame().await {
                    // The client went away mid-body: Node's error is named Error.
                    let frame = frame.map_err(|_| Failure::Error("Error"))?;
                    if let Ok(chunk) = frame.into_data() {
                        size += chunk.len();
                        if size <= MAX_BODY_BYTES {
                            kept.extend_from_slice(&chunk);
                        }
                    }
                }
                Ok::<(), Failure>(())
            };
            tokio::time::timeout(BODY_TIMEOUT, read)
                .await
                .map_err(|_| Failure::Error("Error"))??;
        }
        if size > MAX_BODY_BYTES {
            return Ok(Err(send(
                413,
                Out::obj([("error", Out::str("payload_too_large"))]),
                vec![],
            )));
        }
        match js_parse::parse_body(&kept) {
            Some(value) => Ok(Ok(value)),
            None => Ok(Err(bad_body("body".to_string()))),
        }
    }

    // One row per item from the write or delete function. A `key` refusal means
    // the database no longer accepts a key the 30-second cache still holds:
    // revoked, expired or narrowed a moment ago.
    async fn write(&self, req: &RequestInfo, key_hash: &str) -> Result<Reply, Failure> {
        let body = match self.read_body(req).await? {
            Ok(body) => body,
            Err(reply) => return Ok(reply),
        };
        let deleting = req.method == "DELETE";
        let items = if deleting {
            parse_matchups(&body)
        } else {
            parse_predictions(&body, self.now())
        };
        let items = match items {
            Ok(items) => items,
            Err(BadBody(field)) => return Ok(bad_body(field)),
        };
        let (fn_name, arg) = if deleting {
            ("data_api_delete_predictions", "p_matchups")
        } else {
            ("data_api_write_predictions", "p_predictions")
        };
        // Straight to the upstream, never through the read cache: two identical
        // writes are two writes.
        let args = Out::Obj(vec![
            kv("p_key_hash", Out::str(key_hash)),
            kv(arg, Out::Arr(items.into_iter().map(Out::Raw).collect())),
        ]);
        let rows = self.deps.upstream.rpc(fn_name, args.to_json()).await?;
        for r in rows.iter() {
            if is_str(get(r, "status")?, "refused") && is_str(get(r, "reason")?, "key") {
                return Ok(unauthorized());
            }
        }
        let mut results = Vec::new();
        for r in rows.iter() {
            let index = shape::num(get(r, "item")?);
            let status = get(r, "status")?;
            results.push(if is_str(status, "refused") {
                Out::obj([
                    ("index", index),
                    ("status", Out::str("refused")),
                    ("reason", Out::from(get(r, "reason")?)),
                ])
            } else {
                Out::obj([("index", index), ("status", Out::from(status))])
            });
        }
        let statuses: Vec<Option<&str>> = results
            .iter()
            .map(|r| match r {
                Out::Obj(fields) => fields
                    .iter()
                    .find(|(k, _)| k == "status")
                    .and_then(|(_, v)| status_text(v)),
                _ => None,
            })
            .collect();
        let refused = count(&statuses, "refused");
        let any_refused = matches!(refused, Out::Num(n) if n > 0.0);
        let out = if deleting {
            Out::obj([
                ("deleted", count(&statuses, "deleted")),
                ("not_found", count(&statuses, "not_found")),
                ("refused", refused),
            ])
        } else {
            Out::obj([
                ("created", count(&statuses, "created")),
                ("replaced", count(&statuses, "replaced")),
                ("refused", refused),
            ])
        };
        let mut fields = vec![kv("results", Out::Arr(results))];
        fields.extend(out.into_fields());
        Ok(send(
            if any_refused { 422 } else { 200 },
            Out::Obj(fields),
            vec![],
        ))
    }

    // One Google Form response. The answer is per entry: entered, pending (the
    // club has something to do, or the person does), or refused with a reason
    // that is only ever about the event. A response that was already received
    // answers from the record with `replayed: true`. Refusals of single entries
    // are a 200: they are answers, and a retry would get the same one. The body
    // and its emails are never logged.
    async fn import_registration(
        &self,
        req: &RequestInfo,
        key_hash: &str,
        consumer: &str,
    ) -> Result<Reply, Failure> {
        let body = match self.read_body(req).await? {
            Ok(body) => body,
            Err(reply) => return Ok(reply),
        };
        let payload = match parse_registration(&body) {
            Ok(payload) => payload,
            Err(BadBody(field)) => return Ok(bad_body(field)),
        };
        let args = Out::Obj(vec![
            kv("p_key_hash", Out::str(key_hash)),
            kv("p_payload", payload),
        ]);
        let imported = self
            .deps
            .upstream
            .rpc("data_api_import_registration", args.to_json())
            .await;
        // The import can change entrant lists and signup counts. This consumer's
        // next read of either asks the database, whatever the import answered,
        // and also when it failed: a timeout can still have committed.
        self.cache.invalidate(consumer, REGISTRATION_READS);
        let rows = imported?;
        let whole = find(&rows, |r| {
            Ok(num_f64(get(r, "item")?) == 0.0 && is_str(get(r, "status")?, "refused"))
        })?;
        if let Some(whole) = whole {
            let reason = get_opt(Some(whole), "reason");
            if is_str(reason, "key") {
                return Ok(unauthorized());
            }
            if is_str(reason, "not_found") {
                return Ok(send(
                    404,
                    Out::obj([
                        ("error", Out::str("not_found")),
                        (
                            "detail",
                            Out::str("no active form binding for this key and form_id"),
                        ),
                    ]),
                    vec![],
                ));
            }
            return Ok(bad_body("body".to_string()));
        }
        let mut results = Vec::new();
        let mut statuses = Vec::new();
        for r in rows.iter() {
            let status = get(r, "status")?;
            let refused = is_str(status, "refused");
            statuses.push(status.and_then(Value::as_str));
            results.push(Out::obj([
                ("index", shape::num(get(r, "item")?)),
                ("event_id", Out::from(get(r, "event_id")?)),
                ("status", Out::from(status)),
                (
                    "reason",
                    if refused {
                        Out::from(get(r, "reason")?)
                    } else {
                        Out::Null
                    },
                ),
            ]));
        }
        let replayed = !rows.is_empty()
            && rows
                .iter()
                .all(|r| matches!(get_opt(Some(r), "replayed"), Some(Value::Bool(true))));
        Ok(send(
            200,
            Out::obj([
                ("replayed", Out::Bool(replayed)),
                ("results", Out::Arr(results)),
                ("entered", count(&statuses, "entered")),
                ("pending", count(&statuses, "pending")),
                ("refused", count(&statuses, "refused")),
            ]),
            vec![],
        ))
    }

    async fn serve(
        &self,
        name: RouteName,
        v: &HashMap<&'static str, String>,
        params: &Params,
        consumer: &str,
        generated_at: Out,
    ) -> Result<Reply, Failure> {
        let c = || vec![kv("p_consumer_id", Out::str(consumer))];
        let var = |k: &str| v.get(k).cloned().unwrap_or_default();
        let ga = || kv("generated_at", generated_at.clone());

        match name {
            RouteName::Players => {
                let rows = self.rpc(consumer, "data_api_players", args(c())).await?;
                let players = shape::map_rows(&rows, shape::shape_player)?;
                let season = self.active_season(consumer).await?;
                Ok(ok(Out::Obj(vec![
                    kv("season", season),
                    ga(),
                    kv("count", Out::Num(rows.len() as f64)),
                    kv("players", players),
                ])))
            }

            RouteName::Player => {
                let mut a = c();
                a.push(kv("p_player_ref", Out::str(var("ref"))));
                let rows = self
                    .rpc(consumer, "data_api_player_by_ref", args(a))
                    .await?;
                match rows.first() {
                    Some(row) if truthy(Some(row)) => Ok(ok(shape::shape_player(row)?)),
                    _ => Ok(not_found()),
                }
            }

            RouteName::Matches | RouteName::PlayerMatches => {
                let own = name == RouteName::PlayerMatches;
                if own && !self.published(consumer, &var("ref")).await? {
                    return Ok(not_found());
                }
                let (limit, offset) = page_of(params);
                let mut a = c();
                a.extend(filter_args(params, &MATCH_ARGS));
                if own {
                    // A spread after the filters: an existing key keeps its place.
                    set_field(&mut a, "p_player_ref", Out::str(var("ref")));
                }
                a.push(kv("p_limit", Out::Num((limit + 1) as f64)));
                a.push(kv("p_offset", Out::Num(offset as f64)));
                let rows = self.rpc(consumer, "data_api_matches", args(a)).await?;
                let (kept, envelope) = paged(&rows, limit, offset);
                let mut body = vec![ga()];
                if own {
                    body.push(kv("player_ref", Out::str(var("ref"))));
                }
                body.extend(envelope);
                body.push(kv("matches", shape::map_rows(kept, shape::shape_match)?));
                Ok(ok(Out::Obj(body)))
            }

            RouteName::Match => {
                let mut a = c();
                a.push(kv("p_match_ref", Out::str(var("match_ref"))));
                let rows = self.rpc(consumer, "data_api_match_by_ref", args(a)).await?;
                match rows.first() {
                    Some(row) if truthy(Some(row)) => Ok(ok(Out::Obj(vec![
                        ga(),
                        kv("match", shape::shape_match(row)?),
                    ]))),
                    _ => Ok(not_found()),
                }
            }

            RouteName::PlayerVs => {
                let (r, other) = (var("ref"), var("other_ref"));
                if r == other {
                    return Ok(not_found());
                }
                if !self.published(consumer, &r).await? || !self.published(consumer, &other).await?
                {
                    return Ok(not_found());
                }
                let filters = filter_args(params, &[("type", "p_type"), ("season", "p_season")]);
                let mut a = c();
                a.push(kv("p_player_ref", Out::str(r.clone())));
                a.push(kv("p_other_ref", Out::str(other.clone())));
                for (k, val) in filters.clone() {
                    set_field(&mut a, &k, val);
                }
                let totals = self.rpc(consumer, "data_api_head_to_head", args(a)).await?;
                let pick = |relation: &str, discipline: &str| {
                    find(&totals, |row| {
                        Ok(is_str(get(row, "relation")?, relation)
                            && is_str(get(row, "discipline")?, discipline))
                    })
                };
                let mut a = c();
                a.extend(filters);
                set_field(&mut a, "p_player_ref", Out::str(r.clone()));
                set_field(&mut a, "p_opponent_ref", Out::str(other.clone()));
                a.push(kv("p_limit", Out::Num(VS_RECENT as f64)));
                let recent = self.rpc(consumer, "data_api_matches", args(a)).await?;
                let opp_singles = shape::win_loss(pick("opponents", "singles")?);
                let opp_doubles = shape::win_loss(pick("opponents", "doubles")?);
                let partners = shape::win_loss(pick("partners", "doubles")?);
                let recent =
                    shape::map_rows(&recent[..recent.len().min(VS_RECENT)], shape::shape_match)?;
                Ok(ok(Out::Obj(vec![
                    ga(),
                    kv("player_ref", Out::str(r)),
                    kv("other_ref", Out::str(other)),
                    kv(
                        "as_opponents",
                        Out::obj([("singles", opp_singles), ("doubles", opp_doubles)]),
                    ),
                    kv("as_partners", Out::obj([("doubles", partners)])),
                    kv("recent", recent),
                ])))
            }

            RouteName::PlayerSeasons => {
                let r = var("ref");
                if !self.published(consumer, &r).await? {
                    return Ok(not_found());
                }
                let mut a = c();
                a.push(kv("p_player_ref", Out::str(r.clone())));
                let rows = self
                    .rpc(consumer, "data_api_player_seasons", args(a))
                    .await?;
                // One row per (season, discipline) played, plus one with a null
                // discipline for a season with only a final rating. Grouped here.
                let mut order: Vec<String> = Vec::new();
                let mut by_season: HashMap<String, Vec<&Value>> = HashMap::new();
                for row in rows.iter() {
                    let id = js_string(get(row, "season_id")?);
                    let group = by_season.entry(id.clone()).or_insert_with(|| {
                        order.push(id);
                        Vec::new()
                    });
                    group.push(row);
                }
                let mut seasons = Vec::new();
                for id in &order {
                    let group = &by_season[id];
                    let first = group[0];
                    let present = |row: &Value, k: &str| matches!(get_opt(Some(row), k), Some(x) if !x.is_null());
                    let fin = group.iter().find(|r| {
                        present(r, "final_singles_elo") || present(r, "final_doubles_elo")
                    });
                    let disc = |d: &str| {
                        group
                            .iter()
                            .find(|r| is_str(get_opt(Some(r), "discipline"), d))
                            .copied()
                    };
                    seasons.push(Out::obj([
                        (
                            "season",
                            Out::obj([
                                (
                                    "id",
                                    match get_opt(Some(first), "season_id") {
                                        Some(x) => Out::Raw(x.clone()),
                                        None => Out::Undef,
                                    },
                                ),
                                ("name", Out::from(get_opt(Some(first), "season_name"))),
                                ("active", Out::from(get_opt(Some(first), "active"))),
                                ("start_date", Out::from(get_opt(Some(first), "start_date"))),
                            ]),
                        ),
                        ("singles", shape::season_record(disc("singles"))),
                        ("doubles", shape::season_record(disc("doubles"))),
                        (
                            "final_rating",
                            match fin {
                                Some(f) => Out::obj([
                                    ("singles", Out::from(get_opt(Some(f), "final_singles_elo"))),
                                    ("doubles", Out::from(get_opt(Some(f), "final_doubles_elo"))),
                                ]),
                                None => Out::Null,
                            },
                        ),
                    ]));
                }
                Ok(ok(Out::Obj(vec![
                    ga(),
                    kv("player_ref", Out::str(r)),
                    kv("count", Out::Num(seasons.len() as f64)),
                    kv("seasons", Out::Arr(seasons)),
                ])))
            }

            RouteName::PlayerRatings => {
                let r = var("ref");
                if !self.published(consumer, &r).await? {
                    return Ok(not_found());
                }
                let (limit, offset) = page_of(params);
                let mut a = c();
                a.push(kv("p_player_ref", Out::str(r.clone())));
                for (k, val) in filter_args(
                    params,
                    &[
                        ("type", "p_type"),
                        ("season", "p_season"),
                        ("since", "p_since"),
                        ("until", "p_until"),
                    ],
                ) {
                    set_field(&mut a, &k, val);
                }
                a.push(kv("p_limit", Out::Num((limit + 1) as f64)));
                a.push(kv("p_offset", Out::Num(offset as f64)));
                let rows = self
                    .rpc(consumer, "data_api_rating_history", args(a))
                    .await?;
                let (kept, envelope) = paged(&rows, limit, offset);
                let mut body = vec![ga(), kv("player_ref", Out::str(r))];
                body.extend(envelope);
                body.push(kv("history", shape::map_rows(kept, shape::shape_history)?));
                Ok(ok(Out::Obj(body)))
            }

            RouteName::Seasons => {
                let rows = self.rpc(consumer, "data_api_seasons", args(c())).await?;
                Ok(ok(Out::Obj(vec![
                    ga(),
                    kv("count", Out::Num(rows.len() as f64)),
                    kv("seasons", shape::map_rows(&rows, shape::shape_season)?),
                ])))
            }

            RouteName::Season => {
                let mut a = c();
                a.push(kv("p_season_id", Out::str(var("id"))));
                let rows = self.rpc(consumer, "data_api_seasons", args(a)).await?;
                match rows.first() {
                    Some(row) if truthy(Some(row)) => Ok(ok(Out::Obj(vec![
                        ga(),
                        kv("season", shape::shape_season(row)?),
                    ]))),
                    _ => Ok(not_found()),
                }
            }

            RouteName::SeasonStandings => {
                // The header, not data_api_seasons: that one scans every match
                // for totals this route does not print (00267).
                let mut a = c();
                a.push(kv("p_season_id", Out::str(var("id"))));
                let seasons = self
                    .rpc(consumer, "data_api_season_header", args(a.clone()))
                    .await?;
                let season = match seasons.first() {
                    Some(s) if truthy(Some(s)) => s,
                    _ => return Ok(not_found()),
                };
                let rows = self
                    .rpc(consumer, "data_api_season_standings", args(a))
                    .await?;
                let mut standings = Vec::new();
                for row in rows.iter() {
                    standings.push(Out::obj([
                        ("player_ref", Out::from(get(row, "player_ref")?)),
                        ("singles_elo", Out::from(get(row, "singles_elo")?)),
                        ("doubles_elo", Out::from(get(row, "doubles_elo")?)),
                        ("singles_rank", Out::from(get(row, "singles_rank")?)),
                        ("doubles_rank", Out::from(get(row, "doubles_rank")?)),
                        ("record", shape::win_loss(Some(row))),
                    ]));
                }
                let id = match get_opt(Some(season), "id") {
                    Some(x) => Out::Raw(x.clone()),
                    None => Out::Undef,
                };
                let active = get_opt(Some(season), "active");
                Ok(ok(Out::Obj(vec![
                    ga(),
                    kv(
                        "season",
                        Out::obj([
                            ("id", id),
                            ("name", Out::from(get_opt(Some(season), "name"))),
                            ("active", Out::from(active)),
                        ]),
                    ),
                    kv(
                        "source",
                        Out::str(if matches!(active, Some(Value::Bool(true))) {
                            "live"
                        } else {
                            "archived"
                        }),
                    ),
                    kv("count", Out::Num(rows.len() as f64)),
                    kv("standings", Out::Arr(standings)),
                ])))
            }

            RouteName::Tournaments => {
                let mut a = c();
                a.extend(filter_args(params, &[("season", "p_season")]));
                let rows = self.rpc(consumer, "data_api_tournaments", args(a)).await?;
                Ok(ok(Out::Obj(vec![
                    ga(),
                    kv("count", Out::Num(rows.len() as f64)),
                    kv(
                        "tournaments",
                        shape::map_rows(&rows, shape::shape_tournament)?,
                    ),
                ])))
            }

            RouteName::Tournament => {
                let mut a = c();
                a.push(kv("p_tournament_id", Out::str(var("id"))));
                let rows = self
                    .rpc(consumer, "data_api_tournaments", args(a.clone()))
                    .await?;
                let row = match rows.first() {
                    Some(r) if truthy(Some(r)) => r,
                    _ => return Ok(not_found()),
                };
                let events = self
                    .rpc_prefer(
                        consumer,
                        "data_api_tournament_events_v2",
                        "data_api_tournament_events",
                        args(a.clone()),
                    )
                    .await?;
                let entrants = self
                    .rpc_prefer(
                        consumer,
                        "data_api_tournament_entrants_v2",
                        "data_api_tournament_entrants",
                        args(a),
                    )
                    .await?;
                let mut tournament = shape::shape_tournament(row)?.into_fields();
                let mut shaped_events = Vec::new();
                for e in events.iter() {
                    let mut ev = shape::shape_event(e)?.into_fields();
                    let id = get(e, "id")?;
                    let mut mine = Vec::new();
                    for x in entrants.iter() {
                        if strict_eq(get(x, "event_id")?, id) {
                            mine.push(x.clone());
                        }
                    }
                    ev.push(kv(
                        "entrants",
                        shape::map_rows(&mine, shape::shape_entrant)?,
                    ));
                    shaped_events.push(Out::Obj(ev));
                }
                tournament.push(kv("events", Out::Arr(shaped_events)));
                Ok(ok(Out::Obj(vec![
                    ga(),
                    kv("tournament", Out::Obj(tournament)),
                ])))
            }

            RouteName::TournamentEvent => {
                // The event list is the tournament's visibility check as well: a
                // draft tournament or a hidden season returns no events, so the
                // event 404s.
                let mut a = c();
                a.push(kv("p_tournament_id", Out::str(var("id"))));
                let events = self
                    .rpc_prefer(
                        consumer,
                        "data_api_tournament_events_v2",
                        "data_api_tournament_events",
                        args(a),
                    )
                    .await?;
                let event_id = var("event_id");
                let want = Value::String(event_id.clone());
                let Some(event) = find(&events, |e| Ok(strict_eq(get(e, "id")?, Some(&want))))?
                else {
                    return Ok(not_found());
                };
                let mut a = c();
                a.push(kv("p_event_id", Out::str(event_id)));
                let draw = self
                    .rpc_prefer(
                        consumer,
                        "data_api_tournament_draw_v2",
                        "data_api_tournament_draw",
                        args(a),
                    )
                    .await?;
                Ok(ok(Out::Obj(vec![
                    ga(),
                    kv("tournament_id", Out::str(var("id"))),
                    kv("event", shape::shape_event(event)?),
                    kv("count", Out::Num(draw.len() as f64)),
                    kv("draw", shape::map_rows(&draw, shape::shape_draw_row)?),
                ])))
            }

            RouteName::Sessions | RouteName::Events => {
                let (from, to) = params::schedule_window(params, self.now())
                    .map_err(|_| Failure::Error("Error"))?;
                let sessions = name == RouteName::Sessions;
                let mut a = c();
                a.push(kv("p_from", Out::str(from.clone())));
                a.push(kv("p_to", Out::str(to.clone())));
                let rows = self
                    .rpc(
                        consumer,
                        if sessions {
                            "data_api_sessions"
                        } else {
                            "data_api_club_events"
                        },
                        args(a),
                    )
                    .await?;
                let shaper: fn(&Value) -> Shaped = if sessions {
                    shape::shape_session
                } else {
                    shape::shape_club_event
                };
                Ok(ok(Out::Obj(vec![
                    ga(),
                    kv("from", Out::str(time::strip_millis(&from))),
                    kv("to", Out::str(time::strip_millis(&to))),
                    kv("count", Out::Num(rows.len() as f64)),
                    kv(
                        if sessions { "sessions" } else { "events" },
                        shape::map_rows(&rows, shaper)?,
                    ),
                ])))
            }

            // The first three are answered before authentication, the writes
            // by write() and import_registration().
            RouteName::Health
            | RouteName::Docs
            | RouteName::Changelog
            | RouteName::Predictions
            | RouteName::Registrations => Ok(not_found()),
        }
    }

    async fn route(&self, req: &RequestInfo, ctx: &Mutex<Ctx>) -> Result<Reply, Failure> {
        let parsed = url::parse_target(&req.target).map_err(|_| Failure::Error("TypeError"))?;
        let Some(matched) = match_route(&parsed.pathname) else {
            return Ok(not_found());
        };
        let def = matched.def;
        ctx.lock().expect("ctx lock").path = def.template;
        if matches!(def.name, RouteName::Docs | RouteName::Changelog) {
            if req.method != "GET" && req.method != "HEAD" {
                return Ok(method_not_allowed("GET, HEAD"));
            }
            return Ok(send_html(if def.name == RouteName::Docs {
                DOCS_HTML
            } else {
                CHANGELOG_HTML
            }));
        }
        let methods = def.methods.unwrap_or(GET_ONLY);
        if !methods.contains(&req.method.as_str()) {
            return Ok(method_not_allowed(&methods.join(", ")));
        }
        if def.name == RouteName::Health {
            return Ok(send(
                200,
                Out::obj([
                    ("ok", Out::Bool(true)),
                    ("version", Out::str(self.deps.version.clone())),
                ]),
                vec![],
            ));
        }

        let (auth, key_hash) = match self.authenticate(req).await? {
            Ok(verified) => verified,
            Err(reply) => return Ok(reply),
        };
        ctx.lock().expect("ctx lock").key = Some(auth.key_id.chars().take(8).collect());

        let limit = self
            .key_buckets
            .lock()
            .expect("bucket lock")
            .take(&auth.key_id);
        if !limit.ok {
            return Ok(rate_limited(limit.retry_after));
        }

        if let Some(scope) = def.scope
            && !auth.scopes.iter().any(|s| s == scope)
        {
            return Ok(send(
                403,
                Out::obj([
                    ("error", Out::str("forbidden")),
                    (
                        "detail",
                        Out::str(format!("this key does not carry {scope}")),
                    ),
                ]),
                vec![],
            ));
        }

        let search = parsed
            .query
            .as_deref()
            .map(url::search_params)
            .unwrap_or_default();
        let checked = params::parse_query(&search, def.params, def.strict).and_then(|p| {
            if matches!(def.name, RouteName::Sessions | RouteName::Events) {
                params::schedule_window(&p, self.now())?;
            }
            Ok(p)
        });
        let params = match checked {
            Ok(p) => p,
            Err(BadParam(parameter)) => {
                return Ok(send(
                    400,
                    Out::obj([
                        ("error", Out::str("bad_request")),
                        ("parameter", Out::str(parameter)),
                    ]),
                    vec![],
                ));
            }
        };

        // A ref or id that cannot exist is a 404 without asking the database.
        let mut vars = HashMap::new();
        for (key, value) in matched.vars {
            if REF_VARS.contains(&key) && !is_ref(&value) {
                return Ok(not_found());
            }
            if ID_VARS.contains(&key) && !is_uuid(&value) {
                return Ok(not_found());
            }
            vars.insert(
                key,
                if ID_VARS.contains(&key) {
                    value.to_ascii_lowercase()
                } else {
                    value
                },
            );
        }

        match def.name {
            RouteName::Predictions => return self.write(req, &key_hash).await,
            RouteName::Registrations => {
                return self
                    .import_registration(req, &key_hash, &auth.consumer_id)
                    .await;
            }
            _ => {}
        }

        let generated_at = match time::to_iso(self.now()) {
            Some(iso) => Out::str(time::strip_millis(&iso)),
            None => return Err(Failure::Error("RangeError")),
        };
        self.serve(def.name, &vars, &params, &auth.consumer_id, generated_at)
            .await
    }

    /// Answers one request and writes its log line.
    pub async fn handle(&self, req: RequestInfo, ctx: Arc<Mutex<Ctx>>) -> Reply {
        let started = self.now();
        // Logged by route TEMPLATE, never by path, and the query string is never
        // logged: a path carries player and match refs, and either could carry a
        // key somebody pasted into a URL.
        let reply = match self.route(&req, &ctx).await {
            Ok(r) => r,
            Err(failure) => {
                self.log_failure(&failure);
                unavailable()
            }
        };
        self.log_request(
            &req.method,
            &ctx.lock().expect("ctx lock").clone(),
            reply.status,
            started,
        );
        reply
    }

    pub fn log_failure(&self, failure: &Failure) {
        match failure {
            Failure::Upstream(e) => self.log(Out::obj([
                ("level", Out::str("error")),
                ("msg", Out::str("upstream_failed")),
                ("fn", Out::str(e.fn_name.clone())),
                ("upstream_status", Out::Num(e.status as f64)),
            ])),
            Failure::Error(name) => self.log(Out::obj([
                ("level", Out::str("error")),
                ("msg", Out::str("handler_failed")),
                ("error", Out::str(*name)),
            ])),
        }
    }

    pub fn log_request(&self, method: &str, ctx: &Ctx, status: u16, started: i64) {
        let mut line = vec![
            kv("method", Out::str(method)),
            kv("path", Out::str(ctx.path)),
            kv("status", Out::Num(status as f64)),
            kv("ms", Out::Num((self.now() - started) as f64)),
        ];
        if let Some(k) = &ctx.key
            && !k.is_empty()
        {
            line.push(kv("key", Out::str(k.clone())));
        }
        self.log(Out::Obj(line));
    }
}

pub fn unavailable() -> Reply {
    send(503, Out::obj([("error", Out::str("unavailable"))]), vec![])
}

/// `{...a, [k]: v}`: an existing key keeps its place and takes the new value.
fn set_field(fields: &mut Vec<(String, Out)>, k: &str, v: Out) {
    match fields.iter_mut().find(|(name, _)| name == k) {
        Some(slot) => slot.1 = v,
        None => fields.push((k.to_string(), v)),
    }
}
