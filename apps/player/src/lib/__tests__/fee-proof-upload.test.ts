import { describe, it, expect, vi, beforeEach } from 'vitest';
import { removeUnreferencedUpload } from '../fee-proof-upload';

// An upload is removed only when no receipt names it, and a read that failed
// never counts as "nothing names it".

const PATH = 'user-me/shot.png';

const state = {
  rows: {} as Record<string, unknown[]>,
  errors: {} as Record<string, { message: string } | null>,
  filters: [] as { table: string; column: string; value: string; limit: number }[],
  removed: [] as string[][],
  buckets: [] as string[],
  removeError: null as { message: string } | null,
};

function service() {
  return {
    from(table: string) {
      let column = '';
      let value = '';
      const chain = {
        select: () => chain,
        eq: (c: string, v: string) => {
          column = c;
          value = v;
          return chain;
        },
        limit: async (limit: number) => {
          state.filters.push({ table, column, value, limit });
          const error = state.errors[table] ?? null;
          return error ? { data: null, error } : { data: state.rows[table] ?? [], error: null };
        },
      };
      return chain;
    },
    storage: {
      from: (bucket: string) => {
        state.buckets.push(bucket);
        return {
          remove: async (paths: string[]) => {
            state.removed.push(paths);
            return { error: state.removeError };
          },
        };
      },
    },
  } as never;
}

beforeEach(() => {
  state.rows = {};
  state.errors = {};
  state.filters = [];
  state.removed = [];
  state.buckets = [];
  state.removeError = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('removeUnreferencedUpload', () => {
  it('removes an upload no receipt names, from fee-proofs', async () => {
    expect(await removeUnreferencedUpload(service(), PATH, 'test')).toBe(true);
    expect(state.removed).toEqual([[PATH]]);
    expect(state.buckets).toEqual(['fee-proofs']);
  });

  it('asks both receipt tables about this exact path, one row each', async () => {
    await removeUnreferencedUpload(service(), PATH, 'test');
    expect(state.filters).toEqual(
      expect.arrayContaining([
        { table: 'fee_submissions', column: 'screenshot_path', value: PATH, limit: 1 },
        { table: 'registration_import_receipts', column: 'storage_path', value: PATH, limit: 1 },
      ]),
    );
  });

  it('keeps an upload a filed receipt names', async () => {
    state.rows.fee_submissions = [{ id: 'sub-1' }];
    expect(await removeUnreferencedUpload(service(), PATH, 'test')).toBe(false);
    expect(state.removed).toEqual([]);
  });

  it('keeps an upload a Form receipt names', async () => {
    state.rows.registration_import_receipts = [{ id: 'rcpt-1' }];
    expect(await removeUnreferencedUpload(service(), PATH, 'test')).toBe(false);
    expect(state.removed).toEqual([]);
  });

  it('keeps the upload when either read fails', async () => {
    for (const table of ['fee_submissions', 'registration_import_receipts']) {
      state.errors = { [table]: { message: 'boom' } };
      state.removed = [];
      expect(await removeUnreferencedUpload(service(), PATH, 'test'), table).toBe(false);
      expect(state.removed, table).toEqual([]);
    }
  });

  it('reports a failed remove without throwing', async () => {
    state.removeError = { message: 'storage down' };
    expect(await removeUnreferencedUpload(service(), PATH, 'test')).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });
});
