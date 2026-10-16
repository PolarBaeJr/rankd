// A map that remembers insertion order, the way a JavaScript Map does, so the
// caches and buckets evict their oldest entry exactly as the Node service did.

use std::collections::{BTreeMap, HashMap};

pub struct OrderedMap<V> {
    entries: HashMap<String, (u64, V)>,
    order: BTreeMap<u64, String>,
    next: u64,
}

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: BTreeMap::new(),
            next: 0,
        }
    }
}

impl<V> OrderedMap<V> {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.entries.get(key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries.get_mut(key).map(|(_, v)| v)
    }

    /// `map.set`: a new key goes last, an existing key keeps its place.
    pub fn set(&mut self, key: &str, value: V) {
        if let Some((_, v)) = self.entries.get_mut(key) {
            *v = value;
            return;
        }
        let seq = self.next;
        self.next += 1;
        self.order.insert(seq, key.to_string());
        self.entries.insert(key.to_string(), (seq, value));
    }

    pub fn delete(&mut self, key: &str) -> Option<V> {
        let (seq, v) = self.entries.remove(key)?;
        self.order.remove(&seq);
        Some(v)
    }

    /// Removes the oldest entry.
    pub fn delete_oldest(&mut self) -> bool {
        self.pop_oldest().is_some()
    }

    /// Removes the oldest entry and hands it back.
    pub fn pop_oldest(&mut self) -> Option<V> {
        let (_, key) = self.order.pop_first()?;
        self.entries.remove(&key).map(|(_, v)| v)
    }

    /// Moves an existing key to the back, as `map.delete(k); map.set(k, v)`.
    pub fn touch(&mut self, key: &str) {
        let Some((seq, _)) = self.entries.get_mut(key) else {
            return;
        };
        let old = *seq;
        let new = self.next;
        self.next += 1;
        *seq = new;
        if let Some(k) = self.order.remove(&old) {
            self.order.insert(new, k);
        }
    }

    /// Entries oldest first.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.order
            .values()
            .filter_map(|k| self.entries.get(k).map(|(_, v)| (k.as_str(), v)))
    }
}
