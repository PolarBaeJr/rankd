import { hashKey, KEY_PATTERN } from './key.js';
import type { Upstream } from './upstream.js';

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
// shared by the requests that were waiting on it and kept by nobody.

export const POSITIVE_TTL_MS = 30_000;
export const NEGATIVE_TTL_MS = 5_000;
export const CACHE_MAX_ENTRIES = 1000;

export interface VerifiedKey {
  consumerId: string;
  keyId: string;
  scopes: string[];
}

interface Entry {
  value: VerifiedKey | null;
  expires: number;
}

export type BearerResult =
  | { kind: 'malformed' }
  | { kind: 'cached'; hash: string; value: VerifiedKey | null }
  | { kind: 'uncached'; hash: string };

export class KeyVerifier {
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<VerifiedKey | null>>();

  constructor(
    private readonly upstream: Upstream,
    private readonly now: () => number,
  ) {}

  /**
   * Parses the Authorization header and consults the cache. Missing and
   * malformed headers never reach the database: a string that cannot be a key
   * cannot match a hash.
   */
  inspect(header: string | undefined): BearerResult {
    const match = /^Bearer ([^\s]+)$/.exec(header ?? '');
    const token = match?.[1];
    if (!token || !KEY_PATTERN.test(token)) return { kind: 'malformed' };
    const hash = hashKey(token);
    const entry = this.cache.get(hash);
    if (entry && entry.expires > this.now()) return { kind: 'cached', hash, value: entry.value };
    if (entry) this.cache.delete(hash);
    return { kind: 'uncached', hash };
  }

  /** Asks the database, or joins the call already asking. Throws UpstreamError on failure, uncached. */
  verify(hash: string): Promise<VerifiedKey | null> {
    const pending = this.inFlight.get(hash);
    if (pending) return pending;
    const lookup = this.lookup(hash).finally(() => {
      if (this.inFlight.get(hash) === lookup) this.inFlight.delete(hash);
    });
    this.inFlight.set(hash, lookup);
    return lookup;
  }

  private async lookup(hash: string): Promise<VerifiedKey | null> {
    const rows = await this.upstream.rpc('data_api_verify_key', { p_key_hash: hash });
    const row = rows[0] as { consumer_id?: unknown; key_id?: unknown; scopes?: unknown } | undefined;
    const value =
      row &&
      typeof row.consumer_id === 'string' &&
      typeof row.key_id === 'string' &&
      Array.isArray(row.scopes)
        ? { consumerId: row.consumer_id, keyId: row.key_id, scopes: row.scopes.filter((s): s is string => typeof s === 'string') }
        : null;
    this.cache.set(hash, {
      value,
      expires: this.now() + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return value;
  }
}
