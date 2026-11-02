import { describe, it, expect, beforeEach, vi } from 'vitest';

// THE FIVE ELIGIBILITY REFUSALS 00196 MOVED INSIDE THE LOCK.
//
// enter_tournament_event now decides suspension, tournament status, membership,
// the member's own ban and pair membership under the locks the entry is decided
// under, instead of trusting reads the caller took hundreds of milliseconds
// earlier. That half is the database's and was exercised directly against
// staging — every gate, plus a two-session probe showing an entry genuinely
// queues behind the field lock.
//
// THIS FILE PINS THE OTHER HALF. Each of those refusals is permanent: the
// tournament was archived, the member was banned, the exec paired them. Falling
// through to the default arm turns every one of them into "please try again
// shortly", which is an instruction the member can follow forever and an
// instruction that will never work. The regression is silent — the entry is
// correctly refused either way — so nothing but a test catches it.

const store = vi.hoisted(() => ({
  rpcResult: {} as Record<string, unknown>,
  event: {} as Record<string, unknown>,
  rpcCalls: 0,
  // This season's club fee rows (00260). Paid by default, so every test above
  // the membership section reaches the switch it is about.
  dues: [] as Record<string, unknown>[],
  duesError: null as { message: string } | null,
  activeSeason: { id: 's-active' } as Record<string, unknown> | null,
  player: {} as Record<string, unknown>,
  // An RPC that PostgREST does not know: the 00278 functions before the migration.
  rpcError: null as { code: string; message: string } | null,
}));

vi.mock('../supabase-server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createServiceRoleClient: () => ({
    rpc: () => {
      store.rpcCalls += 1;
      return Promise.resolve(store.rpcError ? { data: null, error: store.rpcError } : { data: store.rpcResult, error: null });
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self; chain.eq = self; chain.or = self; chain.limit = self;
      chain.in = self; chain.is = self; chain.not = self; chain.order = self;
      if (table === 'club_fees') {
        chain.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: store.duesError ? null : store.dues, error: store.duesError }).then(resolve);
      }
      chain.insert = () => Promise.resolve({ error: null });
      chain.upsert = () => Promise.resolve({ error: null });
      chain.update = self;
      chain.maybeSingle = () => Promise.resolve({
        data: table === 'tournament_events' ? store.event
          : table === 'ratings' ? { singles_elo: 1000, doubles_elo: 1000 }
          : table === 'seasons' ? store.activeSeason
          : null,
        error: null,
      });
      chain.single = () => Promise.resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

vi.mock('../actions/_shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requirePlayer: () => Promise.resolve(store.player),
  assertCurrentWaiver: () => Promise.resolve(),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Map()) }));

const { registerForEvent, joinEventWaitlist, leaveEventWaitlist } = await import('../tournament-actions');

beforeEach(() => {
  store.rpcCalls = 0;
  store.rpcError = null;
  store.duesError = null;
  store.activeSeason = { id: 's-active' };
  store.player = {
    id: 'p1', is_banned: false, membership_type: 'internal', competition_category: 'mens',
    is_exec: false, fee_exempt: false,
  };
  store.dues = [{ player_id: 'p1', paid_at: '2026-09-01T00:00:00Z' }];
  // An event whose every app-side gate PASSES. That is the whole point: the
  // only way to reach the switch arms below is for the application's copy of a
  // fact and the database's copy to disagree, which is the race 00196 closes.
  store.event = {
    id: 'e1',
    status: 'registration',
    event_type: 'open_singles',
    tournament_id: 't1',
    max_participants: 32,
    tournament: {
      status: 'active',
      suspended_at: null,
      suspension_reason: null,
      waiver_text: null,
      allowed_memberships: ['internal', 'alumni', 'external'],
      season_id: 's1',
    },
  };
});

describe('every eligibility refusal reaches the member as its own sentence', () => {
  const CASES: Array<[string, Record<string, unknown>, RegExp]> = [
    ['tournament_suspended', { suspension_reason: 'gym flooded' }, /suspended: gym flooded/],
    // The reason is optional, and the sentence has to survive its absence
    // rather than rendering "suspended: null".
    ['tournament_suspended', {}, /currently suspended$/],
    ['tournament_closed', { status: 'archived' }, /has been archived, so you cannot enter this event/],
    ['membership_not_allowed', { allowed: ['alumni'] }, /Alumni members only/],
    // 00260: the club fee was marked unpaid between the screen and the lock.
    ['membership_unpaid', { allowed: ['internal'] }, /Internal means this season's club fee is paid/],
    ['player_suspended', {}, /account is suspended/],
    ['already_in_pair', {}, /already in a pair/],
  ];

  for (const [reason, extra, sentence] of CASES) {
    it(`${reason}${Object.keys(extra).length ? ` (${Object.keys(extra).join(', ')})` : ''} is not the generic retry`, async () => {
      store.rpcResult = { ok: false, reason, ...extra };
      const r = await registerForEvent('e1');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(sentence);
        // The default arm. A reason the switch forgets lands here, and the
        // member is told to retry something that will never succeed.
        expect(r.error).not.toMatch(/try again shortly/);
      }
    });
  }

  // The control. Without this the assertions above would still pass if the
  // switch had been replaced by a single catch-all sentence.
  it('still falls through to the retry message for a reason nobody has written yet', async () => {
    store.rpcResult = { ok: false, reason: 'something_invented_later' };
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/try again shortly/);
  });
});

// ===========================================================================
// THE COMPETITION CATEGORY, RE-ASKED UNDER THE LOCK (00200)
// ===========================================================================
//
// competition_category is writable from exactly one place — the console — and
// the member's own screen reads it hundreds of milliseconds before the entry
// lands. So this is the one eligibility fact the app-side gate could never win
// a race on, and until 00200 enter_tournament_event never asked again.
//
// The event here is gendered and the member's declared category MATCHES it, so
// screenSelfEntry passes and the switch below is genuinely reachable. That is
// the whole shape of the race: an exec changed the answer in between.
describe('the category refusals the database now makes', () => {
  beforeEach(() => { store.event.event_type = 'mens_singles'; });

  it('undeclared reaches the member as the Settings remedy, not a retry', async () => {
    store.rpcResult = { ok: false, reason: 'category_undeclared', event_type: 'mens_singles' };
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Set your Gender in Settings/);
      expect(r.error).toMatch(/enter an Open event instead/i);
      expect(r.error).not.toMatch(/try again shortly/);
    }
  });

  it('mismatch reaches the member as the exec remedy, not a retry', async () => {
    store.rpcResult = { ok: false, reason: 'category_mismatch', event_type: 'mens_singles' };
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/not open to your declared Gender/);
      expect(r.error).toMatch(/ask an exec/);
      expect(r.error).not.toMatch(/try again shortly/);
    }
  });

  // THE SENTENCE HAS ONE SOURCE. If the switch arms above ever grow their own
  // wording, a member who loses the race reads something different from one who
  // never entered it — for the same refusal, about the same event. Comparing
  // against screenSelfEntry is what makes that impossible to do quietly.
  it('says exactly what the member would have read without the race', async () => {
    const { screenSelfEntry } = await import('@badminton/shared');

    const undeclared = screenSelfEntry('mens_singles', null);
    store.rpcResult = { ok: false, reason: 'category_undeclared' };
    const a = await registerForEvent('e1');
    expect(undeclared.ok).toBe(false);
    if (!a.ok && !undeclared.ok) expect(a.error).toBe(undeclared.message);

    const mismatch = screenSelfEntry('mens_singles', 'womens');
    store.rpcResult = { ok: false, reason: 'category_mismatch' };
    const b = await registerForEvent('e1');
    expect(mismatch.ok).toBe(false);
    if (!b.ok && !mismatch.ok) expect(b.error).toBe(mismatch.message);
  });

  // The refusal must be built from the EVENT, not from anything the function
  // sends back about the member. A fence that returned the member's category
  // would undo the disclosure property screenSelfEntry's own comment describes,
  // and the first sign of it would be a sentence that changes when the payload
  // does.
  it('ignores a category the database has no business returning', async () => {
    store.rpcResult = { ok: false, reason: 'category_mismatch', competition_category: 'womens' };
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toMatch(/women/i);
  });
});

// ===========================================================================
// INTERNAL MEANS THIS SEASON'S CLUB FEE IS PAID (00260)
// ===========================================================================
//
// The screen before the RPC. The stored membership_type is a member's own pick
// in Discord (00221), so it no longer decides entry on its own: the dues row
// does. These pin that the action refuses BEFORE calling the database, with
// the sentence that tells the member what to do.
describe('the club-fee membership screen', () => {
  const internalOnly = () => {
    (store.event.tournament as Record<string, unknown>).allowed_memberships = ['internal'];
  };
  beforeEach(() => { store.rpcResult = { ok: true }; });

  it('refuses an unpaid internal member from an internal-only event, before the RPC', async () => {
    internalOnly();
    store.dues = [];
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Internal means this season's club fee is paid/);
    expect(store.rpcCalls).toBe(0);
  });

  it('does not count an unpaid dues row as paid', async () => {
    internalOnly();
    store.dues = [{ player_id: 'p1', paid_at: null }];
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    expect(store.rpcCalls).toBe(0);
  });

  it('admits a paid member whose stored group is external', async () => {
    internalOnly();
    store.player.membership_type = 'external';
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(true);
    expect(store.rpcCalls).toBe(1);
  });

  it('admits an exec who has paid nothing', async () => {
    internalOnly();
    store.dues = [];
    store.player.is_exec = true;
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(true);
    expect(store.rpcCalls).toBe(1);
  });

  it('refuses a paid member at an alumni-only event with the not-allowed sentence', async () => {
    (store.event.tournament as Record<string, unknown>).allowed_memberships = ['alumni'];
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Alumni members only/);
      expect(r.error).not.toMatch(/club fee/);
    }
  });

  it('asks for a retry, and refuses, when the dues read fails', async () => {
    internalOnly();
    store.duesError = { message: 'boom' };
    const r = await registerForEvent('e1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/try again shortly/);
    expect(store.rpcCalls).toBe(0);
  });
});

// ===========================================================================
// THE WAITLIST (00278)
// ===========================================================================

describe('the waitlist', () => {
  it('an entry refused because others are waiting points at the waitlist', async () => {
    store.rpcResult = { ok: false, reason: 'waitlist_queue' };
    const r = await registerForEvent('e1');
    expect(r.ok === false && r.error).toBe('Others are waiting for this event, join the waitlist');
  });

  it('a full event with a waitlist points at it, and one without says only that it is full', async () => {
    store.rpcResult = { ok: false, reason: 'event_full', waitlist: true };
    const withWaitlist = await registerForEvent('e1');
    expect(withWaitlist.ok === false && withWaitlist.error).toBe('Event is full, join the waitlist');

    store.rpcResult = { ok: false, reason: 'event_full', waitlist: false };
    const without = await registerForEvent('e1');
    expect(without.ok === false && without.error).toBe('Event is full');
  });

  it('joining returns the place in the queue', async () => {
    store.rpcResult = { ok: true, waitlist_id: 'w1', position: 3, promoted: [], tournament_id: 't1' };
    const r = await joinEventWaitlist('e1');
    expect(r).toEqual({ ok: true, data: { position: 3, entered: false } });
  });

  it('joining that went straight in says so', async () => {
    store.rpcResult = {
      ok: true, waitlist_id: 'w1', position: null, tournament_id: 't1',
      promoted: [{ player_id: 'p1', participant_id: 'tp1', waitlist_id: 'w1' }],
    };
    const r = await joinEventWaitlist('e1');
    expect(r).toEqual({ ok: true, data: { position: null, entered: true } });
  });

  const CASES: Array<[string, Record<string, unknown>, RegExp]> = [
    ['waitlist_disabled', {}, /does not have a waitlist/],
    ['already_waiting', {}, /already on the waitlist/],
    ['event_has_room', {}, /has room, so you can enter it now/],
    ['entry_cap', { cap: 2 }, /already entered in 2 events at this tournament/],
    ['already_registered', { entry_status: 'withdrawn' }, /already left this event/],
    ['already_registered', { entry_status: 'registered' }, /^Already registered$/],
    ['tournament_suspended', { suspension_reason: 'gym flooded' }, /suspended: gym flooded/],
    ['already_in_pair', {}, /already in a pair/],
    ['waitlist_full', { limit: 3 }, /^The waitlist is full\.$/],
  ];
  for (const [reason, extra, sentence] of CASES) {
    it(`a join refused with ${reason} is its own sentence`, async () => {
      store.rpcResult = { ok: false, reason, ...extra };
      const r = await joinEventWaitlist('e1');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(sentence);
        expect(r.error).not.toMatch(/try again shortly/);
      }
    });
  }

  it('an unknown join refusal falls through to the retry message', async () => {
    store.rpcResult = { ok: false, reason: 'something_invented_later' };
    const r = await joinEventWaitlist('e1');
    expect(r.ok === false && r.error).toMatch(/try again shortly/);
  });

  it('says the waitlist is not available yet before the migration', async () => {
    store.rpcError = { code: '42883', message: 'function public.join_event_waitlist does not exist' };
    const joined = await joinEventWaitlist('e1');
    expect(joined.ok === false && joined.error).toBe('The waitlist is not available yet');

    store.rpcError = { code: 'PGRST202', message: 'Could not find the function public.leave_event_waitlist' };
    const left = await leaveEventWaitlist('e1');
    expect(left.ok === false && left.error).toBe('The waitlist is not available yet');
  });

  it('refuses a doubles join without the solo acknowledgement, before the RPC', async () => {
    store.event = { ...store.event, event_type: 'open_doubles' };
    const r = await joinEventWaitlist('e1');
    expect(r.ok === false && r.error).toMatch(/pair you with another member/);
    expect(store.rpcCalls).toBe(0);
  });

  it('leaving maps not_waiting, and succeeds otherwise', async () => {
    store.rpcResult = { ok: false, reason: 'not_waiting' };
    const stale = await leaveEventWaitlist('e1');
    expect(stale.ok === false && stale.error).toBe('You are not on the waitlist for this event.');

    store.rpcResult = { ok: true, tournament_id: 't1' };
    expect((await leaveEventWaitlist('e1')).ok).toBe(true);
  });
});
