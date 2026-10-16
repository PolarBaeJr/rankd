import { describe, expect, it } from 'vitest';
import { LIVE_TTL_MS, RPC_TTL_MS, RpcCache, SETTLED_TTL_MS, rpcTtlMs, type Loaded } from '../rpc-cache.js';

const loaded = (rows: unknown[], bytes = 10): Promise<Loaded> => Promise.resolve({ rows, bytes });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RpcCache', () => {
  it('picks the TTL by function, the shorter one for a function it does not know', () => {
    expect(SETTLED_TTL_MS).toBe(60_000);
    expect(LIVE_TTL_MS).toBe(30_000);
    expect(rpcTtlMs('data_api_matches')).toBe(60_000);
    expect(rpcTtlMs('data_api_tournament_draw_v2')).toBe(30_000);
    expect(rpcTtlMs('data_api_something_new')).toBe(30_000);
    expect(rpcTtlMs('toString')).toBe(30_000);
    expect(Object.keys(RPC_TTL_MS)).toHaveLength(21);
  });

  it('keys on consumer, function and arguments', async () => {
    const clock = { t: 0 };
    const cache = new RpcCache(() => clock.t);
    let calls = 0;
    const load = () => {
      calls += 1;
      return loaded([calls]);
    };
    await cache.get('c1', 'data_api_players', { p_consumer_id: 'c1' }, load);
    await cache.get('c1', 'data_api_players', { p_consumer_id: 'c1' }, load);
    expect(calls).toBe(1);
    await cache.get('c2', 'data_api_players', { p_consumer_id: 'c1' }, load);
    await cache.get('c1', 'data_api_seasons', { p_consumer_id: 'c1' }, load);
    await cache.get('c1', 'data_api_players', { p_consumer_id: 'c1', p_limit: 2 }, load);
    expect(calls).toBe(4);
  });

  it('expires at the function TTL, counted from the call', async () => {
    const clock = { t: 1000 };
    const cache = new RpcCache(() => clock.t);
    let calls = 0;
    const load = () => {
      calls += 1;
      return loaded([]);
    };
    await cache.get('c', 'data_api_sessions', {}, load);
    clock.t += LIVE_TTL_MS - 1;
    await cache.get('c', 'data_api_sessions', {}, load);
    expect(calls).toBe(1);
    clock.t += 1;
    await cache.get('c', 'data_api_sessions', {}, load);
    expect(calls).toBe(2);
  });

  it('shares one call between concurrent misses, and drops a failure', async () => {
    const cache = new RpcCache(() => 0);
    const pending = deferred<Loaded>();
    let calls = 0;
    const load = () => {
      calls += 1;
      return pending.promise;
    };
    const first = cache.get('c', 'data_api_players', {}, load);
    const second = cache.get('c', 'data_api_players', {}, load);
    expect(calls).toBe(1);
    pending.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(cache.size).toBe(0);
    await cache.get('c', 'data_api_players', {}, () => loaded([1]));
    expect(cache.size).toBe(1);
  });

  it('evicts the least recently used entry past the entry cap', async () => {
    const cache = new RpcCache(() => 0, 2);
    let calls = 0;
    const load = () => {
      calls += 1;
      return loaded([]);
    };
    await cache.get('c', 'a', {}, load);
    await cache.get('c', 'b', {}, load);
    await cache.get('c', 'a', {}, load); // a hit: `a` is now the most recent
    await cache.get('c', 'd', {}, load); // evicts `b`
    expect(calls).toBe(3);
    await cache.get('c', 'a', {}, load);
    expect(calls).toBe(3);
    await cache.get('c', 'b', {}, load);
    expect(calls).toBe(4);
  });

  it('evicts past the byte cap, counting each body once it arrives', async () => {
    const cache = new RpcCache(() => 0, 100, 100);
    await cache.get('c', 'a', {}, () => loaded([], 60));
    await cache.get('c', 'b', {}, () => loaded([], 30));
    expect(cache.bytes).toBe(90);
    await cache.get('c', 'd', {}, () => loaded([], 30));
    // `a` was the least recently used and goes first.
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(60);
    // A body larger than the whole cap is answered and not kept, and the
    // entries already there stay.
    const rows = await cache.get('c', 'huge', {}, () => loaded(['x'], 500));
    expect(rows).toEqual(['x']);
    await Promise.resolve();
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(60);
  });

  it('invalidates one consumer\'s entries for the named functions, in flight or settled', async () => {
    const cache = new RpcCache(() => 0);
    let calls = 0;
    const load = () => {
      calls += 1;
      return loaded([calls]);
    };
    await cache.get('c1', 'data_api_club_events', {}, load);
    await cache.get('c2', 'data_api_club_events', {}, load);
    await cache.get('c1', 'data_api_sessions', {}, load);
    const inFlight = deferred<Loaded>();
    void cache.get('c1', 'data_api_tournament_entrants_v2', {}, () => inFlight.promise);
    expect(cache.invalidate('c1', ['data_api_club_events', 'data_api_tournament_entrants_v2'])).toBe(2);
    inFlight.resolve({ rows: [], bytes: 5 });
    await inFlight.promise;
    expect(cache.size).toBe(2);
    // The settled call that was dropped does not count against the byte cap.
    expect(cache.bytes).toBe(20);
    await cache.get('c1', 'data_api_club_events', {}, load);
    await cache.get('c2', 'data_api_club_events', {}, load);
    await cache.get('c1', 'data_api_sessions', {}, load);
    expect(calls).toBe(4);
  });
});
