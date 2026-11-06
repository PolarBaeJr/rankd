// F-018. The reminder job's failure mode is a SILENT PERMANENT DROP: it claimed
// session_rsvp.reminded_at and then sent, so anything that threw in between
// left a row saying "reminded" for a player nobody reminded, with no trace to
// find it by. apps/bot/src/session-pings.ts does the same job for Discord and
// has always done it the other way round, with a comment explaining exactly
// this — the app was the outlier.
//
// 00186 splits the claim (reminder_attempted_at) from the receipt
// (reminded_at). These tests pin the three properties that split has to have:
// a crash leaves no receipt, a stale claim is retried, and two concurrent ticks
// still cannot both notify.
//
// 00194/00195 add the end of that retry. Without a cap an RSVP whose send fails
// for a reason that will not fix itself is re-claimed every fifteen minutes
// until the session starts, reporting the same claimed-but-not-notified split
// on every tick with nothing accumulating that anyone could alert on. The claim
// is now one statement in the database, so the fake below models the RPC rather
// than the UPDATE — and models it the way the SQL behaves, including that a row
// at the cap is retired instead of claimed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { utcToClubWallClock } from '@badminton/shared';

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const remindSessionGoers = vi.fn();
vi.mock('@/lib/session-reminders', () => ({
  remindSessionGoers: (...a: unknown[]) => remindSessionGoers(...a),
}));

interface Rsvp {
  session_id: string;
  player_id: string;
  intent: string;
  reminded_at: string | null;
  reminder_attempted_at: string | null;
  reminder_attempts: number;
  reminder_failed_at: string | null;
}

const SESSION_ID = 'sess-1';
let rsvps: Rsvp[];
let rpcError: string | null = null;

// Start time far enough out that every player's lead has come due but the
// session has not begun — both gates the job applies before it claims anything.
const START = new Date(Date.now() + 30 * 60_000);
const pad = (n: number) => n.toString().padStart(2, '0');
const sessionRow = () => ({
  id: SESSION_ID,
  // The job converts these as CLUB-LOCAL wall clock, so build them from the
  // club-local rendering of START rather than from its UTC fields. The app's
  // own rendering, not Intl's: from 2026-11-01 the club is pinned at UTC-7,
  // and a runtime with older tzdata still answers UTC-8, which put the session
  // an hour outside the job's window.
  ...(() => {
    const [date, time] = utcToClubWallClock(START.toISOString()).split('T');
    return { date: date!, start_time: `${time}:00` };
  })(),
  session_rsvp: rsvps.filter((r) => r.session_id === SESSION_ID),
});

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({
    // claim_session_reminders (00195). Modelled on the SQL, not on what the
    // route wants back: the same WHERE clause, the same increment, and the same
    // decision that a row already at the cap is RETIRED by this call rather
    // than claimed by it.
    rpc: async (fn: string, args: {
      p_session_id: string; p_player_ids: string[];
      p_stale_before: string; p_max_attempts: number;
    }) => {
      if (fn !== 'claim_session_reminders') throw new Error(`unexpected rpc ${fn}`);
      if (rpcError) return { data: null, error: { message: rpcError } };
      const now = new Date().toISOString();
      const hit = rsvps.filter((r) =>
        r.session_id === args.p_session_id &&
        args.p_player_ids.includes(r.player_id) &&
        r.intent === 'going' &&
        r.reminded_at === null &&
        r.reminder_failed_at === null &&
        (r.reminder_attempted_at === null || r.reminder_attempted_at < args.p_stale_before));
      const out: { player_id: string; gave_up: boolean }[] = [];
      for (const r of hit) {
        if (r.reminder_attempts >= args.p_max_attempts) {
          r.reminder_failed_at = now;
          out.push({ player_id: r.player_id, gave_up: true });
        } else {
          r.reminder_attempted_at = now;
          r.reminder_attempts += 1;
          out.push({ player_id: r.player_id, gave_up: false });
        }
      }
      return { data: out, error: null };
    },
    from(table: string) {
      if (table === 'sessions') {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.gte = () => q;
        q.lte = () => q;
        q.eq = () => Promise.resolve({ data: [sessionRow()], error: null });
        return q;
      }
      if (table === 'players') {
        // No stored preferences: every player takes the default lead.
        return {
          select: () => ({
            in: async (_c: string, ids: string[]) => ({
              data: ids.map((id) => ({ id, notification_preferences: {} })),
              error: null,
            }),
          }),
        };
      }
      if (table === 'session_rsvp') {
        return {
          update: (patch: Partial<Rsvp>) => {
            const preds: ((r: Rsvp) => boolean)[] = [];
            const q: Record<string, unknown> = {};
            q.eq = (c: keyof Rsvp, v: unknown) => { preds.push((r) => r[c] === v); return q; };
            q.in = (c: keyof Rsvp, v: unknown[]) => { preds.push((r) => v.includes(r[c])); return q; };
            q.is = (c: keyof Rsvp, v: null) => { preds.push((r) => r[c] === v); return q; };
            // `or('a.is.null,a.lt.<iso>')` — the crashed-claim predicate.
            q.or = (expr: string) => {
              const col = expr.split('.')[0] as keyof Rsvp;
              const cutoff = expr.split('.lt.')[1]!;
              preds.push((r) => r[col] === null || (r[col] as string) < cutoff);
              return q;
            };
            const apply = () => {
              const hit = rsvps.filter((r) => preds.every((p) => p(r)));
              for (const r of hit) Object.assign(r, patch);
              return hit;
            };
            q.select = () =>
              Promise.resolve({ data: apply().map((r) => ({ player_id: r.player_id })), error: null });
            // The receipt write has no .select(); it is awaited directly.
            q.then = (res: (v: unknown) => unknown) => {
              apply();
              return Promise.resolve({ error: null }).then(res);
            };
            return q;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { POST } = await import('@/app/api/cron/session-reminders/route');

const SECRET = 'test-cron-secret';
const run = () =>
  POST(new Request('https://console.example/admin/api/cron/session-reminders', {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
  }));

const rsvp = (player_id: string, over: Partial<Rsvp> = {}): Rsvp => ({
  session_id: SESSION_ID, player_id, intent: 'going',
  reminded_at: null, reminder_attempted_at: null,
  reminder_attempts: 0, reminder_failed_at: null, ...over,
});
const find = (id: string) => rsvps.find((r) => r.player_id === id)!;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  rsvps = [rsvp('p1'), rsvp('p2')];
  rpcError = null;
  remindSessionGoers.mockReset();
  remindSessionGoers.mockImplementation(async (_s: string, _a: null, ids: string[]) => ({
    notified: ids.length, delivered: ids,
  }));
  void pad;
});

describe('reminder claim and receipt (F-018)', () => {
  it('claims, sends, then writes the receipt', async () => {
    const res = await run();
    expect(res.status).toBe(200);

    expect(remindSessionGoers).toHaveBeenCalledTimes(1);
    expect(remindSessionGoers.mock.calls[0]![2]).toEqual(['p1', 'p2']);
    for (const id of ['p1', 'p2']) {
      expect(find(id).reminder_attempted_at).not.toBeNull();
      expect(find(id).reminded_at).not.toBeNull();
    }
  });

  it('leaves NO receipt when the send throws, so the player is still owed one', async () => {
    remindSessionGoers.mockRejectedValueOnce(new Error('push service down'));

    const res = await run();
    // The job as a whole reports the failure...
    expect(res.status).toBe(500);
    // ...and, crucially, nobody is marked reminded. Under the old scheme both
    // rows carried a reminded_at here and were never reminded again.
    expect(find('p1').reminded_at).toBeNull();
    expect(find('p2').reminded_at).toBeNull();
    // The claim IS stamped — that is what stops a concurrent tick double-sending.
    expect(find('p1').reminder_attempted_at).not.toBeNull();
  });

  it('retries a claim that never grew a receipt, once it is stale', async () => {
    // A tick 20 minutes ago claimed and died. Past the 15-minute window.
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    rsvps = [rsvp('p1', { reminder_attempted_at: stale })];

    await run();

    expect(remindSessionGoers.mock.calls[0]![2]).toEqual(['p1']);
    expect(find('p1').reminded_at).not.toBeNull();
  });

  it('does not touch a claim that is still in flight', async () => {
    // Claimed one minute ago. Another tick is very likely mid-send.
    rsvps = [rsvp('p1', { reminder_attempted_at: new Date(Date.now() - 60_000).toISOString() })];

    const res = await run();

    expect(res.status).toBe(200);
    expect(remindSessionGoers).not.toHaveBeenCalled();
    expect(find('p1').reminded_at).toBeNull();
  });

  it('never re-reminds somebody who already has a receipt', async () => {
    rsvps = [rsvp('p1', { reminded_at: new Date().toISOString(), reminder_attempted_at: new Date(0).toISOString() })];

    await run();

    expect(remindSessionGoers).not.toHaveBeenCalled();
  });

  it('writes receipts only for the players delivery actually reached', async () => {
    // The in-app insert committed for p1 and not p2 — notifyPlayers reports
    // that now instead of returning the count it was asked for.
    remindSessionGoers.mockResolvedValueOnce({ notified: 1, delivered: ['p1'] });

    await run();

    expect(find('p1').reminded_at).not.toBeNull();
    expect(find('p2').reminded_at).toBeNull();
    // p2 keeps its claim, so it is retried once the window passes rather than
    // being dropped — the whole point of the split.
    expect(find('p2').reminder_attempted_at).not.toBeNull();
  });
});

// The end of the retry (00194, 00195). 00186 made a crashed claim retryable
// after fifteen minutes, which is what stopped a crash being a permanent silent
// drop — and left it running for ever.
describe('reminder retry is bounded (F-018)', () => {
  const stale = () => new Date(Date.now() - 20 * 60_000).toISOString();

  it('stops claiming an RSVP once the attempt cap is reached, and says so once', async () => {
    const Sentry = await import('@sentry/nextjs');
    rsvps = [rsvp('p1', { reminder_attempts: 5, reminder_attempted_at: stale() })];
    remindSessionGoers.mockImplementation(async () => ({ notified: 0, delivered: [] }));

    const res = await run();
    const body = await res.json();

    // Retired by this call, not claimed by it — nobody was asked to notify.
    expect(remindSessionGoers).not.toHaveBeenCalled();
    expect(find('p1').reminder_failed_at).not.toBeNull();
    expect(body.results[0].gave_up).toBe(1);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('never looks at a retired RSVP again, however many ticks run', async () => {
    const Sentry = await import('@sentry/nextjs');
    rsvps = [rsvp('p1', { reminder_attempts: 5, reminder_attempted_at: stale() })];
    await run();
    vi.clearAllMocks();

    // The alert fires at the moment it becomes terminal and never again — an
    // every-fifteen-minutes alert is the same as no alert.
    const res = await run();
    expect(remindSessionGoers).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect((await res.json()).sessions).toBe(0);
  });

  it('counts every claim, so a repeatedly crashing send converges on the cap', async () => {
    rsvps = [rsvp('p1')];
    // Delivery never lands: claimed each time, receipt never written.
    remindSessionGoers.mockImplementation(async () => ({ notified: 0, delivered: [] }));

    await run();
    expect(find('p1').reminder_attempts).toBe(1);

    // Each later tick has to find the claim stale, which is 00186's window.
    for (let i = 2; i <= 5; i += 1) {
      find('p1').reminder_attempted_at = stale();
      await run();
      expect(find('p1').reminder_attempts).toBe(i);
    }

    expect(find('p1').reminder_failed_at).toBeNull();
    find('p1').reminder_attempted_at = stale();
    await run();
    // Sixth tick: the cap is already reached, so this one retires it.
    expect(find('p1').reminder_failed_at).not.toBeNull();
    expect(find('p1').reminder_attempts).toBe(5);
  });

  it('a delivered reminder is never retried, whatever the attempt count says', async () => {
    rsvps = [rsvp('p1', { reminder_attempts: 1, reminder_attempted_at: stale(),
      reminded_at: new Date().toISOString() })];

    await run();

    // The receipt is the only thing that means "reminded". The counter bounds
    // the retry; it does not decide whether one is owed.
    expect(remindSessionGoers).not.toHaveBeenCalled();
    expect(find('p1').reminder_failed_at).toBeNull();
  });

  it('fails the run rather than sending unclaimed when the claim errors', async () => {
    rsvps = [rsvp('p1')];
    rpcError = 'deadlock detected';

    const res = await run();

    expect(remindSessionGoers).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
