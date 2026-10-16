// PostgREST RPC calls as `data_api_reader`.
//
// Any non-2xx, any network failure, a timeout, or a body that is not a JSON
// array is an UpstreamError, and the handler answers 503. That includes a
// PostgREST 404 (PGRST202, the schema cache has not seen the function yet):
// passing that through as a 404 would tell a consumer their player does not
// exist when in fact the database is not ready.
//
// AT MOST `concurrency` CALLS ARE IN FLIGHT (DATA_API_UPSTREAM_CONCURRENCY,
// default 16), reads, writes and key checks alike. PostgREST holds a small
// pool of database connections, and a call past it only waits inside
// PostgREST; waiting here instead keeps the queue where its wait can be
// bounded. Waiters are served in arrival order. The timeout starts before the
// wait, so time spent queued counts against the same 5 seconds, and a call
// that never got a slot fails exactly as one that timed out in flight: an
// UpstreamError with status 0, which the handler answers 503.

import { DEFAULT_UPSTREAM_CONCURRENCY } from './config.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 5000;

export class UpstreamError extends Error {
  constructor(
    readonly fn: string,
    /** HTTP status from PostgREST, or 0 when no response arrived. */
    readonly status: number,
  ) {
    super(`upstream ${fn} failed with status ${status}`);
  }
}

export interface Upstream {
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown[]>;
  /** As rpc, with the byte length of the body the rows came from. */
  rpcSized(fn: string, args: Record<string, unknown>): Promise<{ rows: unknown[]; bytes: number }>;
}

/** A counting semaphore with a first-come queue whose waiters can give up. */
export class Gate {
  private free: number;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly size: number) {
    this.free = size;
  }

  /** Resolves when a slot is held; rejects if `signal` aborts first. */
  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    if (this.free > 0 && this.waiters.length === 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const at = this.waiters.indexOf(grant);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error('aborted'));
      };
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free += 1;
  }

  get inUse(): number {
    return this.size - this.free;
  }

  get queued(): number {
    return this.waiters.length;
  }
}

export function createUpstream(opts: {
  supabaseUrl: string;
  anonKey: string;
  dbJwt: string;
  fetch: FetchLike;
  timeoutMs?: number;
  concurrency?: number;
}): Upstream {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gate = new Gate(opts.concurrency ?? DEFAULT_UPSTREAM_CONCURRENCY);

  async function call(fn: string, args: Record<string, unknown>, signal: AbortSignal) {
    let res: Response;
    try {
      res = await opts.fetch(`${opts.supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: opts.anonKey,
          Authorization: `Bearer ${opts.dbJwt}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(args),
        signal,
      });
    } catch {
      throw new UpstreamError(fn, 0);
    }
    if (!res.ok) {
      // The body is never read into a log: on some errors PostgREST echoes
      // the arguments back, and one of those is a key hash.
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamError(fn, res.status);
    }
    let body: unknown;
    let bytes: number;
    try {
      // What res.json() does (UTF-8, a leading BOM dropped), keeping the length.
      const raw = await res.arrayBuffer();
      bytes = raw.byteLength;
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new UpstreamError(fn, res.status);
    }
    if (!Array.isArray(body)) throw new UpstreamError(fn, res.status);
    return { rows: body as unknown[], bytes };
  }

  async function rpcSized(fn: string, args: Record<string, unknown>) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      await gate.acquire(signal);
    } catch {
      throw new UpstreamError(fn, 0);
    }
    try {
      return await call(fn, args, signal);
    } finally {
      gate.release();
    }
  }

  return {
    rpcSized,
    async rpc(fn, args) {
      return (await rpcSized(fn, args)).rows;
    },
  };
}
