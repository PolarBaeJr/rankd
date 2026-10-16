// The read cache in front of the read RPCs.
//
// Every read the API serves goes through one of a few SECURITY DEFINER
// functions, and most of them build their answer from data_api_match_rows(),
// which is a scan of the club's whole match history. Ten consumers asking for
// the same standings at once were ten scans. With this cache they are one:
// identical calls in flight share a single database call (single flight), and
// its answer is reused for the function's TTL.
//
// THE KEY is the consumer, the function name and its exact arguments. The
// arguments are built from the parsed query parameters (params.ts lower-cases
// uuids and rewrites every timestamp to one ISO form), so two spellings of the
// same request share an entry. Every public read function also takes the
// consumer id first, and the consumer is part of the key besides: one
// consumer's refs can never be served to another.
//
// TTL BY FUNCTION, not by route: a route can read several functions, and a
// function serves several routes. Results, ratings and the roster change only
// when a match is recorded, an exec edits a season or a member changes a
// privacy setting, so those live 60 seconds. Tournament draws and entrants, and
// the session and club-event counts, move while an event is running, so those
// live 30 seconds. A function missing from the table gets the shorter TTL.
//
// BOUNDED by entries and by bytes (the raw length of each upstream body), least
// recently used first: a hit moves its entry to the back. Failures are not
// kept: a rejected call is dropped as soon as it settles, so the next request
// asks the database again. A degraded answer (the season block of /v1/players,
// the v1 fallback for a v2 reader) is decided by the handler after the cache,
// so it is never what the cache holds.
//
// A WRITE that changes what a read returns drops that consumer's entries for
// the functions it changes (invalidate), in flight or settled, so a read sent
// after the write never joins a call that started before it. Other consumers
// see the change when their own entries expire.
//
// Key verification does NOT go through here. It has its own cache, with its own
// 30-second contract for revocation (auth.ts).

/** Results, ratings, the roster and seasons: they change when a match is recorded. */
export const SETTLED_TTL_MS = 60_000;
/** Tournaments and the schedule: draws, entrants and counts move during an event. */
export const LIVE_TTL_MS = 30_000;

/** Each read function's TTL. The Rust port's tests read this table. */
export const RPC_TTL_MS: Readonly<Record<string, number>> = {
  data_api_players: SETTLED_TTL_MS,
  data_api_player_by_ref: SETTLED_TTL_MS,
  data_api_player_published: SETTLED_TTL_MS,
  data_api_active_season: SETTLED_TTL_MS,
  data_api_matches: SETTLED_TTL_MS,
  data_api_match_by_ref: SETTLED_TTL_MS,
  data_api_head_to_head: SETTLED_TTL_MS,
  data_api_player_seasons: SETTLED_TTL_MS,
  data_api_rating_history: SETTLED_TTL_MS,
  data_api_seasons: SETTLED_TTL_MS,
  data_api_season_header: SETTLED_TTL_MS,
  data_api_season_standings: SETTLED_TTL_MS,
  data_api_tournaments: LIVE_TTL_MS,
  data_api_tournament_events: LIVE_TTL_MS,
  data_api_tournament_events_v2: LIVE_TTL_MS,
  data_api_tournament_entrants: LIVE_TTL_MS,
  data_api_tournament_entrants_v2: LIVE_TTL_MS,
  data_api_tournament_draw: LIVE_TTL_MS,
  data_api_tournament_draw_v2: LIVE_TTL_MS,
  data_api_sessions: LIVE_TTL_MS,
  data_api_club_events: LIVE_TTL_MS,
};

export function rpcTtlMs(fn: string): number {
  return Object.hasOwn(RPC_TTL_MS, fn) ? RPC_TTL_MS[fn]! : LIVE_TTL_MS;
}

/**
 * The reads a registration import can change: it enters external teams (the
 * entrant lists), withdraws entries and fills from the waitlist (entrant
 * statuses), and signs people up to club events (the signup count). No read
 * function reads predictions, so a prediction write drops nothing.
 */
export const REGISTRATION_READS: readonly string[] = [
  'data_api_tournament_entrants',
  'data_api_tournament_entrants_v2',
  'data_api_club_events',
];

export const RPC_CACHE_MAX_ENTRIES = 2000;
export const RPC_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** What a load returns: the rows, and the length of the body they came from. */
export interface Loaded {
  rows: unknown[];
  bytes: number;
}

interface Entry {
  consumer: string;
  fn: string;
  expires: number;
  /** Zero until the call settles. */
  bytes: number;
  value: Promise<unknown[]>;
}

export class RpcCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(
    private readonly now: () => number,
    private readonly maxEntries = RPC_CACHE_MAX_ENTRIES,
    private readonly maxBytes = RPC_CACHE_MAX_BYTES,
  ) {}

  get(consumer: string, fn: string, args: Record<string, unknown>, load: () => Promise<Loaded>): Promise<unknown[]> {
    const key = consumer + '\u0000' + fn + '\u0000' + JSON.stringify(args);
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > t) {
      // Least recently used goes first: a hit moves to the back.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    if (hit) this.remove(key, hit);

    const loading = load();
    const entry: Entry = {
      consumer,
      fn,
      expires: t + rpcTtlMs(fn),
      bytes: 0,
      value: loading.then((loaded) => loaded.rows),
    };
    this.entries.set(key, entry);
    loading.then(
      (loaded) => {
        if (this.entries.get(key) !== entry) return;
        // An answer bigger than the whole cache is served and not kept, rather
        // than emptying the cache to make room for it.
        if (loaded.bytes > this.maxBytes) {
          this.remove(key, entry);
          return;
        }
        entry.bytes = loaded.bytes;
        this.totalBytes += loaded.bytes;
        this.evict();
      },
      () => {
        if (this.entries.get(key) === entry) this.remove(key, entry);
      },
    );
    this.evict();
    return entry.value;
  }

  /** Drops the consumer's entries for these functions, in flight or settled. */
  invalidate(consumer: string, fns: readonly string[]): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.consumer === consumer && fns.includes(entry.fn)) {
        this.remove(key, entry);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  // Map iterates in insertion order, and a hit re-inserts, so the first
  // entries are the least recently used.
  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
      this.remove(key, entry);
    }
  }
}
