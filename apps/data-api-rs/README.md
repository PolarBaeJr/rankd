# `data-api-rs`: the Data API in Rust (1.1.0b)

A Rust port of [`apps/data-api`](../data-api), the club's external Data API.
The TypeScript service is the source of truth (1.1.0a): its
[`API.md`](../data-api/API.md) is the contract and its `src/server.ts` is the
behaviour. This port answers every route the same way, byte for byte, and the
parity check below holds it to that. Where the two disagree, the Rust is the
bug.

One static musl binary on hyper and tokio, shipped in a `scratch` image (about
1.5 MB compressed). Every crate is pinned to an exact version in `Cargo.toml`,
the toolchain in `rust-toolchain.toml`. `package.json` maps the turbo tasks
onto cargo and carries the version `/health` reports, which a test holds equal
to the TypeScript service's version. arm64 only: nothing builds or tests it on
amd64.

It is a drop-in for the TypeScript image: same port, same environment, same
uid, same routes, scopes, parameters, status codes, headers, cache rules, log
lines and upstream calls.

## What it serves

Everything the TypeScript service serves, from one table, `ROUTES` in
`src/server.rs` (template, scope, accepted methods, accepted parameters):

- `/health`, keyless.
- `/documentations` and `/changelog`, keyless HTML, GET and HEAD only. Both
  pages are generated from the TypeScript (`docs-page.ts`, `changelog-page.ts`)
  by `scripts/pages.mjs` into `src/docs/`, and compiled into the binary. The
  parity check fails if they are stale; regenerate with
  `npm run pages -w data-api-rs`.
- Every read under `/v1`, each with its scope.
- The writes: `POST` and `DELETE /v1/predictions` (`predictions:write`) and
  `POST /v1/registrations` (`registrations:write`). A write body must be
  `application/json` (else `415`, before the body is read), at most 64 KiB
  (else `413`), and JSON (else `400` with `field: "body"`), then passes the
  same shape check as the TypeScript (`src/predictions.rs`,
  `src/registrations.rs`, each a port of the `.ts` file of the same name).
  Writes go to the database with the key's hash, never through the read cache,
  and a request body is never logged: registrations carry a typed name and
  email.

The scope list, `src/scopes.rs`, is a copy of `DATA_API_SCOPES` in
`packages/shared/src/utils/data-api-key.ts`; `tests/scopes.rs` holds it equal
to that list and to the SQL CHECK. The key format, `src/key.rs`, is held to the
same file by `tests/key.rs`. `tests/drift.rs` fails when a route, scope,
parameter or error code is missing from `API.md` or the documentation page.

## How it reaches the database

As the TypeScript service does: through PostgREST, as the Postgres role
`data_api_reader`, never a direct connection and never the service_role key.
It calls the functions `apps/data-api/README.md` lists, plus the three staged
draw readers from 00277 (`data_api_tournament_events_v2`,
`data_api_tournament_entrants_v2`, `data_api_tournament_draw_v2`), falling back
to the v1 reader for a minute when PostgREST reports a v2 missing.
`tests/v2_signatures.rs` checks their argument names against 00277.

### Environment

Names only; values live in the deployment's secret store. The same four as the
TypeScript service, minted the same way (`apps/data-api/README.md`, "Minting
`DATA_API_DB_JWT`"):

| Variable | For |
|---|---|
| `SUPABASE_URL` | Kong's base URL |
| `SUPABASE_ANON_KEY` | sent as the `apikey` header Kong requires |
| `DATA_API_DB_JWT` | a long-lived JWT with `role: data_api_reader` |
| `PORT` | optional, default `8080` |
| `DATA_API_UPSTREAM_CONCURRENCY` | optional, default `16`: the most PostgREST calls in flight at once, 1 to 1024 |

It refuses to start if any of the first three is missing, or if
`DATA_API_DB_JWT` does not decode to `role: data_api_reader`.

## Run it

Needs `rustup`; run `rustup toolchain install` in `apps/data-api-rs` once to
get the pinned toolchain with clippy and rustfmt. Without Rust on the machine,
run the same commands in the `rust:1.99.0-alpine` image with this directory
mounted.

```sh
npm run start -w data-api-rs        # cargo run --release, listens on $PORT
npm run test -w data-api-rs         # cargo test --locked
npm run lint -w data-api-rs         # cargo fmt --check, then clippy -D warnings
npm run type-check -w data-api-rs   # cargo check --locked --all-targets
npm run parity -w data-api-rs       # the parity check, below
npm run bench -w data-api-rs        # the comparison, below (Linux only)
```

The root `dev`, `lint`, `type-check` and `test` scripts, the `ci.yml` checks
and the export's verify all leave this package out (`--filter=!data-api-rs`):
it is built and tested for arm64 only, those CI runners are amd64, and a
machine without Rust can still run the root gates. Run its tasks with
`-w data-api-rs` as above. `.github/workflows/data-api-rs.yml` runs all of
them but `bench` on an arm64 runner with the pinned toolchain and a cargo
cache.

The image, from the repo root:

```sh
docker build -f apps/data-api-rs/Dockerfile --target runner-data-api-rs .
```

It has no shell; its health check runs `/data-api-rs -healthcheck`, which
requests `/health` on `$PORT` and exits 0 or 1.

### Tests

`tests/` runs the service in-process against a fake PostgREST (a real HTTP
server on a random port, `tests/common/mod.rs`) with an injected clock, so the
cache and rate-limit windows are tested without waiting. Most cases are ports
of the TypeScript vitest suites; `tests/writes.rs` ports `predictions.test.ts`
and `registrations.test.ts` and adds the body edge cases.

Where the service reproduces a JavaScript behaviour exactly (`Date.parse`,
`toISOString`, `JSON.stringify` number and key order, `JSON.parse`,
`Number(PORT)`, WHATWG URL parsing of the request target), `tests/vectors.rs`
checks it against JSON vectors that Node 24 produced. To regenerate them, from
the repo root:

```sh
TZ=UTC node apps/data-api-rs/tests/vectors/generate.mjs apps/data-api-rs/tests/vectors
```

## Parity with the TypeScript service

```sh
npm run parity -w data-api-rs
node apps/data-api-rs/scripts/parity.mjs --rust-bin <binary> [--only <text>] [--verbose]
```

`scripts/parity.mjs` builds both services (the TypeScript with the workspace's
`tsc`, the Rust with `cargo build --release` unless `--rust-bin` is given),
starts each as a real process in front of its own copy of one fake PostgREST
(`scripts/parity-fixtures.mjs`, the rows `routes.test.ts` answers with), and
sends both the same raw bytes over a socket for every case in
`scripts/parity-cases.mjs`. Per request it compares:

- the status line and any interim `1xx` lines;
- every response header except `date`, `connection`, `keep-alive` and
  `transfer-encoding` (names case-insensitively; `retry-after` within a
  second, since two clocks are read);
- the body, byte for byte, with only `generated_at` blanked (and the
  clock-derived window on the default `/v1/sessions` and `/v1/events`);
- every log line, with only `ms` blanked;
- every upstream call: function, raw argument bytes, and the `apikey`,
  `authorization`, `content-type` and `accept` headers.

Each case gets a fresh key, consumer and client address, so the rate limits and
caches of one case never touch another. It fails if any difference is not one
of the accepted ones below, if a write function was never reached (a fixture
refused before the upstream would compare equal and prove nothing), or if the
generated pages are stale.

Both services run with `DATA_API_UPSTREAM_CONCURRENCY=2`, so a few requests
fill the cap. Two more kinds of case test the read cache and the cap:

- **Cache steps** name the upstream reads each step must have caused
  (`reads`), so a step answered from the cache shows none: the same request
  spelled differently, two consumers on one route, a registration (also a
  failed one) dropping that consumer's entrant and signup entries and nothing
  else, and a prediction write dropping nothing.
- **Concurrent cases** send their requests together while the fake PostgREST
  holds one function, then release it. The answers are compared in order and
  the log lines and upstream calls sorted; the calls per function and the most
  calls in flight at once must match too, and the case's own claim must hold
  on each service: never more than the cap in flight; a request queued behind
  two that hold the slots until their deadline answers `503 unavailable`
  (status 0 in the log, no Retry-After) about 5 seconds after it was sent, not
  5 seconds after it got a slot; one key check for eight concurrent requests
  on a new key, and one shared failure that is not kept; one read for eight
  concurrent identical misses.

**Result, 2026-10-09 (0.3.1):** 1393 cases (1744 requests to each service),
1349 identical, 44 accepted differences in 12 kinds, 0 failures, run in a Node
26 container. Under Node 24.19 one target case, `//xn--abc/health`, fails:
that release's URL parser refuses the label (the TypeScript answers `503`)
where the Node 24 that made `tests/vectors/targets.json` and the Rust both
route it to `/health`. release/1.1.0 before 0.3.1 fails the same case the same
way under Node 24.19; it does not involve the cache or the cap. The cases cover
every route under every method; every keyed route with no key, an unknown key,
a missing scope, the bare scope and no scopes; 17 odd `Authorization`
headers; every query parameter with valid and invalid values; every path
format; the 112 whitespace-free request targets of `tests/vectors/targets.json`; each read's
upstream answering 500, 404, not JSON, empty and odd rows; odd values in every
shaped column; the predictions and registrations body and shape checks and
every answer the write functions can give; the rate limits, sent back to back so the per-key and failed-auth limiters both answer `429` (each such case fails unless they do); parser edge cases;
and the v2-to-v1 fallback.

The earlier port of the read-only service was compared with a 479-case harness
that was never committed. This check was rebuilt from scratch for the current contract; its count is not
comparable.

### Accepted differences

All but the last two are in the HTTP parser, for requests no client library
sends. Each is matched exactly by the check, not waved through.

| Request | TypeScript (Node) | Rust (hyper) |
|---|---|---|
| Any request the parser refuses (bad header line, non-ASCII target, heads over 17 KiB, ...) | status line only | the same status, plus `content-length: 0` |
| A head between 16 KiB and 17 KiB | `431` | served |
| An unknown method token (`FOO`, `get`) | `400` | `405` |
| Two spaces before the HTTP version | served | `400` |
| A target with a backtick, `<` or `>` | routed (normally `404`) | `400` |
| An absolute-form target with an empty authority (`file:///health`) | routed by its path | `400` |
| An absolute-form target whose scheme is not letters only (`h+t.t-p://h/health`) | `400` | routed by its path |
| `CONNECT` with an authority-form target | connection closed, no answer | `400` |
| An HTTP/1.0 request | `HTTP/1.1` status line | `HTTP/1.0` status line |
| `Expect: 100-continue` | interim `100` before the handler runs | interim `100` only once the body is read, so none on a request refused first |
| A lone UTF-16 surrogate in a JSON body (`"\ud800"`) | kept, and echoed as `\ud800` where the body is echoed (a field name in a `400`, a name sent to the import) | becomes U+FFFD |
| A shaped row the database never sends: a string or array row in rating history, or a timestamp of `"1"` | a JavaScript built-in leaks through (`'x'.at` drops the `at` field; V8 reads `"1"` as 2001-01-01) | `at: null`; `"1"` |

Two more, carried over from the earlier port and not exercised by the check
(the first needs a five-minute client, the second is invisible to a
case-insensitive comparison):

- A body still arriving after 300 seconds: Node answers `408`, the Rust `503`.
- `WWW-Authenticate` goes out as `Www-Authenticate`. Header names are
  case-insensitive; the check compares them that way.

## Benchmark

```sh
npm run bench -w data-api-rs
node apps/data-api-rs/scripts/bench.mjs --rust-bin <binary> [--requests 10000] [--concurrency 16] [--cold-starts 15] [--json <file>]
```

Linux only (RSS is read from `/proc`). `scripts/bench.mjs` runs four processes:
itself, a fake PostgREST answering instantly with the parity fixtures, a load
generator, and one service at a time against that same upstream. For each
service it measures:

- **Cold start:** spawn to the first `200` from `/health`, polled every
  millisecond on a fresh connection; one discarded start, then the median of
  15.
- **RSS at idle:** `VmRSS` one second after the first `200`, before any load.
- **Latency:** three scenarios, each a discarded warm-up of 2000 requests then
  10000 measured requests, 16 in flight on keep-alive connections, timed by the
  load generator from send to the end of the body. A fresh key every 59
  requests keeps every request under the per-key limit, so every answer is a
  `200`. The **cached read** is `GET /v1/players` (one consumer, so after the
  first it is a cache hit); the **uncached read** is `GET /v1/matches` with a
  different `offset` each time, so every request reaches the upstream; the
  **write** is `POST /v1/predictions` with one prediction.
- **RSS under load:** the peak `VmRSS`, sampled every 20 ms across the three
  scenarios.

Image size is the local `docker build` of each Dockerfile (`apps/data-api` and
`apps/data-api-rs`): the content size (compressed layers, what a pull fetches)
and the unpacked size. Cold start of a container is `docker run` to the first
`200`, the median of 7 after a discarded first; it is mostly Docker's own
overhead.

The published numbers (`docs/releases/1.1.0.md`) were taken on one arm64 Mac,
with both services, the upstream and the load generator in one
`node:24-bookworm-slim` container on a 14-CPU Linux VM, the Rust binary built
for `aarch64-unknown-linux-musl`. They compare the two services on the same
machine; they are not a capacity figure for any host.

## Owner steps

- **Publishing the image** is not automated. No workflow builds or pushes the
  Rust image; `build-images.yml` and `build-staging.yml` are unchanged. To
  ship 1.1.0b, add a `data-api-rs` entry (Dockerfile
  `apps/data-api-rs/Dockerfile`, target `runner-data-api-rs`, arm64 only) to
  the image build, then swap it for the TypeScript image on the service. The
  environment and health check carry over unchanged.

## Behaviour worth knowing

As `apps/data-api/README.md`, "Behaviour worth knowing", with these
implementation notes:

- **Upstream connections are pooled without an idle cap** and closed after 4 idle
  seconds. A cap of 4 idle connections per host made every request beyond the
  fourth open and close its own connection; under load the sockets in
  TIME_WAIT ran the host out of ports and requests failed `503`.
- **The concurrency cap** (`DATA_API_UPSTREAM_CONCURRENCY`) is a fair tokio
  semaphore around every call, the key check included, acquired under the same
  5 second deadline as the call itself and held until its body has been read.
  The pool above keeps the connections; the semaphore bounds how many are busy.
- **Single flight** in both caches is a `watch` channel per key: the first
  request spawns the call on its own task (so a client that disconnects does
  not cancel it for the others), the rest wait on the channel.
- **One thread.** The runtime is tokio's current-thread scheduler, like Node's
  one event loop, so ordering inside the caches and rate limits matches. The
  multi-thread scheduler is a small change (every piece of shared state is
  already behind a lock, as `tokio::spawn` requires), and was measured for
  0.3.1 with the benchmark below: median latency three to eight times worse in
  every scenario (cached read 0.28 to 1.67 ms, uncached 1.08 to 8.22 ms, write
  0.57 to 2.61 ms) and throughput down by as much, so it was not adopted.
- **JSON nesting.** A write body nested deeper than 64 levels is still parsed
  to the end (so `400 body` and shape answers match `JSON.parse`), but the
  containers below that depth are kept empty; no shape check reads that deep.

## Known gaps

The contract's own gaps are listed in `apps/data-api/README.md`, "Known gaps",
and apply here unchanged.
