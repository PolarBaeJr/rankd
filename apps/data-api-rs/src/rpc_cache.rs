// The read cache in front of the read RPCs. A port of rpc-cache.ts; the
// reasoning is there, in short:
//
// Every read the API serves goes through one of a few SECURITY DEFINER
// functions, most of them a scan of the club's whole match history. Identical
// calls in flight share a single database call (single flight), and its answer
// is reused for the function's TTL.
//
// THE KEY is the consumer, the function name and its exact arguments (built
// from parameters params.rs has already normalised), so one consumer's refs
// can never be served to another.
//
// TTL BY FUNCTION: results, ratings, the roster and seasons live 60 seconds;
// tournaments and the schedule 30; a function missing from the table 30.
//
// BOUNDED by entries and by bytes (the raw length of each upstream body), least
// recently used first. Failures are not kept. A write that changes what a read
// returns drops that consumer's entries for those functions, in flight or
// settled.
//
// Key verification does NOT go through here. It has its own cache, with its own
// 30-second contract for revocation (auth.rs).

use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::ordered::OrderedMap;
use crate::rate_limit::Clock;
use crate::upstream::{Rows, Upstream, UpstreamError};

/// Results, ratings, the roster and seasons: they change when a match is recorded.
pub const SETTLED_TTL_MS: i64 = 60_000;
/// Tournaments and the schedule: draws, entrants and counts move during an event.
pub const LIVE_TTL_MS: i64 = 30_000;

/// Each read function's TTL; tests/drift.rs holds it equal to rpc-cache.ts.
pub const RPC_TTL_MS: &[(&str, i64)] = &[
    ("data_api_players", SETTLED_TTL_MS),
    ("data_api_player_by_ref", SETTLED_TTL_MS),
    ("data_api_player_published", SETTLED_TTL_MS),
    ("data_api_active_season", SETTLED_TTL_MS),
    ("data_api_matches", SETTLED_TTL_MS),
    ("data_api_match_by_ref", SETTLED_TTL_MS),
    ("data_api_head_to_head", SETTLED_TTL_MS),
    ("data_api_player_seasons", SETTLED_TTL_MS),
    ("data_api_rating_history", SETTLED_TTL_MS),
    ("data_api_seasons", SETTLED_TTL_MS),
    ("data_api_season_header", SETTLED_TTL_MS),
    ("data_api_season_standings", SETTLED_TTL_MS),
    ("data_api_tournaments", LIVE_TTL_MS),
    ("data_api_tournament_events", LIVE_TTL_MS),
    ("data_api_tournament_events_v2", LIVE_TTL_MS),
    ("data_api_tournament_entrants", LIVE_TTL_MS),
    ("data_api_tournament_entrants_v2", LIVE_TTL_MS),
    ("data_api_tournament_draw", LIVE_TTL_MS),
    ("data_api_tournament_draw_v2", LIVE_TTL_MS),
    ("data_api_sessions", LIVE_TTL_MS),
    ("data_api_club_events", LIVE_TTL_MS),
];

pub fn rpc_ttl_ms(fn_name: &str) -> i64 {
    RPC_TTL_MS
        .iter()
        .find(|(name, _)| *name == fn_name)
        .map_or(LIVE_TTL_MS, |(_, ttl)| *ttl)
}

/// The reads a registration import can change (entrant lists and statuses,
/// club event signup counts). No read function reads predictions.
pub const REGISTRATION_READS: &[&str] = &[
    "data_api_tournament_entrants",
    "data_api_tournament_entrants_v2",
    "data_api_club_events",
];

pub const RPC_CACHE_MAX_ENTRIES: usize = 2000;
pub const RPC_CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;

type Settled = Option<Result<Rows, UpstreamError>>;

struct Entry {
    id: u64,
    consumer: String,
    fn_name: String,
    expires: i64,
    /// Zero until the call settles.
    bytes: usize,
    value: watch::Receiver<Settled>,
}

struct Inner {
    entries: OrderedMap<Entry>,
    next_id: u64,
    total_bytes: usize,
    max_entries: usize,
    max_bytes: usize,
}

impl Inner {
    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.delete(key) {
            self.total_bytes -= entry.bytes;
        }
    }

    // The map keeps insertion order and a hit moves to the back, so the
    // oldest entry is the least recently used.
    fn evict(&mut self) {
        while self.entries.len() > self.max_entries || self.total_bytes > self.max_bytes {
            match self.entries.pop_oldest() {
                Some(entry) => self.total_bytes -= entry.bytes,
                None => break,
            }
        }
    }
}

/// What the upstream call behind a miss is: the rows and the body length.
pub type Load = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<(Rows, usize), UpstreamError>> + Send>,
>;

pub struct RpcCache {
    inner: Arc<Mutex<Inner>>,
    now: Clock,
}

impl RpcCache {
    pub fn new(now: Clock) -> Self {
        Self::with_limits(now, RPC_CACHE_MAX_ENTRIES, RPC_CACHE_MAX_BYTES)
    }

    pub fn with_limits(now: Clock, max_entries: usize, max_bytes: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                entries: OrderedMap::default(),
                next_id: 0,
                total_bytes: 0,
                max_entries,
                max_bytes,
            })),
            now,
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("cache lock").entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn bytes(&self) -> usize {
        self.inner.lock().expect("cache lock").total_bytes
    }

    /// The rows for `fn_name(args_json)` as `consumer`, from the upstream.
    pub async fn get(
        &self,
        upstream: &Arc<Upstream>,
        consumer: &str,
        fn_name: &str,
        args_json: String,
    ) -> Result<Rows, UpstreamError> {
        let upstream = Arc::clone(upstream);
        let name = fn_name.to_string();
        self.get_with(consumer, fn_name, args_json, move |args| {
            Box::pin(async move { upstream.rpc_sized(&name, args).await })
        })
        .await
    }

    /// The rows for `fn_name(args_json)` as `consumer`, from a call in flight
    /// or settled within the TTL, or from `load` started now.
    pub async fn get_with(
        &self,
        consumer: &str,
        fn_name: &str,
        args_json: String,
        load: impl FnOnce(String) -> Load,
    ) -> Result<Rows, UpstreamError> {
        let key = format!("{consumer}\u{0}{fn_name}\u{0}{args_json}");
        let mut rx = {
            let t = (self.now)();
            let mut inner = self.inner.lock().expect("cache lock");
            let hit = inner
                .entries
                .get(&key)
                .map(|e| (e.expires > t, e.value.clone()));
            match hit {
                Some((true, rx)) => {
                    // Least recently used goes first: a hit moves to the back.
                    inner.entries.touch(&key);
                    rx
                }
                other => {
                    if other.is_some() {
                        inner.remove(&key);
                    }
                    let (tx, rx) = watch::channel::<Settled>(None);
                    let id = inner.next_id;
                    inner.next_id += 1;
                    inner.entries.set(
                        &key,
                        Entry {
                            id,
                            consumer: consumer.to_string(),
                            fn_name: fn_name.to_string(),
                            expires: t + rpc_ttl_ms(fn_name),
                            bytes: 0,
                            value: rx.clone(),
                        },
                    );
                    inner.evict();
                    drop(inner);
                    // The call runs on its own task, so it settles (and a failure
                    // is dropped from the cache) whoever is still waiting on it.
                    let cache = Arc::clone(&self.inner);
                    let key = key.clone();
                    let call = load(args_json);
                    tokio::spawn(async move {
                        let result = call.await;
                        {
                            let mut inner = cache.lock().expect("cache lock");
                            let current = inner.entries.get(&key).is_some_and(|e| e.id == id);
                            match &result {
                                Ok((_, bytes)) if current => {
                                    // An answer bigger than the whole cache is served
                                    // and not kept, rather than emptying the cache.
                                    if *bytes > inner.max_bytes {
                                        inner.remove(&key);
                                    } else {
                                        if let Some(entry) = inner.entries.get_mut(&key) {
                                            entry.bytes = *bytes;
                                        }
                                        inner.total_bytes += *bytes;
                                        inner.evict();
                                    }
                                }
                                Err(_) if current => inner.remove(&key),
                                _ => {}
                            }
                        }
                        let _ = tx.send(Some(result.map(|(rows, _)| rows)));
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
                fn_name: fn_name.to_string(),
                status: 0,
            }),
        }
    }

    /// Drops the consumer's entries for these functions, in flight or settled.
    pub fn invalidate(&self, consumer: &str, fns: &[&str]) -> usize {
        let mut inner = self.inner.lock().expect("cache lock");
        let doomed: Vec<String> = inner
            .entries
            .iter()
            .filter(|(_, e)| e.consumer == consumer && fns.contains(&e.fn_name.as_str()))
            .map(|(k, _)| k.to_string())
            .collect();
        for key in &doomed {
            inner.remove(key);
        }
        doomed.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    fn clock(at: &Arc<AtomicI64>) -> Clock {
        let at = Arc::clone(at);
        Arc::new(move || at.load(Ordering::SeqCst))
    }

    fn rows(n: usize) -> Rows {
        Arc::new(vec![serde_json::json!(n)])
    }

    /// A load that counts its calls and answers `bytes` long.
    fn counted(calls: &Arc<AtomicUsize>, bytes: usize) -> impl FnOnce(String) -> Load {
        let calls = Arc::clone(calls);
        move |_| {
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            Box::pin(async move { Ok((rows(n), bytes)) })
        }
    }

    #[test]
    fn picks_the_ttl_by_function() {
        assert_eq!(rpc_ttl_ms("data_api_matches"), 60_000);
        assert_eq!(rpc_ttl_ms("data_api_tournament_draw_v2"), 30_000);
        assert_eq!(rpc_ttl_ms("data_api_something_new"), 30_000);
        assert_eq!(RPC_TTL_MS.len(), 21);
    }

    #[tokio::test]
    async fn keys_on_consumer_function_and_arguments() {
        let t = Arc::new(AtomicI64::new(0));
        let cache = RpcCache::new(clock(&t));
        let calls = Arc::new(AtomicUsize::new(0));
        for (consumer, f, args) in [
            ("c1", "data_api_players", "{}"),
            ("c1", "data_api_players", "{}"),
            ("c2", "data_api_players", "{}"),
            ("c1", "data_api_seasons", "{}"),
            ("c1", "data_api_players", "{\"p_limit\":2}"),
        ] {
            cache
                .get_with(consumer, f, args.to_string(), counted(&calls, 1))
                .await
                .unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn expires_at_the_function_ttl() {
        let t = Arc::new(AtomicI64::new(1000));
        let cache = RpcCache::new(clock(&t));
        let calls = Arc::new(AtomicUsize::new(0));
        let get = || cache.get_with("c", "data_api_sessions", String::new(), counted(&calls, 1));
        get().await.unwrap();
        t.fetch_add(LIVE_TTL_MS - 1, Ordering::SeqCst);
        get().await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        t.fetch_add(1, Ordering::SeqCst);
        get().await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn shares_one_call_between_concurrent_misses_and_drops_a_failure() {
        let t = Arc::new(AtomicI64::new(0));
        let cache = Arc::new(RpcCache::new(clock(&t)));
        let calls = Arc::new(AtomicUsize::new(0));
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let first = {
            let cache = Arc::clone(&cache);
            let calls = Arc::clone(&calls);
            tokio::spawn(async move {
                cache
                    .get_with("c", "data_api_players", String::new(), move |_| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Box::pin(async move {
                            let _ = released.await;
                            Err(UpstreamError {
                                fn_name: "data_api_players".into(),
                                status: 500,
                            })
                        })
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        let second = {
            let cache = Arc::clone(&cache);
            let calls = Arc::clone(&calls);
            tokio::spawn(async move {
                cache
                    .get_with("c", "data_api_players", String::new(), counted(&calls, 1))
                    .await
            })
        };
        tokio::task::yield_now().await;
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap().unwrap_err().status, 500);
        assert_eq!(second.await.unwrap().unwrap_err().status, 500);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(cache.is_empty());
    }

    #[tokio::test]
    async fn evicts_the_least_recently_used_past_the_entry_cap() {
        let t = Arc::new(AtomicI64::new(0));
        let cache = RpcCache::with_limits(clock(&t), 2, RPC_CACHE_MAX_BYTES);
        let calls = Arc::new(AtomicUsize::new(0));
        for f in ["a", "b", "a", "d", "a"] {
            cache
                .get_with("c", f, String::new(), counted(&calls, 1))
                .await
                .unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        cache
            .get_with("c", "b", String::new(), counted(&calls, 1))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn evicts_past_the_byte_cap() {
        let t = Arc::new(AtomicI64::new(0));
        let cache = RpcCache::with_limits(clock(&t), 100, 100);
        let calls = Arc::new(AtomicUsize::new(0));
        for (f, bytes) in [("a", 60), ("b", 30)] {
            cache
                .get_with("c", f, String::new(), counted(&calls, bytes))
                .await
                .unwrap();
        }
        assert_eq!(cache.bytes(), 90);
        cache
            .get_with("c", "d", String::new(), counted(&calls, 30))
            .await
            .unwrap();
        assert_eq!((cache.len(), cache.bytes()), (2, 60));
        let rows = cache
            .get_with("c", "huge", String::new(), counted(&calls, 500))
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((cache.len(), cache.bytes()), (2, 60));
    }

    #[tokio::test]
    async fn invalidates_one_consumers_named_functions() {
        let t = Arc::new(AtomicI64::new(0));
        let cache = RpcCache::new(clock(&t));
        let calls = Arc::new(AtomicUsize::new(0));
        let reads = [
            ("c1", "data_api_club_events"),
            ("c2", "data_api_club_events"),
            ("c1", "data_api_sessions"),
        ];
        for (consumer, f) in reads {
            cache
                .get_with(consumer, f, String::new(), counted(&calls, 10))
                .await
                .unwrap();
        }
        assert_eq!(cache.invalidate("c1", REGISTRATION_READS), 1);
        assert_eq!((cache.len(), cache.bytes()), (2, 20));
        for (consumer, f) in reads {
            cache
                .get_with(consumer, f, String::new(), counted(&calls, 10))
                .await
                .unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }
}
