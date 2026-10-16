import { describe, it, expect, beforeEach, vi } from 'vitest';

// Reviewing a receipt a Google Form collected (00288). It has no reference
// (the person uploaded a screenshot and typed nothing) and may have no member
// behind it. Pinned here: confirming takes the exec's typed reference only
// when none was sent, and refuses with none; rejecting notifies nobody when
// there is nobody; and "Erase screenshot" removes the object, nulls every
// path to it and keeps the rows, behind the capability that settles the fee,
// with an audit row.

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  rpcs: [] as { fn: string; args: Row }[],
  removed: [] as string[][],
  audits: [] as Row[],
  notified: [] as string[][],
  gate: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../actions/_shared', () => ({
  requireCapability: vi.fn(async (capability: string) => {
    store.gate.push(capability);
    return { id: 'exec-1' };
  }),
}));
vi.mock('../audit', () => ({
  logAdminAudit: vi.fn(async (_client: unknown, entry: Row) => {
    store.audits.push(entry);
  }),
}));
vi.mock('../notify', () => ({
  notifyPlayers: vi.fn(async (_client: unknown, ids: string[]) => {
    store.notified.push(ids);
  }),
}));
vi.mock('../supabase-server', () => ({
  createAdminClient: () => {
    function query(table: string) {
      const filters: ((row: Row) => boolean)[] = [];
      let patch: Row | null = null;
      const matching = () => (store.db[table] ?? []).filter((row) => filters.every((f) => f(row)));
      const run = () => {
        const hit = matching();
        if (patch) for (const row of hit) Object.assign(row, patch);
        return { data: hit.map((row) => ({ ...row })), error: null };
      };
      const api = {
        select: () => api,
        update: (p: Row) => {
          patch = p;
          return api;
        },
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return api;
        },
        in: (column: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[column]));
          return api;
        },
        not: (column: string) => {
          filters.push((row) => row[column] != null);
          return api;
        },
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(run()).then(resolve),
      };
      return api;
    }
    return {
      from: query,
      rpc: async (fn: string, args: Row) => {
        store.rpcs.push({ fn, args });
        return { data: 'ok', error: null };
      },
      storage: {
        from: () => ({
          remove: async (paths: string[]) => {
            store.removed.push(paths);
            return { data: [], error: null };
          },
        }),
      },
    };
  },
}));

const { confirmFeeSubmission, rejectFeeSubmission, eraseFormReceiptScreenshot } = await import(
  '../actions/fee-submissions'
);

const SUB = '00000000-0000-4000-8000-000000000001';
const OTHER_SUB = '00000000-0000-4000-8000-000000000002';
const MEMBER_SUB = '00000000-0000-4000-8000-000000000003';
const RECEIPT = '00000000-0000-4000-8000-0000000000aa';
const PATH = `forms/b/i/${RECEIPT}.png`;

beforeEach(() => {
  store.rpcs = [];
  store.removed = [];
  store.audits = [];
  store.notified = [];
  store.gate = [];
  store.db = {
    club_fees: [
      { id: 'fee-named', fee_type: 'tournament', tournament_id: 't-1', amount_cents: 2500 },
      { id: 'fee-member', fee_type: 'dues', tournament_id: null, amount_cents: 2000 },
    ],
    fee_submissions: [
      {
        id: SUB,
        club_fee_id: 'fee-named',
        player_id: null,
        status: 'submitted',
        method: 'e_transfer',
        reference: null,
        screenshot_path: PATH,
        import_receipt_id: RECEIPT,
      },
      // The same upload, an earlier submission superseded by a re-file.
      {
        id: OTHER_SUB,
        club_fee_id: 'fee-named',
        player_id: null,
        status: 'superseded',
        method: 'e_transfer',
        reference: null,
        screenshot_path: PATH,
        import_receipt_id: RECEIPT,
      },
      {
        id: MEMBER_SUB,
        club_fee_id: 'fee-member',
        player_id: 'player-1',
        status: 'submitted',
        method: 'e_transfer',
        reference: 'ABC12345',
        screenshot_path: 'user-1/x.png',
        import_receipt_id: null,
      },
    ],
    registration_import_receipts: [{ id: RECEIPT, storage_path: PATH }],
  };
});

const rowOf = (table: string, id: string) => store.db[table]!.find((row) => row.id === id)!;

describe('confirming a form receipt', () => {
  it('refuses with no reference typed', async () => {
    const result = await confirmFeeSubmission(SUB);
    expect(result.ok).toBe(false);
    expect(store.rpcs).toEqual([]);
  });

  it("stores the exec's typed reference, normalised", async () => {
    const result = await confirmFeeSubmission(SUB, undefined, ' #ABC12345 ');
    expect(result.ok).toBe(true);
    expect(store.rpcs[0]?.args).toMatchObject({ p_method: 'e_transfer', p_reference: 'ABC12345' });
  });

  it('refuses a typed reference too short for an e-transfer', async () => {
    const result = await confirmFeeSubmission(SUB, undefined, '12345');
    expect(result.ok).toBe(false);
    expect(store.rpcs).toEqual([]);
  });

  it("ignores a typed reference when the member's own was sent", async () => {
    await confirmFeeSubmission(MEMBER_SUB, undefined, 'SOMETHING-ELSE');
    expect(store.rpcs[0]?.args).toMatchObject({ p_reference: null });
  });
});

describe('rejecting a form receipt', () => {
  it('notifies nobody when no member sent it', async () => {
    const result = await rejectFeeSubmission(SUB, 'Wrong amount');
    expect(result.ok).toBe(true);
    expect(store.notified).toEqual([]);
  });

  it('still notifies the member who sent their own', async () => {
    await rejectFeeSubmission(MEMBER_SUB, 'Wrong amount');
    expect(store.notified).toEqual([['player-1']]);
  });
});

describe('erasing a form receipt screenshot', () => {
  it('removes the object, nulls every path to it, keeps the rows and audits it', async () => {
    const result = await eraseFormReceiptScreenshot(SUB);
    expect(result.ok).toBe(true);
    expect(store.gate).toEqual(['tournaments.fees.markpaid.write']);
    expect(store.removed).toEqual([[PATH]]);
    expect(rowOf('fee_submissions', SUB)).toMatchObject({ screenshot_path: null, status: 'submitted' });
    expect(rowOf('fee_submissions', OTHER_SUB)).toMatchObject({ screenshot_path: null });
    expect(rowOf('registration_import_receipts', RECEIPT)).toMatchObject({ storage_path: null });
    expect(store.db.club_fees).toHaveLength(2);
    expect(store.audits).toEqual([
      expect.objectContaining({
        action_type: 'fee_submission_screenshot_erased',
        target_type: 'club_fee',
        target_id: 'fee-named',
        actor_id: 'exec-1',
      }),
    ]);
  });

  it("refuses a member's own upload: the purge erases those", async () => {
    const result = await eraseFormReceiptScreenshot(MEMBER_SUB);
    expect(result.ok).toBe(false);
    expect(store.removed).toEqual([]);
    expect(rowOf('fee_submissions', MEMBER_SUB)).toMatchObject({ screenshot_path: 'user-1/x.png' });
  });

  it('says so when it was already erased, and removes nothing', async () => {
    await eraseFormReceiptScreenshot(SUB);
    store.removed = [];
    store.audits = [];
    const again = await eraseFormReceiptScreenshot(SUB);
    expect(again.ok).toBe(false);
    expect(store.removed).toEqual([]);
    expect(store.audits).toEqual([]);
  });

  it('refuses an id that is not a uuid before reading anything', async () => {
    const result = await eraseFormReceiptScreenshot('../../etc');
    expect(result.ok).toBe(false);
    expect(store.gate).toEqual([]);
  });
});
