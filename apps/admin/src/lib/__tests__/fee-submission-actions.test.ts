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
  rpcAnswer: 'ok' as string,
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
        return { data: store.rpcAnswer, error: null };
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

const { confirmFeeSubmission, rejectFeeSubmission, eraseFormReceiptScreenshot, undoAutoConfirmedSubmission } =
  await import('../actions/fee-submissions');

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
  store.rpcAnswer = 'ok';
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
  it('confirms with no reference typed, as some bank screens show none (00298)', async () => {
    const result = await confirmFeeSubmission(SUB);
    expect(result.ok).toBe(true);
    expect(store.rpcs[0]?.args).toMatchObject({ p_method: 'e_transfer', p_reference: null });
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

  it('accepts an e-transfer number typed as the bank hides part of it (00297)', async () => {
    const result = await confirmFeeSubmission(SUB, undefined, 'H99517225\u2026111525803');
    expect(result.ok).toBe(true);
    expect(store.rpcs[0]?.args).toMatchObject({ p_reference: 'H99517225...111525803' });
  });

  it("ignores a typed reference when the member's own was sent", async () => {
    await confirmFeeSubmission(MEMBER_SUB, undefined, 'SOMETHING-ELSE');
    expect(store.rpcs[0]?.args).toMatchObject({ p_reference: null });
  });
});

describe('recording the amount paid on confirm (00300)', () => {
  it('leaves the amount out of the call when none is given', async () => {
    const result = await confirmFeeSubmission(MEMBER_SUB);
    expect(result.ok).toBe(true);
    expect(store.rpcs[0]?.args).not.toHaveProperty('p_amount_cents');
    expect(store.audits[0]).toMatchObject({ new_value: expect.objectContaining({ amount_cents: 2000 }) });
  });

  it('passes the amount the exec gave, and audits it', async () => {
    const result = await confirmFeeSubmission(SUB, undefined, undefined, 1000);
    expect(result.ok).toBe(true);
    expect(store.rpcs[0]?.args).toMatchObject({ p_submission_id: SUB, p_amount_cents: 1000 });
    expect(store.audits[0]).toMatchObject({ new_value: expect.objectContaining({ amount_cents: 1000 }) });
  });

  it('accepts the most it allows, $10,000.00', async () => {
    const result = await confirmFeeSubmission(MEMBER_SUB, undefined, undefined, 1_000_000);
    expect(result.ok).toBe(true);
    expect(store.rpcs[0]?.args).toMatchObject({ p_amount_cents: 1_000_000 });
  });

  it.each([
    ['negative', -500],
    ['zero', 0],
    ['fractional cents', 12.5],
    ['over $10,000.00', 1_000_001],
    ['not a finite number', Number.POSITIVE_INFINITY],
    ['a string', '500' as unknown as number],
  ])('refuses an amount that is %s before reading anything', async (_label, amount) => {
    const result = await confirmFeeSubmission(MEMBER_SUB, undefined, undefined, amount);
    expect(result.ok).toBe(false);
    expect(store.gate).toEqual([]);
    expect(store.rpcs).toEqual([]);
  });

  it("says why the database refused an amount, in the console's words", async () => {
    store.rpcAnswer = 'bad_amount';
    const result = await confirmFeeSubmission(MEMBER_SUB, undefined, undefined, 1000);
    expect(result).toMatchObject({
      ok: false,
      error: 'The amount paid must be more than $0.00 and at most $10,000.00, in whole cents.',
    });
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

describe('undoing an automatic confirmation (00297)', () => {
  it('asks for both the settle and the mark-unpaid capability, and passes the exec and reason', async () => {
    const result = await undoAutoConfirmedSubmission(MEMBER_SUB, '  No such payment reached the club ');
    expect(result.ok).toBe(true);
    expect(store.gate).toEqual(['fees.clubfees.markpaid.write', 'fees.clubfees.markunpaid.write']);
    expect(store.rpcs).toEqual([
      {
        fn: 'undo_auto_confirmed_fee_submission',
        args: { p_submission_id: MEMBER_SUB, p_actor: 'exec-1', p_reason: 'No such payment reached the club' },
      },
    ]);
  });

  it('asks for the tournament capability on an event fee', async () => {
    await undoAutoConfirmedSubmission(SUB, 'Wrong person');
    expect(store.gate).toEqual(['tournaments.fees.markpaid.write', 'tournaments.fees.markunpaid.write']);
  });

  it('refuses a reason under 3 characters before reading anything', async () => {
    const result = await undoAutoConfirmedSubmission(MEMBER_SUB, ' x ');
    expect(result.ok).toBe(false);
    expect(store.gate).toEqual([]);
    expect(store.rpcs).toEqual([]);
  });

  it("says why the database refused, in the console's words", async () => {
    store.rpcAnswer = 'fee_changed';
    const result = await undoAutoConfirmedSubmission(MEMBER_SUB, 'Wrong person');
    expect(result).toMatchObject({
      ok: false,
      error: 'That fee has been changed since it was confirmed. Mark it unpaid from the fee instead.',
    });
  });
});
