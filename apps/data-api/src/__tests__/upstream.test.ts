import { describe, expect, it } from 'vitest';
import { createUpstream, Gate, UpstreamError, type FetchLike } from '../upstream.js';

/** A fetch that holds every call until released, honouring the abort signal. */
function heldFetch() {
  const state = { inFlight: 0, maxInFlight: 0, calls: 0, releases: [] as (() => void)[] };
  const fetch: FetchLike = (_input, init) => {
    state.calls += 1;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    return new Promise<Response>((resolve, reject) => {
      const done = () => {
        state.inFlight -= 1;
      };
      init.signal?.addEventListener('abort', () => {
        done();
        reject(new Error('aborted'));
      });
      state.releases.push(() => {
        done();
        resolve(new Response('[{"ok":true}]', { status: 200 }));
      });
    });
  };
  return { fetch, state };
}

const opts = { supabaseUrl: 'http://kong.test', anonKey: 'anon', dbJwt: 'jwt' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('upstream concurrency cap', () => {
  it('keeps at most `concurrency` calls in flight and queues the rest in order', async () => {
    const { fetch, state } = heldFetch();
    const upstream = createUpstream({ ...opts, fetch, concurrency: 3 });
    const results = Array.from({ length: 7 }, (_, i) => upstream.rpc(`fn_${i}`, {}));
    await tick();
    expect(state.calls).toBe(3);
    while (state.releases.length > 0) {
      state.releases.shift()!();
      await tick();
    }
    expect((await Promise.all(results)).every((rows) => rows.length === 1)).toBe(true);
    expect(state.calls).toBe(7);
    expect(state.maxInFlight).toBe(3);
  });

  it('defaults to 16', async () => {
    const { fetch, state } = heldFetch();
    const upstream = createUpstream({ ...opts, fetch });
    const results = Array.from({ length: 20 }, () => upstream.rpc('fn', {}));
    await tick();
    expect(state.calls).toBe(16);
    while (state.releases.length > 0) {
      state.releases.shift()!();
      await tick();
    }
    await Promise.all(results);
    expect(state.maxInFlight).toBe(16);
  });

  it('counts the queued time against the timeout: a call that never gets a slot fails as a timeout does', async () => {
    // The first call holds the only slot past the budget (this fetch does not
    // honour the abort), so the second can only ever wait in the queue.
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return new Promise((resolve) => setTimeout(() => resolve(new Response('[]', { status: 200 })), 300));
    };
    const upstream = createUpstream({ ...opts, fetch, concurrency: 1, timeoutMs: 60 });
    const started = Date.now();
    const first = upstream.rpc('fn_held', {});
    const queued = await upstream.rpc('fn_queued', {}).catch((e: unknown) => e);
    const waited = Date.now() - started;
    expect(queued).toEqual(new UpstreamError('fn_queued', 0));
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited).toBeLessThan(250);
    expect(calls).toBe(1);
    await first;
  });

  it('fails a call held in flight past the budget with status 0', async () => {
    const { fetch, state } = heldFetch();
    const upstream = createUpstream({ ...opts, fetch, concurrency: 1, timeoutMs: 60 });
    await expect(upstream.rpc('fn', {})).rejects.toEqual(new UpstreamError('fn', 0));
    expect(state.inFlight).toBe(0);
  });

  it('frees the slot when a call fails, and a waiter that gave up takes none', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      return new Response('{"message":"boom"}', { status: 500 });
    };
    const upstream = createUpstream({ ...opts, fetch, concurrency: 1 });
    for (let i = 0; i < 5; i++) await expect(upstream.rpc('fn', {})).rejects.toEqual(new UpstreamError('fn', 500));
    expect(calls).toBe(5);

    const gate = new Gate(1);
    await gate.acquire(new AbortController().signal);
    const giving = new AbortController();
    const gaveUp = gate.acquire(giving.signal);
    const patient = gate.acquire(new AbortController().signal);
    giving.abort();
    await expect(gaveUp).rejects.toThrow();
    expect(gate.queued).toBe(1);
    gate.release();
    await patient;
    expect(gate.inUse).toBe(1);
    gate.release();
    expect(gate.inUse).toBe(0);
  });

  it('reports the body length and drops a leading byte-order mark as res.json() did', async () => {
    const fetch: FetchLike = async () => new Response('﻿[{"a":1}]', { status: 200 });
    const upstream = createUpstream({ ...opts, fetch });
    expect(await upstream.rpcSized('fn', {})).toEqual({ rows: [{ a: 1 }], bytes: 12 });
  });
});
