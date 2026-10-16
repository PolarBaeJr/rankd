import { describe, it, expect, vi, beforeEach } from 'vitest';

// THE RECEIPT RULES BOTH DOORS FILE THROUGH: the Membership page's action and
// Discord /receipt. One pending receipt per fee (the unique index's 23505),
// the method clamp (sfu_rec only on dues), the e-transfer address for every
// non-dues line, the reference length by method, and which fees are payable at
// all. A rule changed here changes for both doors at once, which is the point.

let etransferEmail: string | null = 'pay@example.org';
vi.mock('@/lib/club-socials', () => ({
  getMembershipPayments: vi.fn(async () => ({ etransferEmail })),
}));
vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: vi.fn(), getActiveSeason: vi.fn() }));

const { checkFeeSubmission, fileFeeSubmission } = await import('../fee-submission-core');
const { isExpectedFailure } = await import('@badminton/shared');

const ME = { id: 'player-me', status: 'competitive', is_exec: false, fee_exempt: false };
const FEE_ID = '00000000-0000-4000-8000-0000000000f1';
const SEASON_ID = '00000000-0000-4000-8000-0000000000a1';

type FeeRow = { id: string; player_id: string; fee_type: string; paid_at: string | null; amount_cents: number | null };

let feeRow: FeeRow | null;
let activeSeason: boolean;
let duesRow: { id: string; paid_at: string | null; amount_cents: number | null } | null;
let submissionError: { code?: string; message: string } | null;
let pendingFor: string | null;
const inserts: { table: string; row: Record<string, unknown> }[] = [];

function client() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        is: () => chain,
        limit: () =>
          Promise.resolve({ data: pendingFor && filters.club_fee_id === pendingFor ? [{ id: 'pending' }] : [], error: null }),
        update: () => chain,
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          if (table === 'fee_submissions') return Promise.resolve({ error: submissionError });
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: 'dues-new', paid_at: null, amount_cents: row.amount_cents }, error: null }),
            }),
          };
        },
        maybeSingle: () => {
          if (table === 'seasons') {
            return Promise.resolve({
              data: activeSeason ? { id: SEASON_ID, competitive_fee_cents: 4000, recreational_fee_cents: 2500 } : null,
              error: null,
            });
          }
          if (table === 'club_fees' && 'fee_type' in filters) return Promise.resolve({ data: duesRow, error: null });
          return Promise.resolve({ data: feeRow, error: null });
        },
        then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
      };
      return chain;
    },
  } as unknown as Parameters<typeof fileFeeSubmission>[0];
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(isExpectedFailure(err)).toBe(true);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
}

const forFee = (over: Record<string, unknown> = {}) => ({
  feeId: FEE_ID,
  duesSeasonId: null,
  reference: 'CAabc123',
  screenshotPath: 'user-1/x.png',
  detectedMethod: null,
  ...over,
});
const forDues = (over: Record<string, unknown> = {}) => ({
  feeId: null,
  duesSeasonId: SEASON_ID,
  reference: 'R1234',
  screenshotPath: 'user-1/x.png',
  detectedMethod: null,
  ...over,
});

beforeEach(() => {
  etransferEmail = 'pay@example.org';
  feeRow = { id: FEE_ID, player_id: ME.id, fee_type: 'event', paid_at: null, amount_cents: 1500 };
  activeSeason = true;
  duesRow = null;
  submissionError = null;
  pendingFor = null;
  inserts.length = 0;
});

describe('fileFeeSubmission', () => {
  it('stores an event fee as an e-transfer whatever the caller guessed', async () => {
    await fileFeeSubmission(client(), ME, forFee({ detectedMethod: 'sfu_rec' }));
    const submission = inserts.find((i) => i.table === 'fee_submissions')?.row;
    expect(submission).toMatchObject({ club_fee_id: FEE_ID, player_id: ME.id, method: 'e_transfer', screenshot_path: 'user-1/x.png' });
  });

  it('keeps a dues receipt method as given, or null', async () => {
    await fileFeeSubmission(client(), ME, forDues({ detectedMethod: 'sfu_rec' }));
    expect(inserts.find((i) => i.table === 'fee_submissions')?.row.method).toBe('sfu_rec');
    inserts.length = 0;
    await fileFeeSubmission(client(), ME, forDues());
    expect(inserts.find((i) => i.table === 'fee_submissions')?.row.method).toBeNull();
  });

  it('creates this season dues row priced by status when there is none', async () => {
    await fileFeeSubmission(client(), ME, forDues());
    expect(inserts[0]).toMatchObject({ table: 'club_fees', row: { fee_type: 'dues', amount_cents: 4000, player_id: ME.id } });
    expect(inserts[1]?.row.club_fee_id).toBe('dues-new');
  });

  it('turns the unique index into "already waiting"', async () => {
    submissionError = { code: '23505', message: 'duplicate' };
    expect(await refusal(fileFeeSubmission(client(), ME, forFee()))).toMatch(/already have a submission waiting/);
  });

  it('throws a plain error, not a refusal, when the insert fails otherwise', async () => {
    submissionError = { message: 'boom' };
    await expect(fileFeeSubmission(client(), ME, forFee())).rejects.toThrow(/not saved/);
  });
});

describe('checkFeeSubmission', () => {
  it('refuses a non-dues line when no e-transfer address is set, and allows dues', async () => {
    etransferEmail = null;
    expect(await refusal(checkFeeSubmission(client(), ME, forFee()))).toMatch(/Ask an exec/);
    await expect(checkFeeSubmission(client(), ME, forDues())).resolves.toMatchObject({ method: null });
  });

  it('wants 6 characters for an e-transfer reference and 4 otherwise', async () => {
    expect(await refusal(checkFeeSubmission(client(), ME, forFee({ reference: 'AB12' })))).toMatch(/6 to 32/);
    await expect(checkFeeSubmission(client(), ME, forDues({ reference: 'AB12' }))).resolves.toBeTruthy();
  });

  it('refuses a fee that is not yours, a reinstatement, a settled fee and an unpriced one', async () => {
    feeRow = { ...feeRow!, player_id: 'someone-else' };
    expect(await refusal(checkFeeSubmission(client(), ME, forFee()))).toMatch(/not one of yours/);
    feeRow = { ...feeRow!, player_id: ME.id, fee_type: 'reinstatement' };
    expect(await refusal(checkFeeSubmission(client(), ME, forFee()))).toMatch(/reinstatement/);
    feeRow = { ...feeRow!, fee_type: 'event', paid_at: '2026-10-01T00:00:00Z' };
    expect(await refusal(checkFeeSubmission(client(), ME, forFee()))).toMatch(/already settled/);
    feeRow = { ...feeRow!, paid_at: null, amount_cents: null };
    expect(await refusal(checkFeeSubmission(client(), ME, forFee()))).toMatch(/no amount/);
  });

  it('charges no dues to an exec or an exempt member, and only for the running season', async () => {
    expect(await refusal(checkFeeSubmission(client(), { ...ME, is_exec: true }, forDues()))).toMatch(/not charged/);
    expect(await refusal(checkFeeSubmission(client(), { ...ME, fee_exempt: true }, forDues()))).toMatch(/not charged/);
    activeSeason = false;
    expect(await refusal(checkFeeSubmission(client(), ME, forDues()))).toMatch(/season that is running/);
  });

  it('refuses a fee type the door does not take', async () => {
    feeRow = { ...feeRow!, fee_type: 'tournament' };
    expect(await refusal(checkFeeSubmission(client(), ME, forFee(), { feeTypes: ['dues', 'event'] }))).toMatch(/club website/);
    // The web takes it.
    await expect(checkFeeSubmission(client(), ME, forFee())).resolves.toMatchObject({ method: 'e_transfer' });
  });

  it('refuses a body naming both or neither fee, through the website schema', async () => {
    await expect(checkFeeSubmission(client(), ME, forFee({ duesSeasonId: SEASON_ID }))).rejects.toThrow();
    await expect(checkFeeSubmission(client(), ME, forFee({ feeId: null }))).rejects.toThrow();
  });

  it('refuses a receipt for a fee that already has one waiting, before any file is spent', async () => {
    pendingFor = FEE_ID;
    expect(await refusal(checkFeeSubmission(client(), ME, forFee()))).toMatch(/already have a submission waiting/);
  });

  it('refuses dues already paid this season, and dues with a receipt waiting on the row', async () => {
    duesRow = { id: 'dues-row', paid_at: '2026-09-10T00:00:00Z', amount_cents: 4000 };
    expect(await refusal(checkFeeSubmission(client(), ME, forDues()))).toMatch(/already settled/);
    duesRow = { id: 'dues-row', paid_at: null, amount_cents: 4000 };
    pendingFor = 'dues-row';
    expect(await refusal(checkFeeSubmission(client(), ME, forDues()))).toMatch(/already have a submission waiting/);
    pendingFor = null;
    await expect(checkFeeSubmission(client(), ME, forDues())).resolves.toMatchObject({ duesSeasonId: SEASON_ID });
  });

  it('writes nothing', async () => {
    await checkFeeSubmission(client(), ME, forDues());
    expect(inserts).toEqual([]);
  });
});
