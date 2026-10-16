// In-memory token buckets.
//
// THE EDGE PROXY IS THE PRIMARY LIMITER. These buckets are per process: with
// two replicas a caller gets twice the budget, and a restart refills every
// bucket. They exist so that one consumer, or one key-guesser, cannot turn this
// service into a database load generator between the edge and PostgREST.

use std::sync::Arc;

use crate::ordered::OrderedMap;

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TakeResult {
    pub ok: bool,
    /// Whole seconds until one token is available again. 0 when ok.
    pub retry_after: i64,
}

struct Bucket {
    tokens: f64,
    at: i64,
}

pub struct TokenBuckets {
    buckets: OrderedMap<Bucket>,
    capacity: f64,
    per_ms: f64,
    max_entries: usize,
    now: Clock,
}

impl TokenBuckets {
    pub fn new(capacity: u32, window_ms: u32, max_entries: usize, now: Clock) -> Self {
        Self {
            buckets: OrderedMap::default(),
            capacity: capacity as f64,
            per_ms: capacity as f64 / window_ms as f64,
            max_entries,
            now,
        }
    }

    /// Refills the bucket and moves it to the most recently used end.
    fn refill(&mut self, id: &str) -> f64 {
        let t = (self.now)();
        let bucket = match self.buckets.delete(id) {
            None => Bucket {
                tokens: self.capacity,
                at: t,
            },
            Some(b) => Bucket {
                tokens: self
                    .capacity
                    .min(b.tokens + (t - b.at) as f64 * self.per_ms),
                at: t,
            },
        };
        let tokens = bucket.tokens;
        self.buckets.set(id, bucket);
        while self.buckets.len() > self.max_entries {
            if !self.buckets.delete_oldest() {
                break;
            }
        }
        tokens
    }

    fn retry_after(&self, tokens: f64) -> i64 {
        (((1.0 - tokens) / self.per_ms / 1000.0).ceil() as i64).max(1)
    }

    /// Spend one token if there is one.
    pub fn take(&mut self, id: &str) -> TakeResult {
        let tokens = self.refill(id);
        if tokens >= 1.0 {
            // An evicted bucket (max_entries 0) is not charged, as in Node,
            // where the spend landed on an object no longer in the map.
            if let Some(b) = self.bucket_mut(id) {
                b.tokens -= 1.0;
            }
            return TakeResult {
                ok: true,
                retry_after: 0,
            };
        }
        TakeResult {
            ok: false,
            retry_after: self.retry_after(tokens),
        }
    }

    /// Whether a token is available, without spending it.
    pub fn check(&mut self, id: &str) -> TakeResult {
        let tokens = self.refill(id);
        if tokens >= 1.0 {
            TakeResult {
                ok: true,
                retry_after: 0,
            }
        } else {
            TakeResult {
                ok: false,
                retry_after: self.retry_after(tokens),
            }
        }
    }

    fn bucket_mut(&mut self, id: &str) -> Option<&mut Bucket> {
        self.buckets.get_mut(id)
    }
}
