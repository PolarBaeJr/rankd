import { describe, it, expect, vi, beforeEach } from 'vitest';

// A PAID CLUB EVENT TAKES THE E-TRANSFER SCREENSHOT WITH THE SIGN-UP (owner,
// 2026-10-29). The plain button refuses a member the fee trigger would charge;
// signUpWithReceipt signs them up and files the receipt together, and takes
// the sign-up back when the receipt cannot be filed, so nobody is left on the
// list with neither.

const EVENT = '00000000-0000-4000-8000-0000000000e1';
const USER = 'user-me';

const state = {
  player: { id: 'player-me', is_exec: false, fee_exempt: false } as Record<string, unknown>,
  costCents: 500 as number | null,
  fee: null as { id: string; paid_at: string | null; fee_submissions: { status: string }[] } | null,
  rpcs: [] as { name: string; args: Record<string, unknown> }[],
  removed: [] as string[][],
  fileError: null as Error | null,
  filed: [] as Record<string, unknown>[],
  // The guarded removal (fee-proof-upload.ts) reads both receipt tables first.
  referenced: { fee_submissions: false, registration_import_receipts: false } as Record<string, boolean>,
  readError: { fee_submissions: false, registration_import_receipts: false } as Record<string, boolean>,
  storageCalls: 0,
  playerRefused: false,
};

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('../feature-gate', () => ({ assertFeatureOn: vi.fn(async () => {}) }));
vi.mock('../registration-import', () => ({
  loadOwnImportEntry: vi.fn(),
  settleImportEntry: vi.fn(),
  settleRefusal: vi.fn(),
}));
vi.mock('../club-socials', () => ({ getMembershipPayments: vi.fn(async () => ({ etransferEmail: 'pay@example.org' })) }));
vi.mock('../receipt-ocr-server', () => ({ serverReceiptOcr: vi.fn() }));
vi.mock('@badminton/shared/src/utils/receipt-check', () => ({ checkSubmission: vi.fn() }));
vi.mock('../fee-submission-core', () => ({
  fileFeeSubmission: vi.fn(async (_client: unknown, _player: unknown, input: Record<string, unknown>) => {
    if (state.fileError) throw state.fileError;
    state.filed.push(input);
    return 'sub-new';
  }),
}));
vi.mock('../actions/_shared', async () => {
  const shared = await vi.importActual<typeof import('../actions/_shared')>('../actions/_shared');
  return {
    runAction: shared.runAction,
    requirePlayer: vi.fn(async () => {
      if (state.playerRefused) throw new Error('Not authenticated');
      return state.player;
    }),
    assertCurrentWaiver: vi.fn(async () => {}),
  };
});
vi.mock('../supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
  })),
  createServiceRoleClient: () => ({
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: async () => {
          if (state.readError[table]) return { data: null, error: { message: `${table} read failed` } };
          return { data: state.referenced[table] ? [{ id: `${table}-row` }] : [], error: null };
        },
        maybeSingle: async () =>
          table === 'club_events'
            ? { data: { cost_cents: state.costCents }, error: null }
            : { data: state.fee, error: null },
      };
      return chain;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcs.push({ name, args });
      // The fee trigger, as club_event_signup_fee runs it.
      if (name === 'club_event_sign_up' && (state.costCents ?? 0) > 0 && !state.player.is_exec) {
        state.fee = { id: 'fee-new', paid_at: null, fee_submissions: [] };
      }
      return { data: { ok: true }, error: null };
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          state.storageCalls++;
          state.removed.push(paths);
          return { error: null };
        },
      }),
    },
  }),
}));

const { signUpForClubEvent, signUpWithReceipt } = await import('../club-event-actions');

const RECEIPT = { reference: 'CA1a2B3c4D', screenshotPath: `${USER}/shot.png` };
const called = (name: string) => state.rpcs.filter((r) => r.name === name).length;

beforeEach(() => {
  state.player = { id: 'player-me', is_exec: false, fee_exempt: false };
  state.costCents = 500;
  state.fee = null;
  state.rpcs = [];
  state.removed = [];
  state.fileError = null;
  state.filed = [];
  state.referenced = { fee_submissions: false, registration_import_receipts: false };
  state.readError = { fee_submissions: false, registration_import_receipts: false };
  state.storageCalls = 0;
  state.playerRefused = false;
});

describe('signUpForClubEvent on a paid event', () => {
  it('refuses a member who would be charged, and signs nobody up', async () => {
    const result = await signUpForClubEvent(EVENT);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('e-transfer screenshot') });
    expect(called('club_event_sign_up')).toBe(0);
  });

  it('signs up an exec, whom the trigger does not charge', async () => {
    state.player = { ...state.player, is_exec: true };
    expect(await signUpForClubEvent(EVENT)).toMatchObject({ ok: true });
    expect(called('club_event_sign_up')).toBe(1);
  });

  it('signs up a member whose fee already holds a receipt from before they withdrew', async () => {
    state.fee = { id: 'fee-old', paid_at: null, fee_submissions: [{ status: 'submitted' }] };
    expect(await signUpForClubEvent(EVENT)).toMatchObject({ ok: true });
    expect(called('club_event_sign_up')).toBe(1);
  });

  it('signs anybody up for a free event', async () => {
    state.costCents = 0;
    expect(await signUpForClubEvent(EVENT)).toMatchObject({ ok: true });
  });
});

describe('signUpWithReceipt', () => {
  it('signs up and files the receipt against the fee the sign-up made', async () => {
    expect(await signUpWithReceipt(EVENT, RECEIPT)).toMatchObject({ ok: true });
    expect(called('club_event_sign_up')).toBe(1);
    expect(state.filed).toEqual([
      expect.objectContaining({ feeId: 'fee-new', screenshotPath: RECEIPT.screenshotPath, reference: RECEIPT.reference }),
    ]);
    expect(called('club_event_withdraw')).toBe(0);
    expect(state.removed).toEqual([]);
  });

  it('removes the upload when there is no fee to file it against', async () => {
    state.player = { ...state.player, is_exec: true };
    expect(await signUpWithReceipt(EVENT, RECEIPT)).toMatchObject({ ok: true });
    expect(state.filed).toEqual([]);
    expect(state.removed).toEqual([[RECEIPT.screenshotPath]]);
  });

  it('takes the sign-up back and removes the upload when the receipt is refused', async () => {
    const { ExpectedError } = await import('@badminton/shared');
    state.fileError = new ExpectedError('You already have a submission waiting for this fee.');
    const result = await signUpWithReceipt(EVENT, RECEIPT);
    expect(result).toMatchObject({ ok: false, error: 'You already have a submission waiting for this fee.' });
    expect(called('club_event_withdraw')).toBe(1);
    expect(state.removed).toEqual([[RECEIPT.screenshotPath]]);
  });

  it('refuses a screenshot outside the member\'s own folder, and removes nothing', async () => {
    const result = await signUpWithReceipt(EVENT, { ...RECEIPT, screenshotPath: 'someone-else/shot.png' });
    expect(result.ok).toBe(false);
    expect(called('club_event_sign_up')).toBe(0);
    expect(state.removed).toEqual([]);
  });

  it('refuses a reference that is not one, before signing up, and removes the upload', async () => {
    const result = await signUpWithReceipt(EVENT, { ...RECEIPT, reference: 'x' });
    expect(result.ok).toBe(false);
    expect(called('club_event_sign_up')).toBe(0);
    expect(state.removed).toEqual([[RECEIPT.screenshotPath]]);
  });

  it('never removes a path a receipt already names, in any branch', async () => {
    const { ExpectedError } = await import('@badminton/shared');
    for (const table of ['fee_submissions', 'registration_import_receipts']) {
      // The reference refused, before the sign-up.
      state.referenced = { fee_submissions: false, registration_import_receipts: false, [table]: true };
      state.removed = [];
      expect((await signUpWithReceipt(EVENT, { ...RECEIPT, reference: 'x' })).ok, table).toBe(false);
      expect(state.removed, `${table}: refused reference`).toEqual([]);

      // No fee to file against (an exec, whom the trigger does not charge).
      state.player = { ...state.player, is_exec: true };
      expect((await signUpWithReceipt(EVENT, RECEIPT)).ok, table).toBe(true);
      expect(called('club_event_sign_up'), table).toBeGreaterThan(0);
      expect(state.removed, `${table}: no fee`).toEqual([]);
      state.player = { ...state.player, is_exec: false };

      // The receipt refused, the sign-up taken back.
      state.fee = null;
      state.fileError = new ExpectedError('You already have a submission waiting for this fee.');
      expect((await signUpWithReceipt(EVENT, RECEIPT)).ok, table).toBe(false);
      expect(state.removed, `${table}: failed filing`).toEqual([]);
      state.fileError = null;
    }
  });

  it('keeps the file when it cannot read whether a receipt names it', async () => {
    for (const table of ['fee_submissions', 'registration_import_receipts']) {
      state.readError = { fee_submissions: false, registration_import_receipts: false, [table]: true };
      state.removed = [];
      expect((await signUpWithReceipt(EVENT, { ...RECEIPT, reference: 'x' })).ok).toBe(false);
      expect(state.removed, table).toEqual([]);
    }
  });

  it('keeps an already-filed path when the event id is not one', async () => {
    state.referenced = { fee_submissions: true, registration_import_receipts: false };
    const result = await signUpWithReceipt('not-a-uuid', RECEIPT);
    expect(result.ok).toBe(false);
    expect(called('club_event_sign_up')).toBe(0);
    expect(state.removed).toEqual([]);
  });

  it('touches no storage when there is no signed-in member', async () => {
    state.playerRefused = true;
    const result = await signUpWithReceipt(EVENT, RECEIPT);
    expect(result.ok).toBe(false);
    expect(state.storageCalls).toBe(0);
    expect(state.removed).toEqual([]);
    expect(called('club_event_sign_up')).toBe(0);
  });
});
