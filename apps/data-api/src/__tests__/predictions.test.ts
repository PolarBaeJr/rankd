import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashKey } from '../key.js';
import { MAX_BODY_BYTES } from '../predictions.js';
import { get, grant, newKey, startHarness, writePredictions, type Harness } from './helpers.js';

const REF_A = 'a'.repeat(64);
const REF_B = 'b'.repeat(64);
const REF_C = 'c'.repeat(64);
const REF_D = 'd'.repeat(64);

let h: Harness;
let key: string;

function prediction(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'singles',
    side_a: [REF_A],
    side_b: [REF_B],
    probability: 0.64,
    model: 'elo-v3',
    made_at: '2027-01-15T08:00:00Z',
    ...over,
  };
}

const rpcCalls = () => h.calls.filter((c) => c.fn !== 'data_api_verify_key');

beforeEach(async () => {
  h = await startHarness();
  // 2027-01-15T08:00:00Z, so the made_at above is now.
  h.clock.t = Date.parse('2027-01-15T08:00:00Z');
  key = newKey();
  grant(h, key, ['predictions:write']);
  h.rpcs.data_api_write_predictions = (body) =>
    (body.p_predictions as unknown[]).map((_, i) => ({ item: i, status: 'created', reason: null }));
  h.rpcs.data_api_delete_predictions = (body) =>
    (body.p_matchups as unknown[]).map((_, i) => ({ item: i, status: 'deleted', reason: null }));
});
afterEach(async () => {
  await h.close();
});

describe('POST /v1/predictions: before the body', () => {
  it('401s without a key', async () => {
    const res = await writePredictions(h, undefined, { predictions: [prediction()] });
    expect(res.status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it('403s a key without predictions:write and never calls the write', async () => {
    const reader = newKey();
    grant(h, reader, ['players:read', 'matches:read'], '77777777-2222-3333-4444-555555555555');
    const res = await writePredictions(h, reader, { predictions: [prediction()] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', detail: 'this key does not carry predictions:write' });
    expect(rpcCalls()).toHaveLength(0);
  });

  it('405s a GET, before auth, naming the two methods', async () => {
    const res = await get(h, '/v1/predictions', key);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, DELETE');
    expect(h.calls).toHaveLength(0);
  });

  it('405s a write method on a read route, naming GET', async () => {
    const res = await get(h, '/v1/players', key, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('415s a body that is not declared JSON', async () => {
    const res = await writePredictions(h, key, { predictions: [prediction()] }, { headers: { 'Content-Type': 'text/plain' } });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported_media_type' });
    expect(rpcCalls()).toHaveLength(0);
  });

  it('accepts a charset on the content type', async () => {
    const res = await writePredictions(h, key, { predictions: [prediction()] }, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    expect(res.status).toBe(200);
  });

  it('413s a body over the cap', async () => {
    const res = await writePredictions(h, key, JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(rpcCalls()).toHaveLength(0);
  });

  it('400s a body that is not JSON', async () => {
    const res = await writePredictions(h, key, '{"predictions": [');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', field: 'body' });
  });
});

describe('POST /v1/predictions: the shape', () => {
  const cases: [string, unknown, string][] = [
    ['a missing field', { predictions: [{ ...prediction(), model: undefined }] }, 'predictions[0].model'],
    ['an extra field', { predictions: [prediction({ confidence: 0.9 })] }, 'predictions[0].confidence'],
    ['an extra top-level key', { predictions: [prediction()], dry_run: true }, 'dry_run'],
    ['an empty batch', { predictions: [] }, 'predictions'],
    ['a batch over 100', { predictions: Array.from({ length: 101 }, () => prediction()) }, 'predictions'],
    ['an unknown format', { predictions: [prediction({ format: 'mixed' })] }, 'predictions[0].format'],
    ['singles with two refs a side', { predictions: [prediction({ side_a: [REF_A, REF_C] })] }, 'predictions[0].side_a'],
    ['doubles with one ref a side', { predictions: [prediction({ format: 'doubles' })] }, 'predictions[0].side_a'],
    ['a malformed ref', { predictions: [prediction({ side_b: ['B'.repeat(64)] })] }, 'predictions[0].side_b'],
    ['the same ref on both sides', { predictions: [prediction({ side_b: [REF_A] })] }, 'predictions[0].side_b'],
    ['a probability over 1', { predictions: [prediction({ probability: 1.2 })] }, 'predictions[0].probability'],
    ['a probability as a string', { predictions: [prediction({ probability: '0.5' })] }, 'predictions[0].probability'],
    ['a model with a newline', { predictions: [prediction({ model: 'elo\nv3' })] }, 'predictions[0].model'],
    ['a made_at with an offset', { predictions: [prediction({ made_at: '2027-01-15T08:00:00+00:00' })] }, 'predictions[0].made_at'],
    ['a made_at in the future', { predictions: [prediction({ made_at: '2027-01-15T09:00:00Z' })] }, 'predictions[0].made_at'],
    ['a bare item with a bad field', prediction({ probability: -0.1 }), 'probability'],
  ];

  it.each(cases)('400s %s, naming the field, without asking the database', async (_label, body, field) => {
    const res = await writePredictions(h, key, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', field });
    expect(rpcCalls()).toHaveLength(0);
  });
});

describe('POST /v1/predictions: the write', () => {
  it('sends the key hash and the items, and answers 200 with the counts', async () => {
    const doubles = prediction({ format: 'doubles', side_a: [REF_A, REF_B], side_b: [REF_C, REF_D] });
    const res = await writePredictions(h, key, { predictions: [prediction(), doubles] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { index: 0, status: 'created' },
        { index: 1, status: 'created' },
      ],
      created: 2,
      replaced: 0,
      refused: 0,
    });
    const call = rpcCalls()[0]!;
    expect(call.fn).toBe('data_api_write_predictions');
    expect(call.body).toEqual({ p_key_hash: hashKey(key), p_predictions: [prediction(), doubles] });
  });

  it('takes one bare prediction as a batch of one', async () => {
    const res = await writePredictions(h, key, prediction());
    expect(res.status).toBe(200);
    expect(rpcCalls()[0]!.body.p_predictions).toEqual([prediction()]);
  });

  it('never caches a write: two identical posts are two calls', async () => {
    await writePredictions(h, key, { predictions: [prediction()] });
    await writePredictions(h, key, { predictions: [prediction()] });
    expect(rpcCalls().map((c) => c.fn)).toEqual(['data_api_write_predictions', 'data_api_write_predictions']);
  });

  it('422s when any item is refused, with the same body', async () => {
    h.rpcs.data_api_write_predictions = () => [
      { item: 0, status: 'replaced', reason: null },
      { item: 1, status: 'refused', reason: 'player' },
    ];
    const res = await writePredictions(h, key, { predictions: [prediction(), prediction({ side_b: [REF_C] })] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      results: [
        { index: 0, status: 'replaced' },
        { index: 1, status: 'refused', reason: 'player' },
      ],
      created: 0,
      replaced: 1,
      refused: 1,
    });
  });

  it('401s when the database no longer accepts the key', async () => {
    h.rpcs.data_api_write_predictions = () => [{ item: 0, status: 'refused', reason: 'key' }];
    const res = await writePredictions(h, key, { predictions: [prediction()] });
    expect(res.status).toBe(401);
  });

  it('503s an upstream failure', async () => {
    h.failFn = { fn: 'data_api_write_predictions', status: 500 };
    const res = await writePredictions(h, key, { predictions: [prediction()] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('charges a whole batch to the rate budget once', async () => {
    for (let i = 0; i < 60; i++) {
      const res = await writePredictions(h, key, { predictions: Array.from({ length: 100 }, () => prediction()) });
      expect(res.status).toBe(200);
    }
    expect((await writePredictions(h, key, { predictions: [prediction()] })).status).toBe(429);
  });
});

describe('DELETE /v1/predictions', () => {
  it('deletes by matchup and reports each item', async () => {
    h.rpcs.data_api_delete_predictions = () => [
      { item: 0, status: 'deleted', reason: null },
      { item: 1, status: 'not_found', reason: null },
    ];
    const matchups = [
      { format: 'singles', side_a: [REF_B], side_b: [REF_A] },
      { format: 'doubles', side_a: [REF_A, REF_B], side_b: [REF_C, REF_D] },
    ];
    const res = await writePredictions(h, key, { matchups }, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { index: 0, status: 'deleted' },
        { index: 1, status: 'not_found' },
      ],
      deleted: 1,
      not_found: 1,
      refused: 0,
    });
    expect(rpcCalls()[0]).toMatchObject({
      fn: 'data_api_delete_predictions',
      body: { p_key_hash: hashKey(key), p_matchups: matchups },
    });
  });

  it('400s a matchup carrying a probability', async () => {
    const res = await writePredictions(h, key, { matchups: [prediction()] }, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', field: 'matchups[0].probability' });
  });

  it('403s without the scope', async () => {
    const reader = newKey();
    grant(h, reader, ['players:read'], '77777777-2222-3333-4444-555555555555');
    const res = await writePredictions(h, reader, { matchups: [] }, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});

describe('logs', () => {
  it('log the template, never the body or a ref', async () => {
    await writePredictions(h, key, { predictions: [prediction()] });
    await writePredictions(h, key, { predictions: [prediction({ probability: 2 })] });
    const all = h.logs.join('\n');
    expect(all).toContain('"path":"/v1/predictions"');
    expect(all).not.toContain(REF_A);
    expect(all).not.toContain('elo-v3');
    expect(all).not.toContain(key);
  });
});
