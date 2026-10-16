import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashKey } from '../key.js';
import { parseRegistration } from '../registrations.js';
import { BadBody } from '../predictions.js';
import { get, grant, newKey, startHarness, type Harness } from './helpers.js';

const EVENT_A = 'aaaaaaaa-1111-4222-8333-444444444444';
const EVENT_B = 'bbbbbbbb-1111-4222-8333-444444444444';

let h: Harness;
let key: string;

function response(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    form_id: '1FAIpQLSexampleForm',
    response_id: 'ACYDBNj-example',
    submitted_at: '2026-10-08T10:00:00Z',
    email: 'Guest.Person@Example.org ',
    name: '  Guest   Person ',
    entries: [{ event_id: EVENT_A, partner_name: 'Second Guest' }],
    ...over,
  };
}

function post(body: unknown, withKey: string | null = key, headers: Record<string, string> = {}) {
  return get(h, '/v1/registrations', withKey ?? undefined, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const importCalls = () => h.calls.filter((c) => c.fn === 'data_api_import_registration');

beforeEach(async () => {
  h = await startHarness();
  key = newKey();
  grant(h, key, ['registrations:write']);
  h.rpcs.data_api_import_registration = () => [
    { item: 1, event_id: EVENT_A, status: 'entered', reason: null, replayed: false },
  ];
});
afterEach(async () => {
  await h.close();
});

describe('POST /v1/registrations: before the body', () => {
  it('401s without a key and never calls the database', async () => {
    const res = await post(response(), null);
    expect(res.status).toBe(401);
    expect(importCalls()).toHaveLength(0);
  });

  it('403s a key without registrations:write', async () => {
    const other = newKey();
    grant(h, other, ['predictions:write', 'players:read'], '77777777-2222-3333-4444-555555555555');
    const res = await post(response(), other);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', detail: 'this key does not carry registrations:write' });
    expect(importCalls()).toHaveLength(0);
  });

  it('405s a GET or a DELETE, naming POST', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await get(h, '/v1/registrations', key, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('415s a body that is not JSON', async () => {
    const res = await post('form_id=x', key, { 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(415);
  });

  it('400s a malformed body naming the field, without the database', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [response({ email: 'not an email' }), 'email'],
      [response({ name: '' }), 'name'],
      [response({ form_id: 'has spaces in it' }), 'form_id'],
      [response({ entries: [{ event_id: 'nope' }] }), 'entries[0].event_id'],
      [response({ entries: [{ event_id: EVENT_A, partner_email: 'x' }] }), 'entries[0].partner_email'],
      [response({ entries: [{ event_id: EVENT_A, extra: 1 }] }), 'entries[0].extra'],
      [response({ surprise: true }), 'surprise'],
      [response({ submitted_at: 'yesterday' }), 'submitted_at'],
    ];
    for (const [body, field] of cases) {
      const res = await post(body);
      expect(res.status, field).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request', field });
    }
    expect(importCalls()).toHaveLength(0);
  });
});

describe('POST /v1/registrations: the import', () => {
  it('sends the normalised response and the key hash, and answers per entry', async () => {
    const res = await post(response());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      replayed: false,
      results: [{ index: 1, event_id: EVENT_A, status: 'entered', reason: null }],
      entered: 1,
      pending: 0,
      refused: 0,
    });
    expect(importCalls()).toHaveLength(1);
    const args = importCalls()[0]!.body;
    expect(args.p_key_hash).toBe(hashKey(key));
    expect(args.p_payload).toEqual({
      form_id: '1FAIpQLSexampleForm',
      response_id: 'ACYDBNj-example',
      submitted_at: '2026-10-08T10:00:00Z',
      email: 'guest.person@example.org',
      name: 'Guest Person',
      entries: [{ event_id: EVENT_A, partner_name: 'Second Guest' }],
    });
  });

  it('passes pending and event refusals through, and drops a reason on anything but a refusal', async () => {
    h.rpcs.data_api_import_registration = () => [
      { item: 1, event_id: EVENT_A, status: 'pending', reason: 'should not leak', replayed: false },
      { item: 2, event_id: EVENT_B, status: 'refused', reason: 'event_full', replayed: false },
    ];
    const res = await post(response({ entries: [{ event_id: EVENT_A }, { event_id: EVENT_B }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([
      { index: 1, event_id: EVENT_A, status: 'pending', reason: null },
      { index: 2, event_id: EVENT_B, status: 'refused', reason: 'event_full' },
    ]);
    expect([body.entered, body.pending, body.refused]).toEqual([0, 1, 1]);
  });

  it('says when the answer is a replay', async () => {
    h.rpcs.data_api_import_registration = () => [
      { item: 1, event_id: EVENT_A, status: 'entered', reason: null, replayed: true },
    ];
    const body = await (await post(response())).json();
    expect(body.replayed).toBe(true);
  });

  it('401s when the database no longer accepts the key', async () => {
    h.rpcs.data_api_import_registration = () => [
      { item: 0, event_id: null, status: 'refused', reason: 'key', replayed: false },
    ];
    expect((await post(response())).status).toBe(401);
  });

  it('404s a form with no active binding', async () => {
    h.rpcs.data_api_import_registration = () => [
      { item: 0, event_id: null, status: 'refused', reason: 'not_found', replayed: false },
    ];
    const res = await post(response());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
  });

  it('never logs the body or an email', async () => {
    await post(response());
    const logged = h.logs.join('\n');
    expect(logged).not.toContain('example.org');
    expect(logged).not.toContain('Guest');
    expect(logged).toContain('/v1/registrations');
  });

  it('503s when the database fails, without echoing anything', async () => {
    h.failFn = { fn: 'data_api_import_registration', status: 500 };
    const res = await post(response());
    expect(res.status).toBe(503);
    expect(h.logs.join('\n')).not.toContain('example.org');
  });
});

describe('parseRegistration', () => {
  it('accepts a club event response with no entries', () => {
    const { entries, ...rest } = response();
    void entries;
    expect(parseRegistration(rest).entries).toEqual([]);
  });

  it('caps the entries', () => {
    const many = Array.from({ length: 21 }, () => ({ event_id: EVENT_A }));
    expect(() => parseRegistration(response({ entries: many }))).toThrow(BadBody);
  });
});
