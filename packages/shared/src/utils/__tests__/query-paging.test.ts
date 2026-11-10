// The SECOND cliff — db-max-rows — and why chunking by id count does not close it.
//
// selectInChunks was written for the 8,192-byte request line and sized from it
// (IN_CHUNK_SIZE = 110 ids). On a one-row-per-id read that also bounds the rows,
// so it looked like one fix for both limits. It is not: 110 session ids against
// session_attendance is 110 sessions' worth of attendees in a single request,
// production truncates at 1,000 rows, and the caller counts the survivors.
//
// These tests pin the distinction, because it is invisible at the call site —
// both helpers return "some rows" and neither errors.

import { describe, it, expect } from 'vitest';
import {
  selectAllPages,
  selectAllInChunks,
  selectPagesUpTo,
  selectInChunks,
  ROW_PAGE_SIZE,
  MAX_ROW_PAGES,
  IN_CHUNK_SIZE,
} from '../query-chunks';

/** A server that holds `total` rows and truncates any request at `maxRows`. */
function server(total: number, maxRows = 1000) {
  const calls: Array<{ from: number; to: number }> = [];
  return {
    calls,
    page(from: number, to: number) {
      calls.push({ from, to });
      const want = Math.min(to - from + 1, maxRows);
      const rows = [];
      for (let i = from; i < Math.min(from + want, total); i++) rows.push({ i });
      return Promise.resolve({ data: rows, error: null });
    },
  };
}

describe('selectAllPages', () => {
  it('returns every row when the total is a multiple of the page size', async () => {
    // The case a naive loop gets wrong: 1000 rows at 500/page is two FULL
    // pages, so "short page means done" only terminates because of the third,
    // empty one. Stopping at the second would lose nothing here but would lose
    // rows for any total just above a boundary.
    const s = server(ROW_PAGE_SIZE * 2);
    const res = await selectAllPages(s.page);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(ROW_PAGE_SIZE * 2);
    expect(s.calls).toHaveLength(3);
  });

  it('reads past the 1,000-row server cap that truncates a single request', async () => {
    // THE REGRESSION. One unpaged request against this server returns 1,000 of
    // the 2,400 rows, with no error — which is exactly what /sessions did.
    const s = server(2400);
    const single = await s.page(0, 99999);
    expect(single.data).toHaveLength(1000);

    const paged = await selectAllPages(server(2400).page);
    expect(paged.data).toHaveLength(2400);
  });

  it('stops rather than looping forever, and says so', async () => {
    const res = await selectAllPages(() =>
      Promise.resolve({ data: Array.from({ length: ROW_PAGE_SIZE }, (_, i) => ({ i })), error: null }),
    );
    expect(res.error?.code).toBe('PAGE_LIMIT');
    expect(res.data).toHaveLength(ROW_PAGE_SIZE * MAX_ROW_PAGES);
  });

  it('returns the rows it already has alongside an error, never a silent short list', async () => {
    let n = 0;
    const res = await selectAllPages<{ i: number }>(() => {
      n++;
      if (n === 1) return Promise.resolve({ data: Array.from({ length: ROW_PAGE_SIZE }, (_, i) => ({ i })), error: null });
      return Promise.resolve({ data: null, error: { message: 'boom' } });
    });
    expect(res.error?.message).toBe('boom');
    expect(res.data).toHaveLength(ROW_PAGE_SIZE);
  });
});

describe('selectInChunks vs selectAllInChunks', () => {
  const ids = Array.from({ length: 3 }, (_, i) => `session-${i}`);
  /** 900 attendance rows per session — a one-to-many read. */
  const ROWS_PER_ID = 900;

  it('selectInChunks truncates a one-to-many read, which is the bug', async () => {
    // All three ids fit in ONE chunk (3 << 110), so this is a single request
    // for 2,700 rows and the server caps it at 1,000. The helper reports no
    // error: the caller sees a short list and counts it.
    const res = await selectInChunks<{ i: number }>(ids, (batch) => {
      const total = batch.length * ROWS_PER_ID;
      return Promise.resolve({
        data: Array.from({ length: Math.min(total, 1000) }, (_, i) => ({ i })),
        error: null,
      });
    });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1000);
    expect(res.data).not.toHaveLength(ids.length * ROWS_PER_ID);
  });

  it('selectAllInChunks returns all of them', async () => {
    const res = await selectAllInChunks<{ i: number }>(ids, (batch, from, to) => {
      const total = batch.length * ROWS_PER_ID;
      const want = Math.min(to - from + 1, 1000);
      const rows = [];
      for (let i = from; i < Math.min(from + want, total); i++) rows.push({ i });
      return Promise.resolve({ data: rows, error: null });
    });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(ids.length * ROWS_PER_ID);
  });

  it('still chunks the id list, so the request line stays legal', async () => {
    const many = Array.from({ length: IN_CHUNK_SIZE * 2 + 5 }, (_, i) => `id-${i}`);
    const batchSizes: number[] = [];
    await selectAllInChunks<{ i: number }>(many, (batch) => {
      batchSizes.push(batch.length);
      return Promise.resolve({ data: [], error: null });
    });
    expect(batchSizes).toEqual([IN_CHUNK_SIZE, IN_CHUNK_SIZE, 5]);
  });
});

describe('selectPagesUpTo', () => {
  it('reads exactly the cap without calling it truncated', async () => {
    const res = await selectPagesUpTo(server(1200).page, 1200);
    expect(res.error).toBeNull();
    expect(res.truncated).toBe(false);
    expect(res.data).toHaveLength(1200);
  });

  it('says truncated when one more row than the cap matched, and returns only the cap', async () => {
    const res = await selectPagesUpTo(server(1201).page, 1200);
    expect(res.error).toBeNull();
    expect(res.truncated).toBe(true);
    expect(res.data).toHaveLength(1200);
    expect(res.data!.at(-1)).toEqual({ i: 1199 });
  });

  it('reads past the 1,000-row server cap toward a larger one', async () => {
    const res = await selectPagesUpTo(server(5001).page, 5000);
    expect(res.truncated).toBe(true);
    expect(res.data).toHaveLength(5000);
  });

  it('returns the error with the rows read before it', async () => {
    let call = 0;
    const res = await selectPagesUpTo<{ i: number }>((from, to) => {
      call++;
      if (call === 2) return Promise.resolve({ data: null, error: { message: 'page two failed' } });
      return server(5000).page(from, to);
    }, 5000);
    expect(res.error?.message).toBe('page two failed');
    expect(res.data).toHaveLength(ROW_PAGE_SIZE);
    expect(res.truncated).toBe(false);
  });

  it('stops on a short first page', async () => {
    const s = server(10);
    const res = await selectPagesUpTo(s.page, 5000);
    expect(res.data).toHaveLength(10);
    expect(res.truncated).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  it('asks for consecutive inclusive ranges of the page size', async () => {
    const s = server(ROW_PAGE_SIZE * 2 + 3);
    await selectPagesUpTo(s.page, 5000);
    expect(s.calls).toEqual([
      { from: 0, to: ROW_PAGE_SIZE - 1 },
      { from: ROW_PAGE_SIZE, to: ROW_PAGE_SIZE * 2 - 1 },
      { from: ROW_PAGE_SIZE * 2, to: ROW_PAGE_SIZE * 3 - 1 },
    ]);
  });
});
