// The request fixtures for the parity check (scripts/parity.mjs).
//
// A case is one request (or `steps`, several in order on one key and one
// client address):
//   target, method, key (true = the case's own key, null = none, or a string),
//   authorization (a raw header value), headers ([[name, value]]), body (a
//   value sent as JSON, a string or Buffer sent as is, or a function of the
//   case context evaluated at send time), contentType (null = no header),
//   chunked, raw (the whole request, latin-1), upstream (per-function
//   overrides for the fake PostgREST: { status, raw } or { rows }),
//   scopes (what the key carries; null = an unknown key), normalise (extra
//   time-valued fields to blank), accept (a documented difference, see
//   README.md "Accepted differences").
// A `burst` case sends its steps back to back, compares the log lines and
// upstream calls once for the whole run, and `expect` must hold for the
// TypeScript statuses, so a rate-limit case cannot pass without the limiter
// having fired.
// A step may name `reads`, the functions it must have called upstream beyond
// the key check ([] for an answer from the read cache).
// A `concurrent` case runs its `warm` steps, holds the `hold` functions in the
// fake, sends its `requests` together (each `at` ms in), releases the holds at
// `release` ms (or once all have answered), and `expect` must hold on BOTH
// services: statuses, bodies, per-request time, calls per function, the most
// calls the fake saw in flight at once. Each service runs with
// DATA_API_UPSTREAM_CONCURRENCY=PARITY_UPSTREAM_CONCURRENCY.

/** The cap both services run with in the parity check, small enough to fill. */
export const PARITY_UPSTREAM_CONCURRENCY = 2;

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT, MATCH_REF, REF_A, REF_B, REF_C, REF_D, SEASON, TOURNAMENT, matchRow, playerRow } from './parity-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- accepted differences ----

const statusOf = (out) => Number(out.status.split(' ')[1]);
const only = (diff, allowed) => diff.every((d) => allowed.includes(d));

const ACCEPT = {
  // Node answers `Expect: 100-continue` with an interim 100 before it runs the
  // handler; hyper sends one only when the handler starts reading the body,
  // so a request refused before its body (401, 415, ...) gets none.
  expectContinue: {
    id: 'expect-continue',
    check: (ts, rs, diff) => only(diff, ['interim']) && ts.interim.includes(' 100 ') && rs.interim === '',
  },
  // JSON.parse keeps a lone UTF-16 surrogate; a Rust string cannot hold one,
  // so it becomes U+FFFD. It only shows where free text is echoed: a field
  // name in a 400, or a name forwarded to the import function.
  loneSurrogate: {
    id: 'lone-surrogate',
    check: (ts, rs, diff) => {
      if (!only(diff, ['headers', 'body', 'calls'])) return false;
      const fix = (s) => s.replace(/\\ud[89a-f][0-9a-f]{2}/g, '�');
      const lengthless = (h) => h.replace(/^content-length: \d+$/m, '');
      return fix(ts.body) === rs.body && fix(ts.calls) === rs.calls && lengthless(ts.headers) === lengthless(rs.headers);
    },
  },
  // A shaped value where the TypeScript reads a JavaScript built-in: a row
  // that is a string or an array has an `at` method, which JSON.stringify
  // drops, and V8's Date.parse reads "1" as 2001-01-01. PostgREST answers
  // rows as objects and timestamps in ISO form, so neither reaches a client.
  jsBuiltin: (rustText, typescriptText) => ({
    id: 'js-built-in-in-a-shaped-row',
    check: (ts, rs, diff) => {
      const lengthless = (h) => h.replace(/^content-length: \d+$/m, '');
      return (
        only(diff, ['headers', 'body']) &&
        lengthless(ts.headers) === lengthless(rs.headers) &&
        rs.body.includes(rustText) &&
        rs.body.replace(rustText, typescriptText) === ts.body
      );
    },
  }),
  // Requests no client library sends, refused differently by the two HTTP
  // parsers. `want` is the [typescript, rust] status pair, 0 for no answer.
  parser: (id, want) => ({
    id,
    check: (ts, rs) => {
      const got = [ts, rs].map((o) => (o.status.startsWith('HTTP/') ? statusOf(o) : 0));
      return got[0] === want[0] && got[1] === want[1];
    },
  }),
};

// ---- the routes ----

const READS = [
  ['players', '/v1/players', 'players:read', 'data_api_players'],
  ['player', `/v1/players/${REF_A}`, 'players:read', 'data_api_player_by_ref'],
  ['player_matches', `/v1/players/${REF_A}/matches`, 'matches:read', 'data_api_matches'],
  ['player_vs', `/v1/players/${REF_A}/vs/${REF_B}`, 'matches:read', 'data_api_head_to_head'],
  ['player_seasons', `/v1/players/${REF_A}/seasons`, 'matches:read', 'data_api_player_seasons'],
  ['player_ratings', `/v1/players/${REF_A}/ratings`, 'ratings:history:read', 'data_api_rating_history'],
  ['matches', '/v1/matches', 'matches:read', 'data_api_matches'],
  ['match', `/v1/matches/${MATCH_REF}`, 'matches:read', 'data_api_match_by_ref'],
  ['seasons', '/v1/seasons', 'seasons:read', 'data_api_seasons'],
  ['season', `/v1/seasons/${SEASON}`, 'seasons:read', 'data_api_seasons'],
  ['season_standings', `/v1/seasons/${SEASON}/standings`, 'seasons:read', 'data_api_season_standings'],
  ['tournaments', '/v1/tournaments', 'tournaments:read', 'data_api_tournaments'],
  ['tournament', `/v1/tournaments/${TOURNAMENT}`, 'tournaments:read', 'data_api_tournaments'],
  ['tournament_event', `/v1/tournaments/${TOURNAMENT}/events/${EVENT}`, 'tournaments:read', 'data_api_tournament_draw_v2'],
  ['sessions', '/v1/sessions?from=2027-01-15T00:00:00Z', 'schedule:read', 'data_api_sessions'],
  ['events', '/v1/events?from=2027-01-15T00:00:00Z', 'schedule:read', 'data_api_club_events'],
];

// The schedule routes default their window to the server's clock.
const SCHEDULE_TIMES = ['p_from', 'p_to', 'from', 'to'];

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

// ---- predictions and registrations ----

/** An ISO `made_at` offset from the server clock, read at send time. */
const madeAt = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function prediction(over = {}) {
  const base = {
    format: 'singles',
    side_a: [REF_A],
    side_b: [REF_B],
    probability: 0.64,
    model: 'elo-v3',
    made_at: '2026-09-15T08:00:00Z',
  };
  const out = { ...base, ...over };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete out[k];
  return out;
}

const EVENT_A = 'aaaaaaaa-1111-4222-8333-444444444444';
const EVENT_B = 'bbbbbbbb-1111-4222-8333-444444444444';

function registration(over = {}) {
  const out = {
    form_id: '1FAIpQLSexampleForm',
    response_id: 'ACYDBNj-example',
    submitted_at: '2026-10-08T10:00:00Z',
    email: 'Guest.Person@Example.org ',
    name: '  Guest   Person ',
    entries: [{ event_id: EVENT_A, partner_name: 'Second Guest' }],
    ...over,
  };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete out[k];
  return out;
}

// ---- the cases ----

export function buildCases() {
  const cases = [];
  const add = (name, kase) => cases.push({ name, ...kase });

  // Health, the two pages, and the route x method matrix.
  for (const target of ['/health', '/health/', '/health?x=1', '/documentations', '/documentations/', '/documentations?x=1', '/changelog', '/changelog/', '/changelog?a=b']) {
    for (const method of METHODS) add(`${method} ${target}`, { method, target, key: true });
  }
  for (const [name, target] of READS) {
    for (const method of METHODS) add(`${method} ${name}`, { method, target, key: true, normalise: SCHEDULE_TIMES });
  }
  for (const target of ['/v1/predictions', '/v1/registrations']) {
    for (const method of METHODS) add(`${method} ${target} (no body)`, { method, target, key: true });
  }
  for (const target of ['/', '/v1', '/v1/', '/v2/players', '/v1/players/', '/V1/players', '/v1/predictions/', '/v1/registrations/x', '/documentation', '/changelogs']) {
    add(`unmatched ${target}`, { target, key: true });
  }

  // Authentication and scope on every keyed route.
  for (const [name, target, scope] of [...READS, ['predictions', '/v1/predictions', 'predictions:write'], ['registrations', '/v1/registrations', 'registrations:write']]) {
    const method = name === 'predictions' || name === 'registrations' ? 'POST' : 'GET';
    const body = name === 'predictions' ? { predictions: [prediction()] } : name === 'registrations' ? registration() : undefined;
    const common = { method, target, body, normalise: SCHEDULE_TIMES };
    add(`${name}: no key`, { ...common, key: null });
    add(`${name}: an unknown key`, { ...common, key: true, scopes: null });
    add(`${name}: a key without ${scope}`, { ...common, key: true, scopes: ['players:read', 'predictions:write', 'registrations:write', 'seasons:read'].filter((s) => s !== scope) });
    add(`${name}: a key with only ${scope}`, { ...common, key: true, scopes: [scope] });
    add(`${name}: a key with no scopes`, { ...common, key: true, scopes: [] });
  }
  const header = (value) => ({ target: '/v1/players', authorization: value });
  const someKey = `clubld_${'A'.repeat(43)}`;
  for (const [label, value] of [
    ['lower-case scheme', `bearer ${someKey}`],
    ['two spaces', `Bearer  ${someKey}`],
    ['trailing space', `Bearer ${someKey} `],
    ['Basic', 'Basic dXNlcjpwYXNz'],
    ['empty', ''],
    ['scheme only', 'Bearer'],
    ['scheme and space', 'Bearer '],
    ['short key', `Bearer clubld_${'A'.repeat(42)}`],
    ['long key', `Bearer clubld_${'A'.repeat(44)}`],
    ['upper-case prefix', `Bearer ${'clubld_'.toUpperCase()}${'A'.repeat(43)}`],
    ['base64 padding', `Bearer clubld_${'A'.repeat(42)}=`],
    ['plus sign', `Bearer clubld_${'A'.repeat(42)}+`],
    ['tab', `Bearer\tclubld_${'A'.repeat(43)}`],
    ['latin-1 byte', `Bearer clubld_${'A'.repeat(42)}é`],
    ['two keys', `Bearer ${someKey}, Bearer ${someKey}`],
  ]) {
    add(`authorization header: ${label}`, header(value));
  }
  add('authorization header: repeated', { target: '/v1/players', key: true, headers: [['Authorization', 'Bearer x']] });
  add('a key in the query string is ignored', { target: `/v1/players?key=${someKey}` });

  // Query parameters.
  const PARAM_VALUES = {
    season: [SEASON, SEASON.toUpperCase(), 'nope', '', `${SEASON}x`],
    since: ['2026-09-01T00:00:00Z', '2026-09-01T00:00:00.123456+05:30', '2026-09-01', '2026-02-30T00:00:00Z', 'yesterday', '2026-09-01T00:00:00', '+002026-09-01T00:00:00Z', '2026-09-01T24:00:00Z'],
    until: ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00.5-07:00', 'x'],
    player: [REF_A, REF_A.toUpperCase(), 'nope', REF_C],
    opponent: [REF_B, 'nope'],
    type: ['singles', 'doubles', 'mixed', 'Singles', ''],
    source: ['club', 'tournament', 'both'],
    rated: ['true', 'false', 'TRUE', '1', ''],
    status: ['final', 'voided', 'all', 'pending'],
    updated_since: ['2026-09-02T00:00:00Z', 'nope'],
    limit: ['1', '2', '500', '501', '0', '-1', '1.5', '01', '1e2', '9999999', '10000000', ' 5', '+5'],
    offset: ['0', '10', '100000', '100001', '-0', 'x'],
  };
  for (const [param, values] of Object.entries(PARAM_VALUES)) {
    for (const value of values) {
      add(`matches ?${param}=${value}`, { target: `/v1/matches?${param}=${encodeURIComponent(value)}`, key: true });
    }
  }
  for (const query of [
    'limit=1&limit=2', 'bogus=1', 'limit=2&bogus=1', 'a+b=c', '%6Cimit=2', 'limit=%32', 'limit', 'limit=', '=1', '&&limit=2&',
    'player=' + REF_A + '&opponent=' + REF_B + '&type=doubles&source=club&rated=true&status=all&season=' + SEASON + '&since=2026-09-01T00:00:00Z&until=2026-10-01T00:00:00Z&updated_since=2026-09-02T00:00:00Z&limit=2&offset=10',
    'since=2026-10-01T00:00:00Z&until=2026-09-01T00:00:00Z', 'x=%zz', 'x=%E9', '%ED%A0%80=1',
  ]) {
    add(`matches ?${query.slice(0, 60)}`, { target: `/v1/matches?${query}`, key: true });
  }
  for (const [name, target] of READS) {
    add(`${name}: an unknown parameter`, { target: `${target}${target.includes('?') ? '&' : '?'}bogus=1`, key: true, normalise: SCHEDULE_TIMES });
  }
  for (const query of ['type=singles', 'type=doubles&season=' + SEASON, 'season=nope', 'limit=2']) {
    add(`vs ?${query}`, { target: `/v1/players/${REF_A}/vs/${REF_B}?${query}`, key: true });
  }
  for (const query of ['type=singles&limit=1&offset=1', 'since=2026-09-01T00:00:00Z&until=2026-09-30T00:00:00Z', 'player=' + REF_B, 'opponent=' + REF_B]) {
    add(`ratings/matches ?${query.slice(0, 40)}`, { target: `/v1/players/${REF_A}/ratings?${query}`, key: true });
    add(`player matches ?${query.slice(0, 40)}`, { target: `/v1/players/${REF_A}/matches?${query}`, key: true });
  }
  for (const query of ['season=' + SEASON, 'season=x', '']) {
    add(`tournaments ?${query}`, { target: `/v1/tournaments?${query}`, key: true });
  }
  for (const route of ['sessions', 'events']) {
    for (const query of [
      'from=2027-01-01T00:00:00Z', 'to=2027-02-01T00:00:00Z', 'from=2027-01-01T00:00:00Z&to=2027-01-02T00:00:00Z',
      'from=2027-01-02T00:00:00Z&to=2027-01-01T00:00:00Z', 'from=2027-01-01T00:00:00Z&to=2028-01-01T00:00:00Z',
      'from=2027-01-01T00:00:00Z&to=2027-04-01T00:00:00Z', 'from=2027-01-01T00:00:00Z&to=2027-01-01T00:00:00Z', 'from=x',
      'from=2027-01-01T00:00:00.999999Z', 'limit=1',
    ]) {
      add(`${route} ?${query}`, { target: `/v1/${route}?${query}`, key: true });
    }
    add(`${route}: the default window`, { target: `/v1/${route}`, key: true, normalise: SCHEDULE_TIMES });
  }

  // Path values.
  for (const [label, target] of [
    ['upper-case ref', `/v1/players/${REF_A.toUpperCase()}`],
    ['short ref', `/v1/players/${'a'.repeat(63)}`],
    ['unpublished ref', `/v1/players/${REF_C}`],
    ['unpublished ref, matches', `/v1/players/${REF_C}/matches`],
    ['unpublished other ref', `/v1/players/${REF_A}/vs/${REF_C}`],
    ['vs themself', `/v1/players/${REF_A}/vs/${REF_A}`],
    ['unknown match', `/v1/matches/${REF_C}`],
    ['malformed match', '/v1/matches/nope'],
    ['upper-case season', `/v1/seasons/${SEASON.toUpperCase()}`],
    ['unknown season', '/v1/seasons/44444444-0000-0000-0000-000000000001'],
    ['unknown season standings', '/v1/seasons/44444444-0000-0000-0000-000000000001/standings'],
    ['malformed season', '/v1/seasons/nope'],
    ['upper-case tournament', `/v1/tournaments/${TOURNAMENT.toUpperCase()}`],
    ['unknown tournament', '/v1/tournaments/44444444-0000-0000-0000-000000000001'],
    ['unknown event', `/v1/tournaments/${TOURNAMENT}/events/44444444-0000-0000-0000-000000000001`],
    ['upper-case event', `/v1/tournaments/${TOURNAMENT}/events/${EVENT.toUpperCase()}`],
    ['event of an unknown tournament', `/v1/tournaments/44444444-0000-0000-0000-000000000001/events/${EVENT}`],
    ['malformed event', `/v1/tournaments/${TOURNAMENT}/events/nope`],
    ['encoded ref', `/v1/players/${'%61'.repeat(64)}`],
  ]) {
    add(`path: ${label}`, { target, key: true });
  }

  // Request targets, as URL parsing sees them.
  const targets = JSON.parse(fs.readFileSync(path.join(here, '../tests/vectors/targets.json'), 'utf8'));
  for (const { in: target } of targets) {
    if (/[\s]/.test(target)) continue;
    // Node takes a backtick or angle bracket in the path as is; hyper refuses
    // it. Node also routes an absolute-form target of any scheme by its path;
    // hyper refuses an absolute form without an authority.
    const accept = /[`<>]/.test(target)
      ? ACCEPT.parser('target-backtick-angle', [404, 400])
      : /^[a-z][a-z0-9+.-]*:\/\/\//i.test(target)
        ? ACCEPT.parser('absolute-form-without-authority', [200, 400])
        : /^[^/]*[^a-z/][^/]*:\/\//i.test(target)
          ? {
              // llhttp refuses a scheme that is not letters only; hyper takes
              // any RFC 3986 scheme and routes by the path.
              id: 'absolute-form-scheme-characters',
              check: (ts, rs) => ts.status === 'HTTP/1.1 400 Bad Request' && ts.headers === '' && ts.logs === '' && rs.status.startsWith('HTTP/1.1 '),
            }
          : undefined;
    add(`target ${JSON.stringify(target)}`, { target, key: true, accept });
  }

  // Upstream failures and odd rows, per read route.
  for (const [name, target, , fn] of READS) {
    const common = { target, key: true, normalise: SCHEDULE_TIMES };
    add(`${name}: ${fn} 500`, { ...common, upstream: { [fn]: { status: 500 } } });
    add(`${name}: ${fn} 404 PGRST202`, { ...common, upstream: { [fn]: { status: 404, raw: '{"code":"PGRST202"}' } } });
    add(`${name}: ${fn} not an array`, { ...common, upstream: { [fn]: { raw: '{"a":1}' } } });
    add(`${name}: ${fn} not JSON`, { ...common, upstream: { [fn]: { raw: 'nope' } } });
    add(`${name}: ${fn} empty`, { ...common, upstream: { [fn]: { rows: [] } } });
    for (const [label, rows] of [['null', [null]], ['a number', [1]], ['a string', ['x']], ['an empty object', [{}]], ['an array', [[]]], ['true', [true]]]) {
      const builtinAt = name === 'player_ratings' && (label === 'a string' || label === 'an array');
      add(`${name}: ${fn} answers ${label}`, { ...common, upstream: { [fn]: { rows } }, accept: builtinAt ? ACCEPT.jsBuiltin('{"at":null,', '{') : undefined });
    }
    add(`${name}: verify_key 500`, { ...common, upstream: { data_api_verify_key: { status: 500 } } });
  }
  add('players: active season fails', { target: '/v1/players', key: true, upstream: { data_api_active_season: { status: 500 } } });
  add('players: no active season', { target: '/v1/players', key: true, upstream: { data_api_active_season: { rows: [] } } });
  add('player published check fails', { target: `/v1/players/${REF_A}/seasons`, key: true, upstream: { data_api_player_published: { status: 503 } } });
  add('vs recent fails', { target: `/v1/players/${REF_A}/vs/${REF_B}`, key: true, upstream: { data_api_matches: { status: 500 } } });
  add('standings header fails', { target: `/v1/seasons/${SEASON}/standings`, key: true, upstream: { data_api_season_header: { status: 500 } } });
  add('tournament entrants fail', { target: `/v1/tournaments/${TOURNAMENT}`, key: true, upstream: { data_api_tournament_entrants_v2: { status: 500 } } });
  add('verify_key answers garbage', { target: '/v1/players', key: true, upstream: { data_api_verify_key: { rows: [{ consumer_id: 1, key_id: 'x', scopes: 'all' }] } } });
  add('verify_key answers a non-string scope', { target: '/v1/players', key: true, upstream: { data_api_verify_key: { rows: (b) => [{ consumer_id: 'cccccccc-0000-4000-8000-000000000000', key_id: '11111111-0000-4000-8000-000000000000', scopes: ['players:read', 7, null] }] } } });

  // Values the shaping has to print as JavaScript would.
  const ODD_VALUES = [null, '1', 1.5, -0, 1e21, 1e-7, 123456789012345680000, true, [], {}, 'x y', 'é'];
  for (const field of Object.keys(playerRow(REF_A))) {
    for (const value of ODD_VALUES) {
      add(`players row ${field}=${JSON.stringify(value)}`, {
        target: '/v1/players',
        key: true,
        upstream: { data_api_players: { rows: [{ ...playerRow(REF_A), [field]: value }] } },
        accept: field === 'updated_at' && value === '1' ? ACCEPT.jsBuiltin('"updated_at":"1"', '"updated_at":"2001-01-01T00:00:00Z"') : undefined,
      });
    }
  }
  for (const field of Object.keys(matchRow())) {
    for (const value of [null, 'x', 7, -0, 2.5, [], {}, true]) {
      add(`match row ${field}=${JSON.stringify(value)}`, {
        target: `/v1/matches/${MATCH_REF}`,
        key: true,
        upstream: { data_api_match_by_ref: { rows: [{ ...matchRow(), [field]: value }] } },
      });
    }
  }
  for (const value of ['2026-09-14T04:11:55.123456+00:00', '2026-09-14T04:11:55Z', '2026-09-14', 'nope', '', 5, null, '+275760-09-13T00:00:00Z', '2026-09-14T04:11:55.999999-08:00']) {
    add(`player updated_at ${JSON.stringify(value)}`, {
      target: `/v1/players/${REF_A}`,
      key: true,
      upstream: { data_api_player_by_ref: { rows: [{ ...playerRow(REF_A), updated_at: value }] } },
    });
  }
  add('matches: a full page sets next_offset', {
    target: '/v1/matches?limit=2&offset=4',
    key: true,
    upstream: { data_api_matches: { rows: (b) => Array.from({ length: b.p_limit }, (_, i) => matchRow(i)) } },
  });

  // POST /v1/predictions: before the body.
  const P = '/v1/predictions';
  const post = (body, extra = {}) => ({ method: 'POST', target: P, key: true, body, ...extra });
  add('predictions: write', post({ predictions: [prediction()] }));
  add('predictions: a query string', post({ predictions: [prediction()] }, { target: `${P}?dry_run=1` }));
  for (const contentType of [
    'text/plain', 'application/json; charset=utf-8', 'Application/JSON', ' application/json ', 'application/json;', 'application/jsonx',
    'application/json-patch+json', 'application/x-www-form-urlencoded', '', 'application/jsoné', 'application/ json', 'APPLICATION/JSON;CHARSET=UTF-8',
  ]) {
    add(`predictions: content-type ${JSON.stringify(contentType)}`, post({ predictions: [prediction()] }, { contentType }));
  }
  add('predictions: no content-type', post({ predictions: [prediction()] }, { contentType: null }));
  add('predictions: two content-types', post({ predictions: [prediction()] }, { contentType: 'text/plain', headers: [['Content-Type', 'application/json']] }));
  add('predictions: chunked', post({ predictions: [prediction()] }, { chunked: true }));
  add('predictions: Expect 100-continue, JSON', post({ predictions: [prediction()] }, { headers: [['Expect', '100-continue']], accept: ACCEPT.expectContinue }));
  add('predictions: Expect 100-continue, refused before the body', post({ predictions: [prediction()] }, { contentType: 'text/plain', headers: [['Expect', '100-continue']], accept: ACCEPT.expectContinue }));
  add('predictions: Expect 100-continue, no key', post({ predictions: [prediction()] }, { key: null, headers: [['Expect', '100-continue']], accept: ACCEPT.expectContinue }));
  const MAX = 64 * 1024;
  const padded = (size) => {
    const head = JSON.stringify({ predictions: [prediction()], pad: 1 });
    return head + ' '.repeat(size - head.length);
  };
  add('predictions: a body of exactly the cap', post(padded(MAX)));
  add('predictions: one byte over the cap', post(padded(MAX + 1)));
  add('predictions: well over the cap', post(padded(MAX * 3)));
  add('predictions: over the cap, chunked', post(padded(MAX + 10), { chunked: true }));
  add('predictions: over the cap, not JSON', post('x'.repeat(MAX + 1)));
  add('predictions: over the cap, wrong content-type', post(padded(MAX + 1), { contentType: 'text/plain' }));
  add('predictions: empty body', post(''));
  for (const text of [
    '{"predictions": [', '[1,]', '﻿{}', 'null', 'true', '1', '"x"', '[]', '{}', ' {"predictions":[]} ', '{"predictions":1}', '{"predictions":null}',
    '{"predictions":{}}', '{"predictions":"x"}', 'NaN', '{"a":1,}', "{'a':1}", '{"predictions":[1]}', '{"predictions":[null]}', '{"predictions":[[]]}',
    '{"predictions":[[[[[[]]]]]]}', '{"__proto__":{"format":"singles"}}', '{"predictions":[],"predictions":[]}', '{"\\ud800":1}', '{"\\udc00x":1}',
    `${'['.repeat(30000)}${']'.repeat(30000)}`, `{"predictions":${'['.repeat(20000)}${']'.repeat(20000)}}`, ' {}', '{"predictions":[{}]}',
  ]) {
    const accept = text.includes('\\ud800') || text.includes('\\udc00') ? ACCEPT.loneSurrogate : undefined;
    add(`predictions: body ${JSON.stringify(text.slice(0, 50))}`, post(text, { accept }));
  }
  add('predictions: invalid UTF-8', post(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])));
  add('predictions: invalid UTF-8 in a model', post(Buffer.concat([Buffer.from('{"format":"singles","side_a":["' + REF_A + '"],"side_b":["' + REF_B + '"],"probability":0.5,"model":"a'), Buffer.from([0xc3]), Buffer.from('","made_at":"2026-09-15T08:00:00Z"}')])));

  // POST /v1/predictions: the shape.
  const hundredOne = Array.from({ length: 101 }, () => prediction());
  const shapes = [
    ['a missing field', { predictions: [prediction({ model: undefined })] }],
    ['every field missing', { predictions: [{}] }],
    ['an extra field', { predictions: [prediction({ confidence: 0.9 })] }],
    ['an extra numeric field', { predictions: [{ ...prediction(), 2: 1, 1: 0 }] }],
    ['an extra top-level key', { predictions: [prediction()], dry_run: true }],
    ['a top-level key before the wrapper', { dry_run: true, predictions: [prediction()] }],
    ['an empty batch', { predictions: [] }],
    ['a batch of 100', { predictions: Array.from({ length: 100 }, () => prediction()) }],
    ['a batch over 100', { predictions: hundredOne }],
    ['an unknown format', { predictions: [prediction({ format: 'mixed' })] }],
    ['format as a number', { predictions: [prediction({ format: 1 })] }],
    ['singles with two refs a side', { predictions: [prediction({ side_a: [REF_A, REF_C] })] }],
    ['doubles with one ref a side', { predictions: [prediction({ format: 'doubles' })] }],
    ['doubles', { predictions: [prediction({ format: 'doubles', side_a: [REF_A, REF_B], side_b: [REF_C, REF_D] })] }],
    ['doubles with a repeated ref', { predictions: [prediction({ format: 'doubles', side_a: [REF_A, REF_B], side_b: [REF_C, REF_A] })] }],
    ['doubles with a repeated ref on one side', { predictions: [prediction({ format: 'doubles', side_a: [REF_A, REF_A], side_b: [REF_C, REF_D] })] }],
    ['a malformed ref', { predictions: [prediction({ side_b: ['B'.repeat(64)] })] }],
    ['a ref as a number', { predictions: [prediction({ side_b: [7] })] }],
    ['a side as a string', { predictions: [prediction({ side_a: REF_A })] }],
    ['the same ref on both sides', { predictions: [prediction({ side_b: [REF_A] })] }],
    ['a probability of 0', { predictions: [prediction({ probability: 0 })] }],
    ['a probability of 1', { predictions: [prediction({ probability: 1 })] }],
    ['a probability over 1', { predictions: [prediction({ probability: 1.2 })] }],
    ['a negative probability', { predictions: [prediction({ probability: -0.1 })] }],
    ['a probability as a string', { predictions: [prediction({ probability: '0.5' })] }],
    ['a probability of null', { predictions: [prediction({ probability: null })] }],
    ['a probability of true', { predictions: [prediction({ probability: true })] }],
    ['a model with a newline', { predictions: [prediction({ model: 'elo\nv3' })] }],
    ['a model of 64 characters', { predictions: [prediction({ model: 'm'.repeat(64) })] }],
    ['a model of 65 characters', { predictions: [prediction({ model: 'm'.repeat(65) })] }],
    ['an empty model', { predictions: [prediction({ model: '' })] }],
    ['a model with every allowed character', { predictions: [prediction({ model: 'Az09 ._:+-' })] }],
    ['a model with a slash', { predictions: [prediction({ model: 'elo/v3' })] }],
    ['a model with an accent', { predictions: [prediction({ model: 'eloé' })] }],
    ['a made_at with an offset', { predictions: [prediction({ made_at: '2026-09-15T08:00:00+00:00' })] }],
    ['a made_at with micros', { predictions: [prediction({ made_at: '2026-09-15T08:00:00.123456Z' })] }],
    ['a made_at with seven digits', { predictions: [prediction({ made_at: '2026-09-15T08:00:00.1234567Z' })] }],
    ['a made_at without seconds', { predictions: [prediction({ made_at: '2026-09-15T08:00Z' })] }],
    ['a made_at on 30 February', { predictions: [prediction({ made_at: '2026-02-30T08:00:00Z' })] }],
    ['a made_at at hour 24', { predictions: [prediction({ made_at: '2026-01-01T24:00:00Z' })] }],
    ['a made_at in year 0', { predictions: [prediction({ made_at: '0000-01-01T00:00:00Z' })] }],
    ['a lower-case made_at', { predictions: [prediction({ made_at: '2026-09-15t08:00:00z' })] }],
    ['a made_at as a number', { predictions: [prediction({ made_at: 1800000000000 })] }],
    ['a bare item', prediction()],
    ['a bare item with a bad field', prediction({ probability: -0.1 })],
    ['a bare item with an extra field', prediction({ extra: 1 })],
    ['a second item bad', { predictions: [prediction(), prediction({ format: 'x' })] }],
    ['an item that is a string', { predictions: [prediction(), 'x'] }],
    ['field order shuffled', { predictions: [{ made_at: '2026-09-15T08:00:00Z', model: 'm', probability: 0.5, side_b: [REF_B], side_a: [REF_A], format: 'singles' }] }],
  ];
  for (const [label, body] of shapes) add(`predictions shape: ${label}`, post(body));
  for (const text of ['0', '1', '-0', '1.0', '5e-1', '0.1e1', '0.30000000000000004', '1e-7', '0.000001', '1E-300', '1e400', '-1e400', '0.5000000000000000001', '1.00', '0e5', '100e-2']) {
    const body = `{"predictions":[{"format":"singles","side_a":["${REF_A}"],"side_b":["${REF_B}"],"probability":${text},"model":"m","made_at":"2026-09-15T08:00:00Z"}]}`;
    add(`predictions: probability ${text}`, post(body));
  }
  add('predictions: made_at now', post(() => ({ predictions: [prediction({ made_at: madeAt(0) })] })));
  add('predictions: made_at 200 s ahead', post(() => ({ predictions: [prediction({ made_at: madeAt(200_000) })] })));
  add('predictions: made_at 400 s ahead', post(() => ({ predictions: [prediction({ made_at: madeAt(400_000) })] })));
  add('predictions: made_at a day ahead', post(() => ({ predictions: [prediction({ made_at: madeAt(86_400_000) })] })));

  // POST /v1/predictions: the write's answers.
  const answers = [
    ['all created', [{ item: 0, status: 'created', reason: null }]],
    ['one refused', [{ item: 0, status: 'replaced', reason: null }, { item: 1, status: 'refused', reason: 'player' }]],
    ['a key refusal', [{ item: 0, status: 'refused', reason: 'key' }]],
    ['a key refusal among others', [{ item: 0, status: 'created', reason: null }, { item: 1, status: 'refused', reason: 'key' }]],
    ['a refusal without a reason', [{ item: 0, status: 'refused' }]],
    ['an unknown status', [{ item: 0, status: 'weird', reason: 'x' }]],
    ['a status of null', [{ item: 0, status: null, reason: null }]],
    ['no status', [{ item: 0 }]],
    ['an item as a string', [{ item: '0', status: 'created', reason: null }]],
    ['an item as a float', [{ item: 1.5, status: 'created', reason: null }]],
    ['an item of -0', [{ item: -0, status: 'created', reason: null }]],
    ['no rows', []],
    ['a null row', [null]],
    ['a number row', [3]],
    ['extra columns', [{ item: 0, status: 'created', reason: null, prediction_id: 'leak' }]],
  ];
  for (const [label, rows] of answers) {
    add(`predictions answer: ${label}`, post({ predictions: [prediction(), prediction({ side_b: [REF_C] })] }, { upstream: { data_api_write_predictions: { rows } } }));
  }
  add('predictions: the write fails', post({ predictions: [prediction()] }, { upstream: { data_api_write_predictions: { status: 500 } } }));
  add('predictions: the write is missing', post({ predictions: [prediction()] }, { upstream: { data_api_write_predictions: { status: 404, raw: '{"code":"PGRST202"}' } } }));
  add('predictions: the write answers an object', post({ predictions: [prediction()] }, { upstream: { data_api_write_predictions: { raw: '{}' } } }));
  add('predictions: never cached', {
    steps: [post({ predictions: [prediction()] }), post({ predictions: [prediction()] })],
  });

  // DELETE /v1/predictions.
  const del = (body, extra = {}) => ({ method: 'DELETE', target: P, key: true, body, ...extra });
  for (const [label, body] of [
    ['two matchups', { matchups: [{ format: 'singles', side_a: [REF_B], side_b: [REF_A] }, { format: 'doubles', side_a: [REF_A, REF_B], side_b: [REF_C, REF_D] }] }],
    ['a bare matchup', { format: 'singles', side_a: [REF_A], side_b: [REF_B] }],
    ['a matchup carrying a probability', { matchups: [prediction()] }],
    ['an empty list', { matchups: [] }],
    ['predictions instead of matchups', { predictions: [prediction()] }],
    ['an extra key', { matchups: [{ format: 'singles', side_a: [REF_A], side_b: [REF_B] }], all: true }],
    ['a bad format', { matchups: [{ format: 'x', side_a: [REF_A], side_b: [REF_B] }] }],
    ['101 matchups', { matchups: Array.from({ length: 101 }, () => ({ format: 'singles', side_a: [REF_A], side_b: [REF_B] })) }],
    ['not an object', [1]],
  ]) {
    add(`delete: ${label}`, del(body));
  }
  for (const [label, rows] of answers) {
    const asDelete = JSON.parse(JSON.stringify(rows).replaceAll('"created"', '"deleted"').replaceAll('"replaced"', '"not_found"'));
    add(`delete answer: ${label}`, del({ matchups: [{ format: 'singles', side_a: [REF_A], side_b: [REF_B] }, { format: 'singles', side_a: [REF_C], side_b: [REF_D] }] }, { upstream: { data_api_delete_predictions: { rows: asDelete } } }));
  }
  add('delete: a key refusal',del({ format: 'singles', side_a: [REF_A], side_b: [REF_B] }, { upstream: { data_api_delete_predictions: { rows: [{ item: 0, status: 'refused', reason: 'key' }] } } }));
  add('delete: one refused', del({ format: 'singles', side_a: [REF_A], side_b: [REF_B] }, { upstream: { data_api_delete_predictions: { rows: [{ item: 0, status: 'refused', reason: 'player' }] } } }));
  add('delete: fails', del({ format: 'singles', side_a: [REF_A], side_b: [REF_B] }, { upstream: { data_api_delete_predictions: { status: 500 } } }));
  add('delete: wrong content-type', del({ matchups: [] }, { contentType: 'text/plain' }));

  // POST /v1/registrations.
  const R = '/v1/registrations';
  const reg = (body, extra = {}) => ({ method: 'POST', target: R, key: true, body, ...extra });
  const regShapes = [
    ['as sent', registration()],
    ['no entries', registration({ entries: undefined })],
    ['empty entries', registration({ entries: [] })],
    ['no submitted_at', registration({ submitted_at: undefined })],
    ['submitted_at null', registration({ submitted_at: null })],
    ['submitted_at with an offset', registration({ submitted_at: '2026-10-08T10:00:00.5-07:00' })],
    ['submitted_at without a zone', registration({ submitted_at: '2026-10-08T10:00:00' })],
    ['submitted_at as text', registration({ submitted_at: 'yesterday' })],
    ['submitted_at on 30 February', registration({ submitted_at: '2026-02-30T10:00:00Z' })],
    ['submitted_at empty', registration({ submitted_at: '' })],
    ['submitted_at a number', registration({ submitted_at: 5 })],
    ['email not an email', registration({ email: 'not an email' })],
    ['email with two @', registration({ email: 'a@b@c.d' })],
    ['email upper case', registration({ email: 'A.B@EXAMPLE.ORG' })],
    ['email with a non-breaking space', registration({ email: 'a b@c.d' })],
    ['email with inner tab', registration({ email: 'a@b\t.c' })],
    ['email of 254', registration({ email: `${'a'.repeat(244)}@example.org` })],
    ['email of 255', registration({ email: `${'a'.repeat(245)}@example.org` })],
    ['email with an accent', registration({ email: 'Émile@Example.org' })],
    ['email with a dotted capital I', registration({ email: 'İx@example.org' })],
    ['email missing', registration({ email: undefined })],
    ['email null', registration({ email: null })],
    ['email a number', registration({ email: 5 })],
    ['name empty', registration({ name: '' })],
    ['name spaces only', registration({ name: '   ' })],
    ['name with ideographic spaces', registration({ name: '　Guest　　Person﻿' })],
    ['name with line separators', registration({ name: 'Guest Person ' })],
    ['name of 120', registration({ name: 'n'.repeat(120) })],
    ['name of 121', registration({ name: 'n'.repeat(121) })],
    ['name of 60 emoji', registration({ name: '\u{1F600}'.repeat(60) })],
    ['name of 61 emoji', registration({ name: '\u{1F600}'.repeat(61) })],
    ['name a number', registration({ name: 5 })],
    ['name an array', registration({ name: ['x'] })],
    ['form_id with spaces', registration({ form_id: 'has spaces in it' })],
    ['form_id padded', registration({ form_id: '  abc  ' })],
    ['form_id of 200', registration({ form_id: 'f'.repeat(200) })],
    ['form_id of 201', registration({ form_id: 'f'.repeat(201) })],
    ['form_id with a slash', registration({ form_id: 'a/b' })],
    ['response_id missing', registration({ response_id: undefined })],
    ['response_id with inner spaces', registration({ response_id: 'a  b' })],
    ['an extra key', registration({ surprise: true })],
    ['an extra numeric key', { ...registration(), 5: 1 }],
    ['entries not a list', registration({ entries: {} })],
    ['entries null', registration({ entries: null })],
    ['20 entries', registration({ entries: Array.from({ length: 20 }, () => ({ event_id: EVENT_A })) })],
    ['21 entries', registration({ entries: Array.from({ length: 21 }, () => ({ event_id: EVENT_A })) })],
    ['an entry that is a string', registration({ entries: ['x'] })],
    ['an entry with a bad event_id', registration({ entries: [{ event_id: 'nope' }] })],
    ['an entry with an upper-case event_id', registration({ entries: [{ event_id: EVENT_A.toUpperCase() }] })],
    ['an entry with a bad partner email', registration({ entries: [{ event_id: EVENT_A, partner_email: 'x' }] })],
    ['an entry with every field', registration({ entries: [{ category: '  Open  ', partner_name: ' P  Q ', partner_email: 'P@EXAMPLE.ORG', event_id: EVENT_B }] })],
    ['an entry with empty optionals', registration({ entries: [{ event_id: EVENT_A, partner_email: '', partner_name: null, category: '  ' }] })],
    ['an entry with an extra field', registration({ entries: [{ event_id: EVENT_A, extra: 1 }] })],
    ['an entry with a category of 41', registration({ entries: [{ event_id: EVENT_A, category: 'c'.repeat(41) }] })],
    ['a second entry bad', registration({ entries: [{ event_id: EVENT_A }, { event_id: EVENT_B, partner_name: 7 }] })],
    ['three entries', registration({ entries: [{ event_id: EVENT_A }, { event_id: EVENT_B }, { event_id: EVENT_A, category: 'x' }] })],
    ['not an object', ['x']],
    ['null', null],
  ];
  for (const [label, body] of regShapes) add(`registrations: ${label}`, reg(body));
  add('registrations: a lone surrogate in a name', reg('{"form_id":"f","response_id":"r","email":"a@b.c","name":"x\\ud800y"}', { accept: ACCEPT.loneSurrogate }));
  add('registrations: a lone surrogate as an extra key', reg('{"\\udc00":1}', { accept: ACCEPT.loneSurrogate }));
  add('registrations: wrong content-type', reg(registration(), { contentType: 'application/x-www-form-urlencoded' }));
  add('registrations: over the cap', reg(JSON.stringify({ ...registration(), pad: 'x'.repeat(MAX) })));
  for (const [label, rows] of [
    ['entered', [{ item: 1, event_id: EVENT_A, status: 'entered', reason: null, replayed: false }]],
    ['pending with a reason', [{ item: 1, event_id: EVENT_A, status: 'pending', reason: 'should not leak', replayed: false }]],
    ['refused', [{ item: 1, event_id: EVENT_A, status: 'refused', reason: 'event_full', replayed: false }]],
    ['replayed', [{ item: 1, event_id: EVENT_A, status: 'entered', reason: null, replayed: true }]],
    ['replayed in part', [{ item: 1, event_id: EVENT_A, status: 'entered', reason: null, replayed: true }, { item: 2, event_id: EVENT_B, status: 'entered', reason: null, replayed: false }]],
    ['replayed as a string', [{ item: 1, event_id: EVENT_A, status: 'entered', reason: null, replayed: 'true' }]],
    ['no rows', []],
    ['a key refusal', [{ item: 0, event_id: null, status: 'refused', reason: 'key', replayed: false }]],
    ['no binding', [{ item: 0, event_id: null, status: 'refused', reason: 'not_found', replayed: false }]],
    ['another whole refusal', [{ item: 0, event_id: null, status: 'refused', reason: 'payload', replayed: false }]],
    ['a whole refusal after an entry', [{ item: 1, event_id: EVENT_A, status: 'entered', reason: null, replayed: false }, { item: 0, event_id: null, status: 'refused', reason: 'not_found', replayed: false }]],
    ['item 0 as a string', [{ item: '0', event_id: null, status: 'refused', reason: 'key', replayed: false }]],
    ['item -0', [{ item: -0, event_id: null, status: 'refused', reason: 'key', replayed: false }]],
    ['no item', [{ event_id: null, status: 'refused', reason: 'key', replayed: false }]],
    ['no event_id', [{ item: 1, status: 'entered' }]],
    ['a null row', [null]],
    ['unknown status', [{ item: 1, event_id: EVENT_A, status: 'odd', reason: 'x', replayed: false }]],
  ]) {
    add(`registrations answer: ${label}`, reg(registration(), { upstream: { data_api_import_registration: { rows } } }));
  }
  add('registrations: the import fails', reg(registration(), { upstream: { data_api_import_registration: { status: 500 } } }));

  // Rate limits: sent back to back (`burst`), so the buckets barely refill,
  // and each case states what the limiter must have done.
  const statusesAre = (text, test) => ({ burst: true, expectText: text, expect: test });
  const lastIs429 = (s) => s.at(-1) === 429 && s.slice(0, -1).every((x) => x !== 429);
  add('rate: 62 reads on one key', {
    ...statusesAre('60 answers then two 429s', (s) => s.slice(0, 60).every((x) => x === 200) && s[60] === 429 && s[61] === 429),
    steps: Array.from({ length: 62 }, () => ({ target: '/v1/seasons', key: true })),
  });
  add('rate: a write batch is charged once', {
    ...statusesAre('60 three-item batches then a 429', lastIs429),
    steps: Array.from({ length: 61 }, () => post({ predictions: [prediction(), prediction({ side_b: [REF_C] }), prediction({ side_b: [REF_D] })] })),
  });
  add('rate: reads and writes share the bucket', {
    ...statusesAre('60 mixed then a 429', lastIs429),
    steps: Array.from({ length: 61 }, (_, i) => (i % 2 === 0 ? { target: '/v1/seasons', key: true } : post({ predictions: [prediction()] }))),
  });
  add('rate: 31 unknown keys from one address', {
    ...statusesAre('30 401s then a 429', (s) => s.slice(0, 30).every((x) => x === 401) && s[30] === 429),
    scopes: null,
    steps: Array.from({ length: 31 }, () => ({ target: '/v1/players', key: (ctx) => ctx.newKey() })),
  });
  add('rate: malformed headers are not charged', {
    ...statusesAre('35 401s and no 429', (s) => s.every((x) => x === 401)),
    steps: Array.from({ length: 35 }, () => ({ target: '/v1/players', authorization: 'Bearer nope' })),
  });
  add('rate: the page is not charged', {
    ...statusesAre('61 pages then a 200', (s) => s.every((x) => x === 200)),
    steps: [...Array.from({ length: 61 }, () => ({ target: '/documentations', key: true })), { target: '/v1/seasons', key: true }],
  });

  // Requests no client library sends: the parsers differ. README.md lists each.
  const rawHead = (line, extra = '') => `${line}\r\nHost: localhost\r\nConnection: close\r\n${extra}\r\n`;
  add('parser: an unknown method', { raw: rawHead('FOO /health HTTP/1.1'), accept: ACCEPT.parser('unknown-method', [400, 405]) });
  add('parser: two spaces before the version', { raw: rawHead('GET /health  HTTP/1.1'), accept: ACCEPT.parser('double-space', [200, 400]) });
  add('parser: HTTP/1.0', { raw: rawHead('GET /health HTTP/1.0'), accept: { id: 'http-1.0-status-line', check: (ts, rs, diff) => only(diff, ['status']) && ts.status === 'HTTP/1.1 200 OK' && rs.status === 'HTTP/1.0 200 OK' } });
  add('parser: CONNECT authority-form', { raw: rawHead('CONNECT localhost:80 HTTP/1.1'), accept: ACCEPT.parser('connect-authority', [0, 400]) });
  for (const size of [8000, 16000, 16300, 16384, 16500, 17000, 17500, 20000, 70000]) {
    // Node counts 16 KiB of target and header bytes; hyper bounds its read
    // buffer (17 KiB, request line included). A head in between is a 431 from
    // Node and served by hyper; either side of the band they agree.
    const inBand = size > 16300 && size < 17408;
    add(`parser: a header of ${size} bytes`, {
      raw: rawHead('GET /health HTTP/1.1', `X-Big: ${'x'.repeat(size)}\r\n`),
      accept: inBand ? ACCEPT.parser('head-size-limit-band', [431, 200]) : undefined,
    });
  }
  add('parser: a bad header line', { raw: rawHead('GET /health HTTP/1.1', 'Bad Header\r\n') });
  add('parser: an absolute-form target', { raw: rawHead('GET http://elsewhere/health HTTP/1.1') });
  add('parser: an asterisk target', { raw: rawHead('OPTIONS * HTTP/1.1') });
  add('parser: lower-case method', { raw: rawHead('get /health HTTP/1.1'), accept: ACCEPT.parser('unknown-method', [400, 405]) });

  // The read cache, step by step: `reads` is what each step must have sent
  // upstream beyond the key check, so a step served from the cache shows [].
  const schedule = (target, extra = {}) => ({ target, key: true, normalise: SCHEDULE_TIMES, ...extra });
  const asSecond = { key: (ctx) => ctx.key2 };
  add('cache: a repeat read spelled differently is one entry', {
    steps: [
      { target: `/v1/matches?season=${SEASON}&since=2026-09-01T00:00Z`, key: true, reads: ['data_api_matches'] },
      { target: `/v1/matches?since=2026-09-01T00:00:00.000Z&season=${SEASON.toUpperCase()}`, key: true, reads: [] },
      { target: `/v1/matches?season=${SEASON}&since=2026-09-01T00:00Z&limit=5`, key: true, reads: ['data_api_matches'] },
    ],
  });
  add('cache: two consumers never share an entry', {
    steps: [
      { target: '/v1/players', key: true, reads: ['data_api_players', 'data_api_active_season'] },
      { target: '/v1/players', ...asSecond, reads: ['data_api_players', 'data_api_active_season'] },
      { target: '/v1/players', key: true, reads: [] },
    ],
  });
  add('cache: a registration drops that consumer\'s entrant and signup reads', {
    steps: [
      schedule('/v1/events?from=2027-01-15T00:00:00Z', { reads: ['data_api_club_events'] }),
      schedule('/v1/sessions?from=2027-01-15T00:00:00Z', { reads: ['data_api_sessions'] }),
      schedule('/v1/events?from=2027-01-15T00:00:00Z', { ...asSecond, reads: ['data_api_club_events'] }),
      { target: `/v1/tournaments/${TOURNAMENT}`, key: true, reads: ['data_api_tournaments', 'data_api_tournament_events_v2', 'data_api_tournament_entrants_v2'] },
      { ...reg(registration()), reads: ['data_api_import_registration'] },
      schedule('/v1/events?from=2027-01-15T00:00:00Z', { reads: ['data_api_club_events'] }),
      schedule('/v1/sessions?from=2027-01-15T00:00:00Z', { reads: [] }),
      schedule('/v1/events?from=2027-01-15T00:00:00Z', { ...asSecond, reads: [] }),
      { target: `/v1/tournaments/${TOURNAMENT}`, key: true, reads: ['data_api_tournament_entrants_v2'] },
    ],
  });
  add('cache: a failed registration still drops them', {
    steps: [
      schedule('/v1/events?from=2027-01-15T00:00:00Z', { reads: ['data_api_club_events'] }),
      { ...reg(registration()), upstream: { data_api_import_registration: { status: 500 } }, reads: ['data_api_import_registration'] },
      schedule('/v1/events?from=2027-01-15T00:00:00Z', { reads: ['data_api_club_events'] }),
    ],
  });
  add('cache: a prediction write drops nothing', {
    steps: [
      { target: '/v1/players', key: true, reads: ['data_api_players', 'data_api_active_season'] },
      { ...post({ predictions: [prediction()] }), reads: ['data_api_write_predictions'] },
      { target: '/v1/players', key: true, reads: [] },
    ],
  });

  // Concurrent: the requests go out together while the fake holds a function
  // (see runConcurrent in parity.mjs), and `expect` must hold on each service.
  const cap = PARITY_UPSTREAM_CONCURRENCY;
  const warmKey = [{ target: '/v1/seasons', key: true }];
  const every = (list, value) => list.every((x) => x === value);
  const unavailable = '{"error":"unavailable"}';
  add('cap: never more than the cap in flight', {
    concurrent: true,
    warm: warmKey,
    hold: ['data_api_matches'],
    release: 500,
    requests: Array.from({ length: 6 }, (_, i) => ({ target: `/v1/matches?offset=${i + 1}`, key: true })),
    expectText: `six 200s, six calls, at most ${cap} in flight`,
    expect: (seen) => every(seen.statuses, 200) && seen.callsTo('data_api_matches') === 6 && seen.maxInFlight === cap,
  });
  add('cap: time in the queue counts against the 5 second timeout', {
    // The first two hold both slots until their own deadline; the third waits
    // 2.5 s of its budget in the queue and gets the rest, so it answers about
    // 5 s after it was sent, not 7.5.
    concurrent: true,
    warm: warmKey,
    hold: ['data_api_matches'],
    clientTimeoutMs: 9000,
    requests: [
      { target: '/v1/matches?offset=1', key: true },
      { target: '/v1/matches?offset=2', key: true },
      { target: '/v1/matches?offset=3', key: true, at: 2500 },
    ],
    expectText: 'three 503 unavailable with no Retry-After, logged as status 0, the queued one inside its own 5 s',
    expect: (seen) =>
      every(seen.statuses, 503) &&
      every(seen.bodies, unavailable) &&
      seen.retryAfters.every((r) => r === undefined) &&
      seen.tookMs[2] >= 4000 &&
      seen.tookMs[2] < 6500 &&
      seen.logs.filter((l) => l.msg === 'upstream_failed' && l.fn === 'data_api_matches' && l.upstream_status === 0).length === 3 &&
      seen.maxInFlight === cap,
  });
  add('single flight: one key check for many concurrent requests', {
    concurrent: true,
    hold: ['data_api_verify_key'],
    countFns: ['data_api_players'],
    release: 300,
    requests: Array.from({ length: 8 }, () => ({ target: '/v1/players', key: true })),
    expectText: 'eight 200s from one key check and one read',
    expect: (seen) => every(seen.statuses, 200) && seen.callsTo('data_api_verify_key') === 1 && seen.callsTo('data_api_players') === 1,
  });
  add('single flight: a failed key check is shared and not kept', {
    concurrent: true,
    hold: ['data_api_verify_key'],
    upstream: { data_api_verify_key: { status: 500 } },
    release: 300,
    requests: Array.from({ length: 5 }, () => ({ target: '/v1/players', key: true })),
    expectText: 'five 503s from one key check',
    expect: (seen) => every(seen.statuses, 503) && every(seen.bodies, unavailable) && seen.callsTo('data_api_verify_key') === 1,
  });
  add('single flight: concurrent identical misses make one call', {
    concurrent: true,
    warm: warmKey,
    hold: ['data_api_players'],
    release: 300,
    requests: Array.from({ length: 8 }, () => ({ target: '/v1/players', key: true })),
    expectText: 'eight 200s from one read',
    expect: (seen) => every(seen.statuses, 200) && seen.callsTo('data_api_players') === 1,
  });

  // Last: a v2 reader the database does not know yet falls back to v1, and the
  // fallback is remembered, so nothing after these may read a v2.
  add('v2 missing: tournament_event falls back to the v1 draw', {
    target: `/v1/tournaments/${TOURNAMENT}/events/${EVENT}`,
    key: true,
    upstream: { data_api_tournament_draw_v2: { status: 404, raw: '{"code":"PGRST202"}' } },
  });
  add('v2 missing: tournament falls back to v1 events', {
    target: `/v1/tournaments/${TOURNAMENT}`,
    key: true,
    upstream: {
      data_api_tournament_events_v2: { status: 404, raw: '{"code":"PGRST202"}' },
      data_api_tournament_entrants_v2: { status: 404, raw: '{"code":"PGRST202"}' },
    },
  });
  add('v2 missing: remembered', { target: `/v1/tournaments/${TOURNAMENT}`, key: true });

  return cases;
}
