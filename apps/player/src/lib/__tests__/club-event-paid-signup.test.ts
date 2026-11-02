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
    requirePlayer: vi.fn(async () => state.player),
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
});
