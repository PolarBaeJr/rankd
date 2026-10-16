// Key verification with a short cache.
//
// Keyed on the HASH, never the plaintext, so the cache itself holds nothing a
// heap dump could replay. A positive result lives at most 30 seconds, which is
// what API.md promises about revocation. A negative result lives 5 seconds, so
// a guesser repeating one wrong key does not become one database read per
// request. An upstream FAILURE is never cached: a database blip must surface as
// a 503, not as five seconds of 401s for keys that are perfectly valid.
//
// SINGLE FLIGHT: concurrent requests on one uncached key share one
// data_api_verify_key call, and its result fills the cache once. A failure is
// shared by the requests that were waiting on it and kept by nobody. The call
// runs on its own task, so it settles whoever is still waiting.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::watch;

use crate::json;
use crate::key::{hash_key, is_key};
use crate::ordered::OrderedMap;
use crate::rate_limit::Clock;
use crate::upstream::{Upstream, UpstreamError};

pub const POSITIVE_TTL_MS: i64 = 30_000;
pub const NEGATIVE_TTL_MS: i64 = 5_000;
pub const CACHE_MAX_ENTRIES: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedKey {
    pub consumer_id: String,
    pub key_id: String,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BearerResult {
    Malformed,
    /// The hash, and what the cache holds for it.
    Cached(String, Option<VerifiedKey>),
    Uncached(String),
}

struct Entry {
    value: Option<VerifiedKey>,
    expires: i64,
}

type Verified = Option<Result<Option<VerifiedKey>, UpstreamError>>;

pub struct KeyVerifier {
    cache: Arc<Mutex<OrderedMap<Entry>>>,
    in_flight: Arc<Mutex<HashMap<String, watch::Receiver<Verified>>>>,
    upstream: Arc<Upstream>,
    now: Clock,
}

/// The key in `Bearer <key>`, if the header is exactly that. `/^Bearer
/// ([^\s]+)$/` then the key pattern, which admits no whitespace of any kind,
/// so the two together are an exact match.
fn bearer_key(header: Option<&str>) -> Option<&str> {
    let token = header?.strip_prefix("Bearer ")?;
    is_key(token).then_some(token)
}

impl KeyVerifier {
    pub fn new(upstream: Arc<Upstream>, now: Clock) -> Self {
        Self {
            cache: Arc::new(Mutex::new(OrderedMap::default())),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            upstream,
            now,
        }
    }

    /// Parses the Authorization header and consults the cache. Missing and
    /// malformed headers never reach the database: a string that cannot be a
    /// key cannot match a hash.
    pub fn inspect(&self, header: Option<&str>) -> BearerResult {
        let Some(token) = bearer_key(header) else {
            return BearerResult::Malformed;
        };
        let hash = hash_key(token);
        let mut cache = self.cache.lock().expect("key cache lock");
        let t = (self.now)();
        let cached = cache.get(&hash).map(|e| (e.expires > t, e.value.clone()));
        match cached {
            Some((true, value)) => BearerResult::Cached(hash, value),
            Some((false, _)) => {
                cache.delete(&hash);
                BearerResult::Uncached(hash)
            }
            None => BearerResult::Uncached(hash),
        }
    }

    /// Asks the database, or joins the call already asking. An UpstreamError
    /// on failure, uncached.
    pub async fn verify(&self, hash: &str) -> Result<Option<VerifiedKey>, UpstreamError> {
        let mut rx = {
            let mut in_flight = self.in_flight.lock().expect("key in-flight lock");
            match in_flight.get(hash) {
                Some(rx) => rx.clone(),
                None => {
                    let (tx, rx) = watch::channel::<Verified>(None);
                    in_flight.insert(hash.to_string(), rx.clone());
                    let upstream = Arc::clone(&self.upstream);
                    let cache = Arc::clone(&self.cache);
                    let in_flight = Arc::clone(&self.in_flight);
                    let now = Arc::clone(&self.now);
                    let hash = hash.to_string();
                    tokio::spawn(async move {
                        let result = lookup(&upstream, &cache, &now, &hash).await;
                        // Cached (by lookup) before it leaves the in-flight map, so a
                        // newcomer finds one or the other.
                        in_flight.lock().expect("key in-flight lock").remove(&hash);
                        let _ = tx.send(Some(result));
                    });
                    rx
                }
            }
        };
        let settled = rx.wait_for(Option::is_some).await;
        match settled {
            Ok(v) => v.clone().expect("settled"),
            // The task ended without settling: it panicked.
            Err(_) => Err(UpstreamError {
                fn_name: "data_api_verify_key".to_string(),
                status: 0,
            }),
        }
    }
}

async fn lookup(
    upstream: &Upstream,
    cache: &Mutex<OrderedMap<Entry>>,
    now: &Clock,
    hash: &str,
) -> Result<Option<VerifiedKey>, UpstreamError> {
    let mut args = String::new();
    json::write_out(
        &mut args,
        &json::Out::obj([("p_key_hash", json::Out::str(hash))]),
    );
    let rows = upstream.rpc("data_api_verify_key", args).await?;
    let value = match rows.first() {
        Some(Value::Object(row)) => {
            match (row.get("consumer_id"), row.get("key_id"), row.get("scopes")) {
                (Some(Value::String(c)), Some(Value::String(k)), Some(Value::Array(scopes))) => {
                    Some(VerifiedKey {
                        consumer_id: c.clone(),
                        key_id: k.clone(),
                        scopes: scopes
                            .iter()
                            .filter_map(|s| s.as_str().map(str::to_string))
                            .collect(),
                    })
                }
                _ => None,
            }
        }
        _ => None,
    };
    let mut cache = cache.lock().expect("key cache lock");
    let ttl = if value.is_some() {
        POSITIVE_TTL_MS
    } else {
        NEGATIVE_TTL_MS
    };
    // `map.set` on an existing hash keeps its place, as in Node.
    cache.set(
        hash,
        Entry {
            value: value.clone(),
            expires: now() + ttl,
        },
    );
    while cache.len() > CACHE_MAX_ENTRIES {
        if !cache.delete_oldest() {
            break;
        }
    }
    Ok(value)
}
