// "Confirm your place" (00325). Nothing reaches a provider: the email sender is
// mocked, the database is a fake that records every RPC, and every address is
// on .invalid. What matters: the switch off asks nothing, the receipt follows
// the bell and the email, a retry does not ring the bell twice, a missing RPC
// is a skip, and the promoted are pushed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const order: string[] = [];
const sendEventConfirmationEmail = vi.fn(async (_to: string, _args: Record<string, unknown>) => {
  order.push('email');
  return emailOutcome;
});
let emailOutcome: { sent: true; providerMessageId: string | null } | { sent: false; reason: 'suppressed' | 'opted_out' };
let releaseFlags: Record<string, boolean>;
const ensureEntryFees = vi.fn(async () => []);
vi.mock('@badminton/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@badminton/shared')>()),
  sendEventConfirmationEmail,
  ensureEntryFees,
  readReleaseFlags: vi.fn(async () => releaseFlags),
  readFeatureFlags: vi.fn(async () => ({ tournaments: true })),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
const notifyPlayers = vi.fn(async (_admin: unknown, ids: string[]) => {
  order.push('notify');
  return { delivered: ids };
});
const pushPlayers = vi.fn(async () => {});
vi.mock('../notify', () => ({ notifyPlayers, pushPlayers }));

const { runEventConfirmations } = await import('../event-confirmations');

let calls: Array<{ fn: string; args: Record<string, unknown> }>;
let claimed: unknown[];
let released: unknown;
let missing: string | null;

function fakeAdmin() {
  return {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'record_event_confirmation_receipt') order.push('receipt');
      if (fn === missing) return { data: null, error: { code: 'PGRST202', message: 'not found' } };
      if (fn === 'open_event_confirmations') return { data: 1, error: null };
      if (fn === 'claim_event_confirmation_requests') return { data: claimed, error: null };
      if (fn === 'release_unconfirmed_event_entries') return { data: released, error: null };
      return { data: null, error: null };
    }),
  } as never;
}

const row = {
  confirmation_id: 'c1',
  player_id: 'p1',
  email: 'confirm-harness@example.invalid',
  first_name: 'Ann',
  tournament_id: 't1',
  tournament_name: 'Fall Open',
  event_id: 'e1',
  event_type: 'mens_singles',
  deadline_at: '2026-11-20T18:00:00Z',
  already_notified: false,
};

beforeEach(() => {
  order.length = 0;
  calls = [];
  claimed = [row];
  released = { events: [] };
  missing = null;
  releaseFlags = { entry_confirmation: true };
  emailOutcome = { sent: true, providerMessageId: 'msg-1' };
  vi.clearAllMocks();
});

const receipts = () => calls.filter((c) => c.fn === 'record_event_confirmation_receipt').map((c) => c.args);

describe('runEventConfirmations', () => {
  it('asks the database nothing while entry_confirmation is off', async () => {
    releaseFlags = { entry_confirmation: false };
    const run = await runEventConfirmations(fakeAdmin());
    expect(run.skipped).toBe('entry_confirmation_off');
    expect(calls).toEqual([]);
  });

  it('rings the bell, sends the email, then writes the receipt', async () => {
    const run = await runEventConfirmations(fakeAdmin());
    expect(order).toEqual(['notify', 'email', 'receipt']);
    expect(run).toMatchObject({ opened: 1, claimed: 1, sent: 1 });
    expect(receipts()).toEqual([{ p_id: 'c1', p_notified: true, p_outcome: 'sent', p_error: null }]);
    expect(sendEventConfirmationEmail.mock.calls[0]![1]).toMatchObject({
      url: expect.stringMatching(/\/tournaments\/t1\/events\/e1\/confirm$/),
    });
  });

  it('records a suppressed address as suppressed, never as sent', async () => {
    emailOutcome = { sent: false, reason: 'suppressed' };
    const run = await runEventConfirmations(fakeAdmin());
    expect(run.suppressed).toBe(1);
    expect(receipts()[0]).toMatchObject({ p_outcome: 'suppressed', p_error: 'suppressed' });
  });

  it('does not ring the bell again on a retry', async () => {
    claimed = [{ ...row, already_notified: true }];
    await runEventConfirmations(fakeAdmin());
    expect(notifyPlayers).not.toHaveBeenCalled();
    expect(order).toEqual(['email', 'receipt']);
    expect(receipts()[0]).toMatchObject({ p_notified: true });
  });

  it('skips while the migration is pending', async () => {
    missing = 'open_event_confirmations';
    const run = await runEventConfirmations(fakeAdmin());
    expect(run.skipped).toBe('migration_pending');
    expect(calls.map((c) => c.fn)).toEqual(['open_event_confirmations']);
  });

  it('pushes to the promoted and settles their fee', async () => {
    claimed = [];
    released = { events: [{ event_id: 'e1', tournament_id: 't1', released: 2, promoted: [{ player_id: 'p9' }] }] }; // the shape 00325 returns: a count
    const run = await runEventConfirmations(fakeAdmin());
    expect(run).toMatchObject({ released: 2, promoted: 1 });
    expect(ensureEntryFees).toHaveBeenCalledWith(expect.anything(), 't1', ['p9']);
    expect(pushPlayers).toHaveBeenCalledWith(expect.anything(), ['p9'], expect.objectContaining({ title: 'You are in' }), 'tournaments');
  });
});

describe('the cron route', () => {
  it('answers 503 without a secret and 401 with the wrong one', async () => {
    vi.doMock('@/lib/supabase-server', () => ({ createAdminClient: () => fakeAdmin() }));
    const { POST } = await import('../../app/api/cron/event-confirmations/route');
    const previous = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    expect((await POST(new Request('http://localhost/api/cron/event-confirmations', { method: 'POST' }))).status).toBe(503);
    process.env.CRON_SECRET = 'cron-secret-harness';
    const wrong = new Request('http://localhost/api/cron/event-confirmations', { method: 'POST', headers: { authorization: 'Bearer nope' } });
    expect((await POST(wrong)).status).toBe(401);
    const right = new Request('http://localhost/api/cron/event-confirmations', { method: 'POST', headers: { authorization: 'Bearer cron-secret-harness' } });
    expect((await POST(right)).status).toBe(200);
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });
});
