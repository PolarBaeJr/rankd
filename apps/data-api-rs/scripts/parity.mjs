// The parity check: the same raw HTTP requests against the TypeScript service
// (apps/data-api, the source of truth) and this Rust port, each in front of its
// own copy of one fake PostgREST that answers both identically.
//
//   npm run parity -w data-api-rs
//   node apps/data-api-rs/scripts/parity.mjs [--rust-bin <path>] [--only <text>] [--verbose]
//
// Per case it compares the status line, every response header but the
// transport ones (names case-insensitively), the body byte for byte, the log
// lines each service wrote, and the upstream calls each made (function, raw
// argument bytes, and the headers PostgREST reads). Only `generated_at` in a
// body and `ms` in a log line are normalised: both come off the wall clock.
//
// Each case gets its own key, consumer and client address, so the per-key
// rate limit, the read cache and the failed-auth bucket never couple two
// cases. A difference passes only when the case names it as accepted and the
// difference is exactly the documented one; README.md lists them.
//
// Without --rust-bin it runs `cargo build --release --locked` first. The
// TypeScript service is compiled with the workspace's tsc into a temporary
// directory. Exits 1 on any unaccepted difference, or when the HTML pages the
// binary compiles in are stale against the TypeScript (scripts/pages.mjs).

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARITY_UPSTREAM_CONCURRENCY, buildCases } from './parity-cases.mjs';
import { rpcAnswers } from './parity-fixtures.mjs';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(rustRoot, '../..');
const tsRoot = path.join(repoRoot, 'apps/data-api');

const args = process.argv.slice(2);
const argValue = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const verbose = args.includes('--verbose');
const only = argValue('--only');

// ---- builds ----

function checkPages() {
  execFileSync(process.execPath, [path.join(rustRoot, 'scripts/pages.mjs'), '--check'], { stdio: 'inherit' });
}

function buildTypeScript(buildDir) {
  const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
  execFileSync(
    process.execPath,
    [tsc, '-p', path.join(tsRoot, 'tsconfig.json'), '--outDir', path.join(buildDir, 'dist'), '--sourceMap', 'false'],
    { stdio: 'inherit', cwd: repoRoot },
  );
  // index.js reads ../package.json for "type": "module" and the version.
  fs.copyFileSync(path.join(tsRoot, 'package.json'), path.join(buildDir, 'package.json'));
  return path.join(buildDir, 'dist/index.js');
}

function buildRust() {
  const given = argValue('--rust-bin');
  if (given) return path.resolve(given);
  execFileSync('cargo', ['build', '--release', '--locked'], { stdio: 'inherit', cwd: rustRoot });
  const targetDir = process.env.CARGO_TARGET_DIR || path.join(rustRoot, 'target');
  return path.join(targetDir, 'release/data-api-rs');
}

// ---- the fake PostgREST ----

const UPSTREAM_HEADERS = ['apikey', 'authorization', 'content-type', 'accept'];

class FakeUpstream {
  constructor() {
    this.calls = [];
    this.keys = new Map();
    this.answers = rpcAnswers();
    this.overrides = {};
    // fn -> { promise, release }: a call to a held function is recorded, then
    // waits for the release before it is answered (the concurrent cases).
    this.holds = new Map();
    this.inFlight = 0;
    this.maxInFlight = 0;
  }

  reset(overrides = {}) {
    this.calls = [];
    this.overrides = overrides;
    this.maxInFlight = this.inFlight;
  }

  hold(fn) {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    this.holds.set(fn, { promise, release });
  }

  releaseAll() {
    for (const { release } of this.holds.values()) release();
    this.holds.clear();
  }

  grant(key, row) {
    this.keys.set(createHash('sha256').update(key).digest('hex'), row);
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => this.answer(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    this.server.keepAliveTimeout = 4000;
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
  }

  async answer(req, res, raw) {
    const fn = (req.url ?? '').split('/rest/v1/rpc/')[1] ?? '';
    const headers = UPSTREAM_HEADERS.map((h) => `${h}: ${req.headers[h] ?? '(none)'}`).join('\n');
    this.calls.push(`${req.method} ${fn} ${raw}\n${headers}`);
    // In flight until the answer is written or the service gives up on it.
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    res.once('close', () => {
      this.inFlight -= 1;
    });
    const held = this.holds.get(fn);
    if (held) await held.promise;
    const reply = (status, text) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    };
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, '{"code":"PGRST102"}');
    }
    const override = this.overrides[fn];
    if (override) {
      if (override.status !== undefined) return reply(override.status, override.raw ?? '{"message":"boom"}');
      if (override.raw !== undefined) return reply(200, override.raw);
      if (override.rows !== undefined) {
        const rows = typeof override.rows === 'function' ? override.rows(body) : override.rows;
        return reply(200, JSON.stringify(rows));
      }
    }
    if (fn === 'data_api_verify_key') {
      const row = this.keys.get(body.p_key_hash);
      return reply(200, JSON.stringify(row ? [row] : []));
    }
    const answer = this.answers[fn];
    if (answer) return reply(200, JSON.stringify(answer(body)));
    return reply(404, '{"code":"PGRST202"}');
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(resolve));
  }
}

// ---- the two services ----

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
// Neither service verifies the token; both only read its role claim.
const READER_JWT = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ role: 'data_api_reader' })}.parity`;

class Service {
  constructor(name, command, commandArgs) {
    this.name = name;
    this.command = command;
    this.commandArgs = commandArgs;
    this.lines = [];
  }

  async start(upstreamPort) {
    this.port = await freePort();
    this.child = spawn(this.command, this.commandArgs, {
      env: {
        PATH: process.env.PATH,
        SUPABASE_URL: `http://127.0.0.1:${upstreamPort}`,
        SUPABASE_ANON_KEY: 'parity-anon-key',
        DATA_API_DB_JWT: READER_JWT,
        PORT: String(this.port),
        // A small cap, so the concurrent cases can fill it with a few requests.
        DATA_API_UPSTREAM_CONCURRENCY: String(PARITY_UPSTREAM_CONCURRENCY),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    this.child.stdout.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        this.lines.push(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
    });
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
    const deadline = Date.now() + 15_000;
    while (!this.lines.some((l) => l.includes('"listening"'))) {
      if (this.child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`${this.name} did not start: ${this.stderr.slice(0, 500)}`);
      }
      await sleep(20);
    }
    this.lines = [];
  }

  /** Waits until the log has been quiet for a moment, then takes its lines. */
  async drainLogs() {
    let seen = -1;
    for (let waited = 0; waited < 1000; waited += 15) {
      if (this.lines.length === seen && waited >= 30) break;
      seen = this.lines.length;
      await sleep(15);
    }
    const taken = this.lines;
    this.lines = [];
    return taken;
  }

  stop() {
    if (!this.child || this.child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', resolve);
      this.child.kill('SIGTERM');
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- raw HTTP ----

function rawRequest(port, bytes, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    let done = false;
    const finish = (note) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ raw: Buffer.concat(chunks), note });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => finish('closed'));
    socket.on('error', (e) => finish(`error ${e.code}`));
    socket.on('connect', () => socket.write(bytes));
  });
}

/** Splits a raw response into interim (1xx) heads and the final response. */
function parseResponse(raw, method) {
  const interim = [];
  let rest = raw;
  for (;;) {
    const end = rest.indexOf('\r\n\r\n');
    if (end < 0) return { interim, incomplete: rest.toString('latin1') };
    const head = rest.subarray(0, end).toString('latin1').split('\r\n');
    const statusLine = head[0];
    const status = Number(statusLine.split(' ')[1]);
    const headers = head.slice(1).map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    });
    rest = rest.subarray(end + 4);
    if (status >= 100 && status < 200) {
      interim.push(statusLine);
      continue;
    }
    const get = (name) => headers.find(([n]) => n === name)?.[1];
    let body = rest;
    if (method === 'HEAD' || status === 204 || status === 304) body = Buffer.alloc(0);
    else if ((get('transfer-encoding') ?? '').toLowerCase() === 'chunked') body = dechunk(rest);
    else if (get('content-length') !== undefined) body = rest.subarray(0, Number(get('content-length')));
    return { interim, statusLine, status, headers, body };
  }
}

function dechunk(buf) {
  const out = [];
  let at = 0;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', at);
    if (lineEnd < 0) break;
    const size = parseInt(buf.subarray(at, lineEnd).toString('latin1'), 16);
    if (!size) break;
    out.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}

// ---- comparison ----

// Transport headers: their values depend on the clock or the connection.
const IGNORED_HEADERS = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding']);

function normaliseBody(body, timeFields) {
  return blankTimes(body.toString('utf8').replace(/"generated_at":"[^"]*"/g, '"generated_at":"(time)"'), timeFields);
}

/** Blanks the named string fields: the schedule routes default to the clock. */
function blankTimes(text, timeFields = []) {
  let out = text;
  for (const field of timeFields) out = out.replace(new RegExp(`"${field}":"[^"]*"`, 'g'), `"${field}":"(time)"`);
  return out;
}

function normaliseLog(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && 'ms' in parsed) parsed.ms = '(ms)';
    return JSON.stringify(parsed);
  } catch {
    return line;
  }
}

/** The observable outcome of one request, as comparable text fields. */
function outcome(response, logs, calls, timeFields) {
  if (response.statusLine === undefined) {
    return { status: `(no complete response: ${response.note}) ${response.incomplete ?? ''}`.trim(), headers: '', body: '', interim: response.interim.join(' | '), logs: logs.map(normaliseLog).join('\n'), calls: calls.join('\n\n') };
  }
  const headers = response.headers
    .filter(([n]) => !IGNORED_HEADERS.has(n))
    .map(([n, v]) => (n === 'retry-after' ? [n, '(seconds)'] : [n, v]))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, v]) => `${n}: ${v}`)
    .join('\n');
  return {
    status: response.statusLine,
    interim: response.interim.join(' | '),
    headers,
    body: normaliseBody(response.body, timeFields),
    retryAfter: response.headers.find(([n]) => n === 'retry-after')?.[1],
    logs: logs.map(normaliseLog).join('\n'),
    calls: blankTimes(calls.join('\n\n'), timeFields),
  };
}

const FIELDS = ['status', 'interim', 'headers', 'body', 'logs', 'calls'];

// Differences accepted on any case, each checked exactly.
const ALWAYS_ACCEPTED = [
  // A request the HTTP parser refuses never reaches either handler. Node
  // answers the bare status line; hyper adds `content-length: 0`. Same status,
  // no body, no log line, no upstream call.
  {
    id: 'parser-error-content-length',
    check: (ts, rs, diff) =>
      diff.length === 1 &&
      diff[0] === 'headers' &&
      /^HTTP\/1\.1 4\d\d /.test(ts.status) &&
      ts.headers === '' &&
      rs.headers === 'content-length: 0' &&
      ts.body === '' &&
      ts.logs === '',
  },
];

function differences(ts, rs) {
  const out = FIELDS.filter((f) => ts[f] !== rs[f]);
  // Retry-After is whole seconds off two clocks read a moment apart.
  if (ts.retryAfter !== undefined && rs.retryAfter !== undefined && Math.abs(Number(ts.retryAfter) - Number(rs.retryAfter)) > 1) {
    out.push('retry-after');
  }
  return out;
}

// ---- running ----

function requestBytes(step, ctx) {
  if (step.raw !== undefined) return Buffer.from(typeof step.raw === 'function' ? step.raw(ctx) : step.raw, 'latin1');
  const method = step.method ?? 'GET';
  const lines = [`${method} ${step.target} HTTP/1.1`, 'Host: localhost', 'Connection: close'];
  if (step.key !== undefined) {
    const key = step.key === true ? ctx.key : typeof step.key === 'function' ? step.key(ctx) : step.key;
    if (key !== null) lines.push(`Authorization: Bearer ${key}`);
  }
  if (step.authorization !== undefined) lines.push(`Authorization: ${step.authorization}`);
  if (step.xff !== false) lines.push(`X-Forwarded-For: ${ctx.address}`);
  for (const [name, value] of step.headers ?? []) lines.push(`${name}: ${value}`);
  let body = Buffer.alloc(0);
  if (step.body !== undefined) {
    const value = typeof step.body === 'function' ? step.body(ctx) : step.body;
    body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
    if (step.contentType !== null) lines.push(`Content-Type: ${step.contentType ?? 'application/json'}`);
  }
  if (step.body !== undefined || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (step.chunked) lines.push('Transfer-Encoding: chunked');
    else lines.push(`Content-Length: ${body.length}`);
  }
  const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
  if (step.chunked) {
    const chunks = body.length ? Buffer.concat([Buffer.from(body.length.toString(16) + '\r\n'), body, Buffer.from('\r\n')]) : Buffer.alloc(0);
    return Buffer.concat([head, chunks, Buffer.from('0\r\n\r\n')]);
  }
  return Buffer.concat([head, body]);
}

async function runStep(service, fake, step, bytes) {
  fake.reset(step.upstream);
  const response = await rawRequest(service.port, bytes, step.clientTimeoutMs);
  const parsed = parseResponse(response.raw, step.method ?? 'GET');
  parsed.note = response.note;
  const logs = await service.drainLogs();
  return outcome(parsed, logs, fake.calls, step.normalise);
}

/**
 * A rate-limit case: every step back to back with no wait for the log between
 * them, so the buckets barely refill. Per step it keeps the response; the log
 * lines and upstream calls are compared once, for the whole burst.
 */
async function runBurst(service, fake, steps, bytesList) {
  fake.reset(steps[0].upstream);
  const outs = [];
  for (const [index, step] of steps.entries()) {
    const response = await rawRequest(service.port, bytesList[index]);
    const parsed = parseResponse(response.raw, step.method ?? 'GET');
    parsed.note = response.note;
    outs.push(outcome(parsed, [], [], step.normalise));
  }
  const logs = await service.drainLogs();
  return { outs, tail: { logs: logs.map(normaliseLog).join('\n'), calls: fake.calls.join('\n\n') } };
}

/**
 * A concurrent case: the `warm` steps one after another, then the fake holds
 * the `hold` functions, the `requests` go out together (each `at` ms after the
 * start), and the holds are released `release` ms after the start (or once
 * every request has answered). Per request it keeps the response and the
 * wall-clock time it took; the log lines and upstream calls are compared once
 * for the whole run, sorted, since concurrent requests finish in any order.
 */
async function runConcurrent(service, fake, kase, warmBytes, requestBytesList) {
  fake.reset(kase.upstream);
  const warm = [];
  for (const [index, step] of (kase.warm ?? []).entries()) {
    const response = await rawRequest(service.port, warmBytes[index]);
    const parsed = parseResponse(response.raw, step.method ?? 'GET');
    parsed.note = response.note;
    warm.push(outcome(parsed, [], [], step.normalise));
  }
  await service.drainLogs();
  fake.reset(kase.upstream);
  for (const fn of kase.hold ?? []) fake.hold(fn);
  const started = Date.now();
  const releaseTimer = kase.release === undefined ? undefined : setTimeout(() => fake.releaseAll(), kase.release);
  const pending = kase.requests.map(async (step, index) => {
    if (step.at) await sleep(step.at);
    const sent = Date.now();
    const response = await rawRequest(service.port, requestBytesList[index], kase.clientTimeoutMs ?? 5000);
    const tookMs = Date.now() - sent;
    const parsed = parseResponse(response.raw, step.method ?? 'GET');
    parsed.note = response.note;
    return { out: outcome(parsed, [], [], step.normalise), tookMs };
  });
  const answered = await Promise.all(pending);
  clearTimeout(releaseTimer);
  fake.releaseAll();
  const logs = await service.drainLogs();
  const calls = [...fake.calls].sort();
  const callsTo = (fn) => calls.filter((c) => c.startsWith(`POST ${fn} `)).length;
  return {
    warm,
    outs: answered.map((a) => a.out),
    tail: { logs: logs.map(normaliseLog).sort().join('\n'), calls: calls.join('\n\n') },
    seen: {
      statuses: answered.map((a) => Number(a.out.status.split(' ')[1])),
      bodies: answered.map((a) => a.out.body),
      retryAfters: answered.map((a) => a.out.retryAfter),
      tookMs: answered.map((a) => a.tookMs),
      totalMs: Date.now() - started,
      callsTo,
      maxInFlight: fake.maxInFlight,
      logs: logs.map((l) => JSON.parse(l)),
    },
  };
}

/** What a concurrent case observed that must not differ between the services. */
function countsOf(seen, kase) {
  const fns = [...new Set([...(kase.hold ?? []), ...(kase.countFns ?? [])])];
  return JSON.stringify({ maxInFlight: seen.maxInFlight, calls: Object.fromEntries(fns.map((fn) => [fn, seen.callsTo(fn)])) });
}

/** Upstream calls in one step's comparable text, the key check left out. */
function readCalls(calls) {
  return [...calls.matchAll(/^POST (\S+) /gm)].map((m) => m[1]).filter((fn) => fn !== 'data_api_verify_key');
}

function newKey() {
  return `clubld_${randomBytes(32).toString('base64url')}`;
}

let caseCounter = 0;

function contextFor(fakes, kase) {
  caseCounter += 1;
  const ctx = {
    key: newKey(),
    consumer: `cccccccc-0000-4000-8000-${caseCounter.toString(16).padStart(12, '0')}`,
    keyId: `11111111-2222-4333-8444-${caseCounter.toString(16).padStart(12, '0')}`,
    // Documentation-range IPv6, one per case; both services take the first
    // public address from the right of X-Forwarded-For behind a private peer.
    address: `2001:db8::${caseCounter.toString(16)}`,
    newKey,
    // A second consumer with its own key, for the cache isolation cases.
    key2: newKey(),
    consumer2: `dddddddd-0000-4000-8000-${caseCounter.toString(16).padStart(12, '0')}`,
    keyId2: `22222222-2222-4333-8444-${caseCounter.toString(16).padStart(12, '0')}`,
  };
  const scopes = kase.scopes ?? ALL_SCOPES;
  if (scopes !== null) {
    for (const fake of fakes) {
      fake.grant(ctx.key, { consumer_id: ctx.consumer, key_id: ctx.keyId, scopes });
      fake.grant(ctx.key2, { consumer_id: ctx.consumer2, key_id: ctx.keyId2, scopes });
    }
  }
  return ctx;
}

let ALL_SCOPES = [];

async function main() {
  checkPages();
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-api-parity-'));
  const services = [];
  const fakes = [new FakeUpstream(), new FakeUpstream()];
  try {
    const tsEntry = buildTypeScript(buildDir);
    const rustBin = buildRust();
    ALL_SCOPES = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', `import { DATA_API_SCOPES } from ${JSON.stringify(path.join(buildDir, 'dist/scopes.js'))}; console.log(JSON.stringify(DATA_API_SCOPES))`]).toString(),
    );
    for (const fake of fakes) await fake.start();
    const ts = new Service('typescript', process.execPath, [tsEntry]);
    const rs = new Service('rust', rustBin, []);
    services.push(ts, rs);
    await ts.start(fakes[0].port);
    await rs.start(fakes[1].port);

    const cases = buildCases().filter((c) => !only || c.name.includes(only));
    let same = 0;
    const accepted = new Map();
    const failed = [];
    const coverage = new Map();
    let requests = 0;
    for (const kase of cases) {
      const ctx = contextFor(fakes, kase);
      const steps = kase.steps ?? [kase];
      let acceptedAs = null;
      let caseFailed = null;
      if (kase.burst) {
        const bursts = [];
        const bytesList = steps.map((step) => requestBytes(step, ctx));
        for (const [service, fake] of [[ts, fakes[0]], [rs, fakes[1]]]) bursts.push(await runBurst(service, fake, steps, bytesList));
        requests += steps.length;
        const [tsBurst, rsBurst] = bursts;
        for (const match of tsBurst.tail.calls.matchAll(/^POST (\S+) /gm)) coverage.set(match[1], (coverage.get(match[1]) ?? 0) + 1);
        for (const [index, tsOut] of tsBurst.outs.entries()) {
          const diff = differences(tsOut, rsBurst.outs[index]);
          if (diff.length > 0) {
            caseFailed = { kase, index, diff, tsOut, rsOut: rsBurst.outs[index] };
            break;
          }
        }
        const tailDiff = ['logs', 'calls'].filter((f) => tsBurst.tail[f] !== rsBurst.tail[f]);
        if (!caseFailed && tailDiff.length > 0) caseFailed = { kase, index: 'all', diff: tailDiff, tsOut: tsBurst.tail, rsOut: rsBurst.tail };
        // The limiter has to have fired (or not) as the case says, or the
        // comparison proved nothing about it.
        const statuses = tsBurst.outs.map((o) => Number(o.status.split(' ')[1]));
        if (!caseFailed && !kase.expect(statuses)) {
          caseFailed = { kase, index: 'all', diff: [`expected ${kase.expectText}, got ${statuses.join(' ')}`], tsOut: {}, rsOut: {} };
        }
        if (caseFailed) failed.push(caseFailed);
        else same += 1;
        if (verbose) console.log(`${caseFailed ? 'FAIL' : 'same'}  ${kase.name}`);
        continue;
      }
      if (kase.concurrent) {
        const warmBytes = (kase.warm ?? []).map((step) => requestBytes(step, ctx));
        const bytesList = kase.requests.map((step) => requestBytes(step, ctx));
        const runs = [];
        for (const [service, fake] of [[ts, fakes[0]], [rs, fakes[1]]]) runs.push(await runConcurrent(service, fake, kase, warmBytes, bytesList));
        requests += warmBytes.length + bytesList.length;
        const [tsRun, rsRun] = runs;
        for (const match of tsRun.tail.calls.matchAll(/^POST (\S+) /gm)) coverage.set(match[1], (coverage.get(match[1]) ?? 0) + 1);
        const pairs = [...tsRun.warm.map((o, i) => [`warm ${i}`, o, rsRun.warm[i]]), ...tsRun.outs.map((o, i) => [i, o, rsRun.outs[i]])];
        for (const [index, tsOut, rsOut] of pairs) {
          const diff = differences(tsOut, rsOut);
          if (diff.length > 0) {
            caseFailed = { kase, index, diff, tsOut, rsOut };
            break;
          }
        }
        const tailDiff = ['logs', 'calls'].filter((f) => tsRun.tail[f] !== rsRun.tail[f]);
        if (!caseFailed && tailDiff.length > 0) caseFailed = { kase, index: 'all', diff: tailDiff, tsOut: tsRun.tail, rsOut: rsRun.tail };
        const [tsCounts, rsCounts] = [countsOf(tsRun.seen, kase), countsOf(rsRun.seen, kase)];
        if (!caseFailed && tsCounts !== rsCounts) {
          caseFailed = { kase, index: 'all', diff: [`counts differ: typescript ${tsCounts}, rust ${rsCounts}`], tsOut: {}, rsOut: {} };
        }
        // The case's claim has to hold on each service, or the comparison
        // proved nothing about the cap or the single flight.
        for (const [name, run] of [['typescript', tsRun], ['rust', rsRun]]) {
          if (!caseFailed && !kase.expect(run.seen)) {
            const { statuses, tookMs, maxInFlight } = run.seen;
            caseFailed = { kase, index: 'all', diff: [`${name}: expected ${kase.expectText}; got statuses ${statuses.join(' ')}, took ${tookMs.join('/')} ms, ${countsOf(run.seen, kase)}, max in flight ${maxInFlight}`], tsOut: {}, rsOut: {} };
          }
        }
        if (caseFailed) failed.push(caseFailed);
        else same += 1;
        if (verbose) console.log(`${caseFailed ? 'FAIL' : 'same'}  ${kase.name}`);
        continue;
      }
      for (const [index, step] of steps.entries()) {
        // Built once, so a body that reads the clock is the same for both.
        const bytes = requestBytes(step, ctx);
        const tsOut = await runStep(ts, fakes[0], step, bytes);
        const rsOut = await runStep(rs, fakes[1], step, bytes);
        requests += 1;
        for (const match of tsOut.calls.matchAll(/^POST (\S+) /gm)) coverage.set(match[1], (coverage.get(match[1]) ?? 0) + 1);
        // A cache case names the reads each step must have sent (the key
        // check aside), so a step served from the cache shows as none.
        if (step.reads !== undefined) {
          const got = readCalls(tsOut.calls);
          if (JSON.stringify(got) !== JSON.stringify(step.reads)) {
            caseFailed = { kase, index, diff: [`expected reads [${step.reads.join(', ')}], typescript sent [${got.join(', ')}]`], tsOut, rsOut };
            break;
          }
        }
        const diff = differences(tsOut, rsOut);
        if (diff.length === 0) continue;
        const accept = [kase.accept, ...ALWAYS_ACCEPTED].find((a) => a && a.check(tsOut, rsOut, diff));
        if (accept) {
          acceptedAs = accept.id;
          continue;
        }
        caseFailed = { kase, index, diff, tsOut, rsOut };
        break;
      }
      if (caseFailed) failed.push(caseFailed);
      else if (acceptedAs) accepted.set(acceptedAs, (accepted.get(acceptedAs) ?? 0) + 1);
      else same += 1;
      if (verbose) console.log(`${caseFailed ? 'FAIL' : acceptedAs ? `ACCEPTED (${acceptedAs})` : 'same'}  ${kase.name}`);
    }

    console.log(`\nparity: ${cases.length} cases, ${requests} requests per service`);
    console.log(`  identical: ${same}`);
    for (const [id, count] of accepted) console.log(`  accepted difference "${id}": ${count}`);
    console.log(`  failed: ${failed.length}`);
    // A fixture that every service refuses before the upstream (a made_at in
    // the future, say) would compare equal and prove nothing, so each write
    // function must have been reached.
    console.log(`  upstream calls: ${[...coverage].map(([fn, n]) => `${fn} ${n}`).join(', ')}`);
    for (const fn of ['data_api_write_predictions', 'data_api_delete_predictions', 'data_api_import_registration']) {
      if (!only && (coverage.get(fn) ?? 0) < 10) {
        console.log(`  ${fn} was reached ${coverage.get(fn) ?? 0} times: the write fixtures no longer reach the upstream`);
        process.exitCode = 1;
      }
    }
    for (const f of failed.slice(0, 40)) {
      console.log(`\nFAIL ${f.kase.name} (step ${f.index}): ${f.diff.join(', ')}`);
      for (const field of f.diff.filter((d) => FIELDS.includes(d))) {
        console.log(`  ${field} typescript:\n${indent(f.tsOut[field])}`);
        console.log(`  ${field} rust:\n${indent(f.rsOut[field])}`);
      }
    }
    if (failed.length > 0) process.exitCode = 1;
    else if (!process.exitCode) console.log('\nparity OK');
  } finally {
    for (const service of services) await service.stop();
    for (const fake of fakes) if (fake.server) await fake.stop();
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

function indent(text) {
  const shown = text.length > 1500 ? `${text.slice(0, 1500)}... (${text.length} chars)` : text;
  return shown
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

await main();
