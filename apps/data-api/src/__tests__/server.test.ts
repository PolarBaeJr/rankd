import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyVerifier } from '../auth.js';
import { get, grant, newKey, playerRow, startHarness, type Harness } from './helpers.js';
// Literals, not the constants from auth.ts: the contract says 30 seconds, and a
// test that imported the constant would follow it wherever it was changed to.
const POSITIVE_TTL_MS = 30_000;
const NEGATIVE_TTL_MS = 5_000;
// The roster, results and ratings live 60 seconds; tournaments and the
// schedule 30 (rpc-cache.ts).
const READ_CACHE_TTL_MS = 60_000;
const LIVE_CACHE_TTL_MS = 30_000;

const REF_A = 'a'.repeat(64);
const REF_B = 'b'.repeat(64);

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
  h.players = [playerRow(REF_A), playerRow(REF_B)];
});
afterEach(async () => {
  await h.close();
});

describe('health', () => {
  it('is unauthenticated and reports the version', async () => {
    const res = await get(h, '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '0.1.0' });
    expect(h.calls).toHaveLength(0);
  });
});

describe('/documentations', () => {
  it('serves HTML without a key, with the security headers, and never asks the database', async () => {
    for (const path of ['/documentations', '/documentations/']) {
      const res = await get(h, path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('script-src');
      expect(csp).not.toContain('unsafe-inline');
      const body = await res.text();
      expect(body).toContain('<title>Club Ladder Data API</title>');
      // The one stylesheet, hashed here from what was served, is what the CSP allows.
      const styles = [...body.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
      expect(styles).toHaveLength(1);
      expect(body).not.toMatch(/\sstyle=/);
      expect(body).not.toMatch(/<script/i);
      const hash = createHash('sha256').update(styles[0]!).digest('base64');
      expect(csp).toContain(`style-src 'sha256-${hash}'`);
    }
    expect(h.calls).toHaveLength(0);
    const lines = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ method: 'GET', path: '/documentations', status: 200 });
    expect(lines[0]).not.toHaveProperty('key');
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await get(h, '/documentations', undefined, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await res.text()).toBe('');
    expect(h.calls).toHaveLength(0);
  });

  it('405s any other method', async () => {
    const res = await get(h, '/documentations', newKey(), { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(await res.json()).toEqual({ error: 'method_not_allowed' });
    expect(h.calls).toHaveLength(0);
  });

  it('ignores a key and is not charged to its rate budget', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    for (let i = 0; i < 70; i++) {
      expect((await get(h, '/documentations', key)).status).toBe(200);
    }
    expect(h.calls).toHaveLength(0);
    expect((await get(h, '/v1/players', key)).status).toBe(200);
  });

  // Read from server.ts itself, so a route, scope or error code added there
  // without a line on the page fails here rather than going undocumented.
  it('documents every route, scope and error code the server has', async () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const routes = [...new Set([...source.matchAll(/template: '([^']+)'/g)].map((m) => m[1]!))];
    const errors = [...new Set([...source.matchAll(/error: '(\w+)'/g)].map((m) => m[1]!))];
    const scopes = [...new Set([...source.matchAll(/'([a-z]+(?::[a-z]+)*:read)'/g)].map((m) => m[1]!))];
    expect(routes).toEqual(expect.arrayContaining(['/health', '/documentations', '/v1/players', '/v1/players/:ref', '/v1/matches']));
    expect(errors).toEqual(expect.arrayContaining(['not_found', 'method_not_allowed', 'unauthorized', 'rate_limited', 'forbidden', 'unavailable']));
    expect(scopes).toEqual(expect.arrayContaining(['players:read', 'matches:read']));

    const body = await (await get(h, '/documentations')).text();
    for (const s of [...routes, ...errors, ...scopes]) expect(body, s).toContain(s);
  });

  it('links to the changelog', async () => {
    const body = await (await get(h, '/documentations')).text();
    expect(body).toContain('href="/changelog"');
  });
});

describe('/changelog', () => {
  it('serves HTML without a key, with the security headers, and never asks the database', async () => {
    for (const path of ['/changelog', '/changelog/']) {
      const res = await get(h, path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('script-src');
      expect(csp).not.toContain('unsafe-inline');
      const body = await res.text();
      expect(body).toContain('<title>Club Ladder Data API changelog</title>');
      const styles = [...body.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
      expect(styles).toHaveLength(1);
      expect(body).not.toMatch(/\sstyle=/);
      expect(body).not.toMatch(/<script/i);
      const hash = createHash('sha256').update(styles[0]!).digest('base64');
      expect(csp).toContain(`style-src 'sha256-${hash}'`);
      expect(body).toContain('href="/documentations"');
      expect(body).toContain('href="https://example.com/"');
    }
    expect(h.calls).toHaveLength(0);
    const lines = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ method: 'GET', path: '/changelog', status: 200 });
    expect(lines[0]).not.toHaveProperty('key');
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await get(h, '/changelog', undefined, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await res.text()).toBe('');
    expect(h.calls).toHaveLength(0);
  });

  it('405s any other method', async () => {
    const res = await get(h, '/changelog', newKey(), { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(await res.json()).toEqual({ error: 'method_not_allowed' });
    expect(h.calls).toHaveLength(0);
  });

  it('ignores a key and is not charged to its rate budget', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    for (let i = 0; i < 70; i++) {
      expect((await get(h, '/changelog', key)).status).toBe(200);
    }
    expect(h.calls).toHaveLength(0);
    expect((await get(h, '/v1/players', key)).status).toBe(200);
  });
});

describe('response headers', () => {
  it('sets JSON, no-store and nosniff, and no CORS', async () => {
    const res = await get(h, '/health');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('401 uniformity', () => {
  async function snapshot(res: Response) {
    const headers = [...res.headers.entries()].filter(([k]) => !['date', 'connection', 'keep-alive'].includes(k));
    return { status: res.status, body: await res.text(), headers };
  }

  it('answers missing, malformed, unknown, expired and revoked identically', async () => {
    const unknown = newKey();
    const expired = newKey();
    const revoked = newKey();
    // Expired and revoked keys are zero rows from data_api_verify_key, which is
    // exactly the unknown case: the mock simply holds no row for them.
    const results = [
      await snapshot(await get(h, '/v1/players')),
      await snapshot(await get(h, '/v1/players', 'not-a-key')),
      await snapshot(await get(h, '/v1/players', unknown)),
      await snapshot(await get(h, '/v1/players', expired)),
      await snapshot(await get(h, '/v1/players', revoked)),
    ];
    expect(results[0]!.status).toBe(401);
    expect(JSON.parse(results[0]!.body)).toEqual({ error: 'unauthorized' });
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('never sends a malformed or missing header to the database', async () => {
    await get(h, '/v1/players');
    await get(h, '/v1/players', 'clubld_short');
    await get(h, '/v1/players', undefined, { headers: { Authorization: 'Basic abc' } });
    expect(h.calls).toHaveLength(0);
  });

  it('sends the sha256 hash, never the plaintext key', async () => {
    const key = newKey();
    await get(h, '/v1/players', key);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.fn).toBe('data_api_verify_key');
    expect(call.body.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(call)).not.toContain(key);
  });

  it('authenticates to PostgREST with the anon apikey and the reader JWT', async () => {
    await get(h, '/v1/players', newKey());
    expect(h.calls[0]!.headers.apikey).toBe('anon-key-value');
    expect(h.calls[0]!.headers.Authorization).toBe('Bearer reader-jwt-value');
  });
});

describe('scopes', () => {
  it('403s a key without players:read', async () => {
    const key = newKey();
    grant(h, key, ['matches:read']);
    const res = await get(h, '/v1/players', key);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', detail: 'this key does not carry players:read' });
    const one = await get(h, `/v1/players/${REF_A}`, key);
    expect(one.status).toBe(403);
  });

  it('403s /v1/matches without matches:read, and pages an empty history with it', async () => {
    const reader = newKey();
    grant(h, reader, ['players:read']);
    const denied = await get(h, '/v1/matches', reader);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden', detail: 'this key does not carry matches:read' });

    const matches = newKey();
    grant(h, matches, ['matches:read'], '99999999-2222-3333-4444-555555555555');
    h.rpcs.data_api_matches = () => [];
    const ok = await get(h, '/v1/matches', matches);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      generated_at: '2027-01-15T08:00:00Z',
      count: 0,
      limit: 100,
      offset: 0,
      next_offset: null,
      matches: [],
    });
  });
});

describe('/v1/players', () => {
  it('matches the API.md shape exactly', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    const res = await get(h, '/v1/players', key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['season', 'generated_at', 'count', 'players']);
    expect(body.season).toBeNull();
    expect(body.generated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(body.count).toBe(2);
    const players = body.players as Record<string, unknown>[];
    expect(Object.keys(players[0]!)).toEqual([
      'player_ref',
      'singles_elo',
      'doubles_elo',
      'singles_provisional',
      'doubles_provisional',
      'singles_matches_played',
      'doubles_matches_played',
      'singles_wins',
      'singles_losses',
      'doubles_wins',
      'doubles_losses',
      'updated_at',
    ]);
    expect(players[0]!.updated_at).toBe('2026-09-14T04:11:55Z');
    expect(h.calls.map((c) => c.fn)).toEqual(['data_api_verify_key', 'data_api_players', 'data_api_active_season']);
    expect(h.calls[1]!.body).toEqual({ p_consumer_id: 'aaaaaaaa-0000-0000-0000-000000000001' });
  });

  it('drops any column the database adds beyond the contract', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    h.players = [{ ...playerRow(REF_A), id: 'internal' } as ReturnType<typeof playerRow>];
    const body = (await (await get(h, '/v1/players', key)).json()) as { players: Record<string, unknown>[] };
    expect(body.players[0]).not.toHaveProperty('id');
  });
});

describe('/v1/players/{ref}', () => {
  it('returns one player in the same shape', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    const res = await get(h, `/v1/players/${REF_B}`, key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.player_ref).toBe(REF_B);
    expect(body.updated_at).toBe('2026-09-14T04:11:55Z');
  });

  it('404s an unknown ref', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    const res = await get(h, `/v1/players/${'c'.repeat(64)}`, key);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('404s a malformed ref without asking the database', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    const res = await get(h, '/v1/players/p_8f14e45fceea167a', key);
    expect(res.status).toBe(404);
    expect(h.calls.map((c) => c.fn)).toEqual(['data_api_verify_key']);
  });
});

describe('routes and methods', () => {
  it('404s an unknown route as JSON', async () => {
    const res = await get(h, '/v2/players');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('405s a non-GET on a known route, before auth', async () => {
    const res = await get(h, '/v1/players', undefined, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(await res.json()).toEqual({ error: 'method_not_allowed' });
    const del = await get(h, `/v1/players/${REF_A}`, undefined, { method: 'DELETE' });
    expect(del.status).toBe(405);
  });
});

describe('verification cache', () => {
  it('reuses a positive result, and a revoked key stops working after 30s', async () => {
    const key = newKey();
    const row = grant(h, key, ['players:read']);
    expect((await get(h, '/v1/players', key)).status).toBe(200);

    // Revoked in the database: data_api_verify_key now returns zero rows.
    h.keys.clear();
    h.clock.t += POSITIVE_TTL_MS - 1;
    expect((await get(h, '/v1/players', key)).status).toBe(200);
    expect(h.calls.filter((c) => c.fn === 'data_api_verify_key')).toHaveLength(1);

    h.clock.t += 1;
    expect((await get(h, '/v1/players', key)).status).toBe(401);
    expect(h.calls.filter((c) => c.fn === 'data_api_verify_key')).toHaveLength(2);
    expect(row.key_id).toBeTruthy();
  });

  it('caches a negative result briefly', async () => {
    const key = newKey();
    await get(h, '/v1/players', key);
    await get(h, '/v1/players', key);
    expect(h.calls).toHaveLength(1);

    // Minted a moment later: still refused until the negative entry expires.
    grant(h, key, ['players:read']);
    h.clock.t += NEGATIVE_TTL_MS - 1;
    expect((await get(h, '/v1/players', key)).status).toBe(401);
    h.clock.t += 1;
    expect((await get(h, '/v1/players', key)).status).toBe(200);
  });

  it('does not cache an upstream failure', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    h.failNext = { status: 500 };
    expect((await get(h, '/v1/players', key)).status).toBe(503);
    h.failNext = null;
    expect((await get(h, '/v1/players', key)).status).toBe(200);
  });
});

describe('verification single flight', () => {
  const verifies = () => h.calls.filter((c) => c.fn === 'data_api_verify_key');

  it('sends one key check for many concurrent requests on an uncached key', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    const held = h.hold('data_api_verify_key');
    const pending = Array.from({ length: 10 }, () => get(h, '/v1/players', key).then((r) => r.status));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(verifies()).toHaveLength(1);
    held.release();
    expect(await Promise.all(pending)).toEqual(Array(10).fill(200));
    expect(verifies()).toHaveLength(1);
    // The shared answer filled the cache.
    expect((await get(h, '/v1/players', key)).status).toBe(200);
    expect(verifies()).toHaveLength(1);
  });

  it('shares a failure with the waiting requests and keeps nothing', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    h.failFn = { fn: 'data_api_verify_key', status: 500 };
    const held = h.hold('data_api_verify_key');
    // Release only once all five have joined: a request still on its way when
    // the failure lands would start a second check of its own.
    const joined = vi.spyOn(KeyVerifier.prototype, 'verify');
    const pending = Array.from({ length: 5 }, () => get(h, '/v1/players', key).then((r) => r.status));
    await vi.waitFor(() => expect(joined).toHaveBeenCalledTimes(5));
    joined.mockRestore();
    held.release();
    expect(await Promise.all(pending)).toEqual(Array(5).fill(503));
    expect(verifies()).toHaveLength(1);
    h.failFn = null;
    expect((await get(h, '/v1/players', key)).status).toBe(200);
    expect(verifies()).toHaveLength(2);
  });
});

describe('upstream failure', () => {
  it.each([500, 502, 404, 401])('maps a PostgREST %i to 503 and logs only the status', async (status) => {
    const key = newKey();
    h.failNext = { status };
    const res = await get(h, '/v1/players', key);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    const errorLine = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'upstream_failed');
    expect(errorLine).toEqual({ level: 'error', msg: 'upstream_failed', fn: 'data_api_verify_key', upstream_status: status });
    expect(h.logs.join('\n')).not.toContain('boom');
  });

  it('maps a failed feed read to 503', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    await get(h, '/v1/players', key);
    // Past the read cache; the key is checked again and passes.
    h.clock.t += READ_CACHE_TTL_MS + 1;
    h.failFn = { fn: 'data_api_players', status: 503 };
    expect((await get(h, '/v1/players', key)).status).toBe(503);
    expect(h.logs.some((l) => l.includes('"fn":"data_api_players"'))).toBe(true);
  });
});

describe('read cache', () => {
  const reads = () => h.calls.filter((c) => c.fn === 'data_api_players');

  it('answers a repeat read from the cache for 60 seconds, then asks again', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    expect((await get(h, '/v1/players', key)).status).toBe(200);
    h.clock.t += READ_CACHE_TTL_MS - 1;
    expect((await get(h, '/v1/players', key)).status).toBe(200);
    expect(reads()).toHaveLength(1);
    h.clock.t += 2;
    expect((await get(h, '/v1/players', key)).status).toBe(200);
    expect(reads()).toHaveLength(2);
  });

  it('shares one database call between concurrent identical reads', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    await get(h, '/v1/players', key);
    h.clock.t += READ_CACHE_TTL_MS + 1;
    const statuses = await Promise.all(Array.from({ length: 10 }, () => get(h, '/v1/players', key).then((r) => r.status)));
    expect(statuses).toEqual(Array(10).fill(200));
    expect(reads()).toHaveLength(2);
  });

  it('never serves one consumer the answer computed for another', async () => {
    const first = newKey();
    const second = newKey();
    grant(h, first, ['players:read']);
    grant(h, second, ['players:read'], '99999999-2222-3333-4444-555555555555').consumer_id =
      'bbbbbbbb-0000-0000-0000-000000000002';
    await get(h, '/v1/players', first);
    await get(h, '/v1/players', second);
    expect(reads().map((c) => c.body.p_consumer_id)).toEqual([
      'aaaaaaaa-0000-0000-0000-000000000001',
      'bbbbbbbb-0000-0000-0000-000000000002',
    ]);
  });

  it('does not keep a failure', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    await get(h, '/v1/players', key);
    h.clock.t += READ_CACHE_TTL_MS + 1;
    h.failFn = { fn: 'data_api_players', status: 500 };
    expect((await get(h, '/v1/players', key)).status).toBe(503);
    h.failFn = null;
    expect((await get(h, '/v1/players', key)).status).toBe(200);
    expect(reads()).toHaveLength(3);
  });

  it('keeps tournaments and the schedule for 30 seconds', async () => {
    const key = newKey();
    grant(h, key, ['tournaments:read']);
    h.rpcs.data_api_tournaments = () => [];
    const tournamentReads = () => h.calls.filter((c) => c.fn === 'data_api_tournaments');
    expect((await get(h, '/v1/tournaments', key)).status).toBe(200);
    h.clock.t += LIVE_CACHE_TTL_MS - 1;
    await get(h, '/v1/tournaments', key);
    expect(tournamentReads()).toHaveLength(1);
    h.clock.t += 1;
    await get(h, '/v1/tournaments', key);
    expect(tournamentReads()).toHaveLength(2);
  });

  it('keys on the parameters after normalising them', async () => {
    const key = newKey();
    grant(h, key, ['matches:read']);
    h.rpcs.data_api_matches = () => [];
    const season = 'abcdef01-2345-4678-89ab-cdef01234567';
    const matchReads = () => h.calls.filter((c) => c.fn === 'data_api_matches');
    await get(h, `/v1/matches?season=${season}&since=2026-09-01T00:00Z`, key);
    // The same request spelled differently: an upper-case uuid, seconds and
    // milliseconds on the timestamp, the parameters in another order.
    await get(h, `/v1/matches?since=2026-09-01T00:00:00.000Z&season=${season.toUpperCase()}`, key);
    expect(matchReads()).toHaveLength(1);
    await get(h, `/v1/matches?season=${season}&since=2026-09-01T00:00Z&limit=5`, key);
    expect(matchReads()).toHaveLength(2);
  });

  it('drops the consumer\'s entrant and signup reads after a registration, and nothing after a prediction', async () => {
    const key = newKey();
    grant(h, key, ['schedule:read', 'players:read', 'registrations:write', 'predictions:write']);
    const other = newKey();
    grant(h, other, ['schedule:read'], '99999999-2222-3333-4444-555555555555').consumer_id =
      'bbbbbbbb-0000-0000-0000-000000000002';
    h.rpcs.data_api_club_events = () => [];
    h.rpcs.data_api_sessions = () => [];
    h.rpcs.data_api_import_registration = () => [{ item: 1, event_id: null, status: 'entered', reason: null, replayed: false }];
    h.rpcs.data_api_write_predictions = () => [{ item: 1, status: 'created' }];
    const count = (fn: string) => h.calls.filter((c) => c.fn === fn).length;
    const window = '?from=2027-01-15T00:00:00Z';
    for (const k of [key, other]) {
      await get(h, `/v1/events${window}`, k);
      await get(h, `/v1/sessions${window}`, k);
    }
    await get(h, '/v1/players', key);
    expect([count('data_api_club_events'), count('data_api_sessions'), count('data_api_players')]).toEqual([2, 2, 1]);

    const imported = await get(h, '/v1/registrations', key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form_id: 'form-1', response_id: 'response-1', email: 'guest@example.org', name: 'Guest', entries: [] }),
    });
    expect(imported.status).toBe(200);
    for (const k of [key, other]) {
      await get(h, `/v1/events${window}`, k);
      await get(h, `/v1/sessions${window}`, k);
    }
    // Only this consumer's club events were asked again.
    expect([count('data_api_club_events'), count('data_api_sessions')]).toEqual([3, 2]);

    const predicted = await get(h, '/v1/predictions', key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        predictions: [
          { format: 'singles', side_a: [REF_A], side_b: [REF_B], probability: 0.5, model: 'm', made_at: '2026-09-15T08:00:00Z' },
        ],
      }),
    });
    expect(predicted.status).toBe(200);
    await get(h, '/v1/players', key);
    expect(count('data_api_players')).toBe(1);
  });

  it('drops them after a failed registration too, which may still have committed', async () => {
    const key = newKey();
    grant(h, key, ['schedule:read', 'registrations:write']);
    h.rpcs.data_api_club_events = () => [];
    h.failFn = { fn: 'data_api_import_registration', status: 500 };
    const count = (fn: string) => h.calls.filter((c) => c.fn === fn).length;
    await get(h, '/v1/events?from=2027-01-15T00:00:00Z', key);
    const imported = await get(h, '/v1/registrations', key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form_id: 'form-1', response_id: 'response-1', email: 'guest@example.org', name: 'Guest', entries: [] }),
    });
    expect(imported.status).toBe(503);
    await get(h, '/v1/events?from=2027-01-15T00:00:00Z', key);
    expect(count('data_api_club_events')).toBe(2);
  });

  it('shares one call between concurrent identical misses', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    await get(h, '/v1/seasons', key).catch(() => undefined);
    const held = h.hold('data_api_players');
    const pending = Array.from({ length: 8 }, () => get(h, '/v1/players', key).then((r) => r.status));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads()).toHaveLength(1);
    held.release();
    expect(await Promise.all(pending)).toEqual(Array(8).fill(200));
    expect(reads()).toHaveLength(1);
  });

  it('does not cache key verification beyond its own contract', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    await get(h, '/v1/players', key);
    h.keys.clear();
    h.clock.t += POSITIVE_TTL_MS + 1;
    expect((await get(h, '/v1/players', key)).status).toBe(401);
  });
});

describe('rate limits', () => {
  it('429s a key past 60 requests a minute, with Retry-After', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    for (let i = 0; i < 60; i++) {
      expect((await get(h, '/v1/players', key)).status).toBe(200);
    }
    const limited = await get(h, '/v1/players', key);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    h.clock.t += 1000;
    expect((await get(h, '/v1/players', key)).status).toBe(200);
  });

  it('429s an address past 30 failed lookups, without blocking a cached valid key', async () => {
    const good = newKey();
    grant(h, good, ['players:read']);
    expect((await get(h, '/v1/players', good)).status).toBe(200);

    for (let i = 0; i < 30; i++) {
      expect((await get(h, '/v1/players', newKey())).status).toBe(401);
    }
    const lookups = h.calls.filter((c) => c.fn === 'data_api_verify_key').length;
    const limited = await get(h, '/v1/players', newKey());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(h.calls.filter((c) => c.fn === 'data_api_verify_key').length).toBe(lookups);

    expect((await get(h, '/v1/players', good)).status).toBe(200);
  });
});

describe('logs', () => {
  it('redacts the player ref, drops the query, and never logs a key', async () => {
    const key = newKey();
    grant(h, key, ['players:read']);
    await get(h, `/v1/players/${REF_A}?key=${key}`, key);
    await get(h, `/nope/${key}`);
    const all = h.logs.join('\n');
    expect(all).not.toContain(REF_A);
    expect(all).not.toContain(key);
    expect(all).not.toContain(key.slice(7));
    const lines = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ method: 'GET', path: '/v1/players/:ref', status: 200, key: '11111111' });
    expect(typeof lines[0]!.ms).toBe('number');
    expect(lines[1]).toMatchObject({ method: 'GET', path: '(unmatched)', status: 404 });
    expect(lines[1]).not.toHaveProperty('key');
  });
});
