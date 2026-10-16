import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createHandler } from '../server.js';
import { createUpstream, type FetchLike } from '../upstream.js';
import { hashKey } from '../key.js';

export function newKey(): string {
  return `clubld_${randomBytes(32).toString('base64url')}`;
}

export interface KeyRow {
  consumer_id: string;
  key_id: string;
  scopes: string[];
}

export function playerRow(ref: string) {
  return {
    player_ref: ref,
    singles_elo: 1180,
    doubles_elo: 1042,
    singles_provisional: false,
    doubles_provisional: true,
    singles_matches_played: 0,
    doubles_matches_played: 0,
    singles_wins: 0,
    singles_losses: 0,
    doubles_wins: 0,
    doubles_losses: 0,
    updated_at: '2026-09-14T04:11:55.123456+00:00',
  };
}

export interface Harness {
  base: string;
  clock: { t: number };
  logs: string[];
  calls: { fn: string; body: Record<string, unknown>; headers: Record<string, string> }[];
  keys: Map<string, KeyRow>;
  players: ReturnType<typeof playerRow>[];
  failNext: { status: number } | null;
  /**
   * Answers for any RPC beyond the three from 00241, keyed by function name.
   * A function with no entry answers 404 PGRST202, as PostgREST does.
   */
  rpcs: Record<string, (body: Record<string, unknown>) => unknown>;
  /** Makes only this function fail, leaving the others answering. */
  failFn: { fn: string; status: number } | null;
  /** Holds every call to `fn` until release() (the call is recorded first). */
  hold(fn: string): { release(): void };
  close(): Promise<void>;
}

/**
 * A real node:http server on an ephemeral port, driving the real handler and
 * the real upstream client, with only `fetch` to PostgREST mocked. The mock
 * reproduces the three RPCs from 00241 over in-memory rows; tests answer the
 * later ones through `rpcs`.
 */
export async function startHarness(): Promise<Harness> {
  const h = {
    clock: { t: 1_800_000_000_000 },
    logs: [] as string[],
    calls: [] as Harness['calls'],
    keys: new Map<string, KeyRow>(),
    players: [] as ReturnType<typeof playerRow>[],
    failNext: null as { status: number } | null,
    rpcs: { data_api_active_season: () => [] } as Harness['rpcs'],
    failFn: null as Harness['failFn'],
    holds: new Map<string, Promise<void>>(),
    hold(fn: string) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.holds.set(fn, held);
      return {
        release: () => {
          this.holds.delete(fn);
          release();
        },
      };
    },
  };

  const mockFetch: FetchLike = async (input, init) => {
    const fn = input.split('/rest/v1/rpc/')[1] ?? '';
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    h.calls.push({ fn, body, headers: init.headers as Record<string, string> });
    const held = h.holds.get(fn);
    if (held) await held;
    if (h.failNext) {
      const { status } = h.failNext;
      return new Response(JSON.stringify({ message: 'boom', details: body }), { status });
    }
    if (h.failFn?.fn === fn) {
      return new Response(JSON.stringify({ message: 'boom' }), { status: h.failFn.status });
    }
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (fn === 'data_api_verify_key') {
      const row = h.keys.get(body.p_key_hash as string);
      return json(row ? [row] : []);
    }
    if (fn === 'data_api_players') return json(h.players);
    if (fn === 'data_api_player_by_ref') return json(h.players.filter((p) => p.player_ref === body.p_player_ref));
    const answer = h.rpcs[fn];
    if (answer) return json(answer(body));
    return new Response('{"code":"PGRST202"}', { status: 404 });
  };

  const upstream = createUpstream({
    supabaseUrl: 'http://kong.test',
    anonKey: 'anon-key-value',
    dbJwt: 'reader-jwt-value',
    fetch: mockFetch,
  });
  const handler = createHandler({
    upstream,
    version: '0.1.0',
    now: () => h.clock.t,
    log: (line) => h.logs.push(line),
  });
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return Object.assign(h, {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

export function grant(h: Harness, key: string, scopes: string[], keyId = '11111111-2222-3333-4444-555555555555'): KeyRow {
  const row = { consumer_id: 'aaaaaaaa-0000-0000-0000-000000000001', key_id: keyId, scopes };
  h.keys.set(hashKey(key), row);
  return row;
}

export function get(h: Harness, path: string, key?: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (key !== undefined) headers.Authorization = `Bearer ${key}`;
  return fetch(h.base + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
}

/** A JSON body to /v1/predictions, POST unless told otherwise. */
export function writePredictions(
  h: Harness,
  key: string | undefined,
  body: unknown,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return get(h, '/v1/predictions', key, {
    method: init.method ?? 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}
