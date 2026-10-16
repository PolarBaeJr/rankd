// TypeScript service vs Rust port, against one fake PostgREST: latency on a
// cached read, an uncached read and a write; RSS at idle and under load; and
// cold start to the first 200. Linux only (RSS comes from /proc). README.md
// "Benchmark" has the method and how the published numbers were taken.
//
//   node apps/data-api-rs/scripts/bench.mjs [--rust-bin <path>] [--requests 10000]
//     [--concurrency 16] [--cold-starts 15] [--json <file>]
//
// Three processes besides the service under test, so none of them competes
// with it inside one event loop: this orchestrator, the fake upstream
// (`--role upstream`) and the load generator (`--role load`). The services run
// one at a time against the same upstream process.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REF_A, REF_B, rpcAnswers } from './parity-fixtures.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const rustRoot = path.resolve(path.dirname(scriptPath), '..');
const repoRoot = path.resolve(rustRoot, '../..');
const tsRoot = path.join(repoRoot, 'apps/data-api');

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A key may make 60 requests a minute; each key the load generator mints
// makes at most this many, so no measured request is ever a 429.
const REQUESTS_PER_KEY = 59;

const SCENARIOS = {
  // The same read on every request: after the first, an answer from the cache.
  cached_read: () => ({ method: 'GET', path: '/v1/players' }),
  // A different offset on every request, so every one asks the upstream.
  uncached_read: (i) => ({ method: 'GET', path: `/v1/matches?limit=3&offset=${i}` }),
  // Writes are never cached.
  write: () => ({
    method: 'POST',
    path: '/v1/predictions',
    body: JSON.stringify({
      predictions: [
        { format: 'singles', side_a: [REF_A], side_b: [REF_B], probability: 0.64, model: 'bench', made_at: '2026-09-15T08:00:00Z' },
      ],
    }),
  }),
};

// ---- role: the fake upstream ----

function runUpstream() {
  const answers = rpcAnswers();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const fn = (req.url ?? '').split('/rest/v1/rpc/')[1] ?? '';
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      // Every key is valid here and all belong to one consumer, so a cached
      // read is cached across keys. Each has its own key_id, which is what
      // the per-key rate limit counts.
      const hash = String(body.p_key_hash ?? '');
      const keyId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const rows =
        fn === 'data_api_verify_key'
          ? [{ consumer_id: 'cccccccc-0000-4000-8000-000000000001', key_id: keyId, scopes: Object.values(SCOPES) }]
          : answers[fn]?.(body);
      res.writeHead(rows ? 200 : 404, { 'content-type': 'application/json' });
      res.end(rows ? JSON.stringify(rows) : '{"code":"PGRST202"}');
    });
  });
  server.keepAliveTimeout = 30_000;
  server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
}

const SCOPES = { players: 'players:read', matches: 'matches:read', predictions: 'predictions:write' };

// ---- role: the load generator ----

async function runLoad() {
  const port = Number(argValue('--port'));
  const scenario = SCENARIOS[argValue('--scenario')];
  const total = Number(argValue('--count'));
  const concurrency = Number(argValue('--concurrency'));
  const offset = Number(argValue('--offset', '0'));
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const keys = Array.from({ length: Math.ceil(total / REQUESTS_PER_KEY) }, () => `clubld_${randomBytes(32).toString('base64url')}`);
  const latencies = new Float64Array(total);
  const statuses = new Map();
  let next = 0;

  const one = (index) =>
    new Promise((resolve) => {
      const { method, path: target, body } = scenario(offset + index);
      const headers = { authorization: `Bearer ${keys[Math.floor(index / REQUESTS_PER_KEY)]}` };
      if (body) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(body);
      }
      const started = process.hrtime.bigint();
      const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent }, (res) => {
        res.resume();
        res.on('end', () => {
          latencies[index] = Number(process.hrtime.bigint() - started) / 1e6;
          statuses.set(res.statusCode, (statuses.get(res.statusCode) ?? 0) + 1);
          resolve();
        });
      });
      req.on('error', () => {
        latencies[index] = Number(process.hrtime.bigint() - started) / 1e6;
        statuses.set('error', (statuses.get('error') ?? 0) + 1);
        resolve();
      });
      req.end(body);
    });

  const started = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) await one(next++);
    }),
  );
  const elapsedMs = Date.now() - started;
  agent.destroy();
  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  process.stdout.write(
    JSON.stringify({
      requests: total,
      ok: statuses.get(200) ?? 0,
      statuses: Object.fromEntries(statuses),
      p50: pick(0.5),
      p90: pick(0.9),
      p95: pick(0.95),
      p99: pick(0.99),
      rps: Math.round((total / elapsedMs) * 1000),
    }) + '\n',
  );
}

// ---- the orchestrator ----

function readRssKb(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  return Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? NaN);
}

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
const READER_JWT = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ role: 'data_api_reader' })}.bench`;

function startService(command, commandArgs, upstreamPort, port) {
  return spawn(command, commandArgs, {
    env: {
      PATH: process.env.PATH,
      SUPABASE_URL: `http://127.0.0.1:${upstreamPort}`,
      SUPABASE_ANON_KEY: 'bench-anon-key',
      DATA_API_DB_JWT: READER_JWT,
      PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function stopService(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

function healthOnce(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
  });
}

/** Milliseconds from spawn to the first 200 from /health. */
async function coldStart(command, commandArgs, upstreamPort) {
  const port = await freePort();
  const started = process.hrtime.bigint();
  const child = startService(command, commandArgs, upstreamPort, port);
  try {
    for (;;) {
      if ((await healthOnce(port)) === 200) return Number(process.hrtime.bigint() - started) / 1e6;
      if (child.exitCode !== null) throw new Error(`${command} exited during a cold start`);
      if (Number(process.hrtime.bigint() - started) > 20e9) throw new Error(`${command} never answered`);
      await sleep(1);
    }
  } finally {
    await stopService(child);
  }
}

function runLoadChild(port, scenario, count, concurrency, offset) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [scriptPath, '--role', 'load', '--port', String(port), '--scenario', scenario, '--count', String(count), '--concurrency', String(concurrency), '--offset', String(offset)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`load generator exited ${code}`))));
  });
}

function buildTypeScript(buildDir) {
  execFileSync(
    process.execPath,
    [path.join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', path.join(tsRoot, 'tsconfig.json'), '--outDir', path.join(buildDir, 'dist'), '--sourceMap', 'false'],
    { stdio: 'inherit', cwd: repoRoot },
  );
  fs.copyFileSync(path.join(tsRoot, 'package.json'), path.join(buildDir, 'package.json'));
  return path.join(buildDir, 'dist/index.js');
}

function buildRust() {
  const given = argValue('--rust-bin');
  if (given) return path.resolve(given);
  execFileSync('cargo', ['build', '--release', '--locked'], { stdio: 'inherit', cwd: rustRoot });
  return path.join(process.env.CARGO_TARGET_DIR || path.join(rustRoot, 'target'), 'release/data-api-rs');
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function orchestrate() {
  if (process.platform !== 'linux') throw new Error('bench.mjs reads RSS from /proc: run it on Linux (README.md "Benchmark")');
  const requests = Number(argValue('--requests', '10000'));
  const concurrency = Number(argValue('--concurrency', '16'));
  const coldStarts = Number(argValue('--cold-starts', '15'));
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-api-bench-'));
  const upstream = spawn(process.execPath, [scriptPath, '--role', 'upstream'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const upstreamPort = await new Promise((resolve) => upstream.stdout.once('data', (c) => resolve(Number(String(c).trim()))));
    const services = [
      ['typescript', process.execPath, [buildTypeScript(buildDir)]],
      ['rust', buildRust(), []],
    ];
    const results = {};
    for (const [name, command, commandArgs] of services) {
      const result = { cold_start_ms: [], scenarios: {} };
      // One throwaway start each, so neither pays for a cold page cache.
      await coldStart(command, commandArgs, upstreamPort);
      for (let i = 0; i < coldStarts; i++) result.cold_start_ms.push(await coldStart(command, commandArgs, upstreamPort));
      result.cold_start_median_ms = median(result.cold_start_ms);

      const port = await freePort();
      const child = startService(command, commandArgs, upstreamPort, port);
      try {
        while ((await healthOnce(port)) !== 200) await sleep(5);
        await sleep(1000);
        result.rss_idle_kb = readRssKb(child.pid);
        let peak = 0;
        let offset = 0;
        for (const scenario of Object.keys(SCENARIOS)) {
          // A warm-up round at the same concurrency, discarded.
          await runLoadChild(port, scenario, Math.min(2000, requests), concurrency, offset);
          offset += requests;
          const sampler = setInterval(() => {
            peak = Math.max(peak, readRssKb(child.pid));
          }, 20);
          result.scenarios[scenario] = await runLoadChild(port, scenario, requests, concurrency, offset);
          offset += requests;
          clearInterval(sampler);
          result.scenarios[scenario].rss_peak_kb = peak;
        }
        result.rss_peak_kb = peak;
        await sleep(2000);
        result.rss_after_kb = readRssKb(child.pid);
      } finally {
        await stopService(child);
      }
      results[name] = result;
    }

    const output = { node: process.version, arch: process.arch, cpus: os.cpus().length, requests, concurrency, results };
    const jsonPath = argValue('--json');
    if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
    printTable(output);
  } finally {
    upstream.kill('SIGTERM');
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

function printTable({ requests, concurrency, results }) {
  const ms = (v) => v.toFixed(2);
  const mb = (kb) => (kb / 1024).toFixed(1);
  console.log(`\n${requests} requests per scenario, ${concurrency} at a time, after a discarded warm-up\n`);
  console.log('| | TypeScript | Rust |');
  console.log('|---|---|---|');
  for (const scenario of Object.keys(SCENARIOS)) {
    for (const q of ['p50', 'p90', 'p95', 'p99']) {
      console.log(`| ${scenario} ${q} (ms) | ${ms(results.typescript.scenarios[scenario][q])} | ${ms(results.rust.scenarios[scenario][q])} |`);
    }
    console.log(`| ${scenario} throughput (req/s) | ${results.typescript.scenarios[scenario].rps} | ${results.rust.scenarios[scenario].rps} |`);
    const okRate = (r) => `${((r.ok / r.requests) * 100).toFixed(1)}%`;
    console.log(`| ${scenario} 200s | ${okRate(results.typescript.scenarios[scenario])} | ${okRate(results.rust.scenarios[scenario])} |`);
  }
  console.log(`| RSS idle (MB) | ${mb(results.typescript.rss_idle_kb)} | ${mb(results.rust.rss_idle_kb)} |`);
  console.log(`| RSS peak under load (MB) | ${mb(results.typescript.rss_peak_kb)} | ${mb(results.rust.rss_peak_kb)} |`);
  console.log(`| cold start to first 200, median (ms) | ${ms(results.typescript.cold_start_median_ms)} | ${ms(results.rust.cold_start_median_ms)} |`);
}

const role = argValue('--role');
if (role === 'upstream') runUpstream();
else if (role === 'load') await runLoad();
else await orchestrate();
