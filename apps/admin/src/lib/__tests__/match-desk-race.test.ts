import { describe, it, expect, beforeEach, vi } from 'vitest';

// THE DESK'S WRITES MUST NOT LAND ON A ROW THAT MOVED UNDER THEM.
//
// setMatchLive and setMatchCourt both read the match, reason carefully about what
// they read, and then issued an UPDATE keyed on the id alone. Everything the
// guard established was true of a row that had already been replaced by the time
// the write ran:
//
//   * Start/Undo refuses 'completed', 'walkover', 'voided' and 'disputed'. Two
//     execs on the Court Management tab — one presses Start, the other submits
//     that match's score — and the unguarded UPDATE stomps 'completed' back to
//     'live' while the score rows and the bracket advancement stay applied. The
//     match reappears as if still on court with the next round already filled in.
//   * The audit row then records `previous_status` from the STALE read, so the
//     log asserts a transition that never happened — worse than no row at all,
//     because it is the artefact somebody reconstructs the day from.
//   * setMatchCourt has the same shape: it reads `court`, decides the change is
//     not a no-op, and overwrites whatever the other desk typed in between.
//
// THE ASSERTIONS ARE ON THE SURVIVING ROW AND ON THE AUDIT LOG, never on "it
// threw". A refusal that still overwrote, or that refused and logged anyway,
// would pass a throw-only test and leave both defects in place.
//
// The interleaving is MODELLED, not asserted about by string: `beforeUpdate` runs
// inside the fake client at the instant between the action's read and its write,
// which is exactly where the other desk's commit lands in production.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert';

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  /** Runs just before an UPDATE is applied — models the other desk winning. */
  beforeUpdate: null as null | ((ctx: { table: string; payload: Row }) => void),
  /** A database older than 00273: tournament_courts answers PGRST205. */
  courtsMissing: false,
  /** The next UPDATE fails with this instead of landing (a constraint refusing it). */
  updateError: null as null | { code: string; message: string },
}));

const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    // `.eq(col, null)` compiles to `col=eq.null` in PostgREST and matches NOTHING,
    // which is why the two predicate kinds are tracked separately here. A fake
    // that folded them together would let a guard written as `.eq('court', null)`
    // pass in this file and turn every court-clear into a spurious conflict in
    // production — the exact class of mistake these tests exist to catch.
    const eqFilters: Array<[string, unknown]> = [];
    const isFilters: Array<[string, unknown]> = [];
    let op: Op = 'select';
    let payload: Row = {};

    const matching = () =>
      (store.db[table] ?? []).filter(
        (r) =>
          eqFilters.every(([c, v]) => v !== null && r[c] === v) &&
          isFilters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)),
      );

    const run = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
      if (table === 'tournament_courts' && store.courtsMissing) {
        return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.tournament_courts' in the schema cache" } };
      }
      if (op === 'update' && store.updateError) {
        const error = store.updateError;
        store.updateError = null;
        return { data: null, error };
      }
      if (op === 'insert') {
        const row = { id: `row-${++store.seq}`, ...payload };
        (store.db[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        store.beforeUpdate?.({ table, payload });
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      // Detached copies: PostgREST returns JSON, not a live handle on the row.
      return { data: matching().map((r) => ({ ...r })), error: null };
    };

    const api = {
      select() { return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      update(p: Row) { op = 'update'; payload = p; return api; },
      eq(c: string, v: unknown) { eqFilters.push([c, v]); return api; },
      is(c: string, v: unknown) { isFilters.push([c, v]); return api; },
      async single() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      async maybeSingle() {
        const res = run();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }
  return { from: (table: string) => query(table) };
});

vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
// The whole internal helper module: requireCapability, the suspension gate and
// the revalidate calls are all beside the point here, and _internal drags in
// next/cache plus the entire shared barrel.
vi.mock('../tournament-actions/_internal', () => ({
  requireCapability: async () => ({ id: 'admin-1', role: 'admin' }),
  revalidateEventPaths: () => {},
  assertTournamentNotSuspended: async () => {},
}));
// The REAL audit shape, writing into the same fake db, so the rows asserted on
// below are the rows the action actually produces.
vi.mock('../audit', () => ({
  logAudit: async (client: { from: (t: string) => { insert: (r: Row) => unknown } }, entry: Row) => {
    await client.from('tournament_audit_log').insert(entry);
  },
}));

import { groupsThenTopKnockout } from '@badminton/shared';
import { setMatchLive, setMatchCourt } from '../tournament-actions/scheduling';

const TOURNAMENT = 'tourn-1';
const EVENT = 'event-1';
const MATCH = 'match-1';

const match = () => store.db.tournament_matches!.find((r) => r.id === MATCH)!;
const auditRows = (action?: string) =>
  (store.db.tournament_audit_log ?? []).filter((r) => !action || r.action === action);

function seedMatch(extra: Row = {}) {
  store.db.tournament_matches = [{
    id: MATCH,
    status: 'ready',
    is_bye: false,
    court: null,
    event_id: EVENT,
    participant_a_id: 'entry-a',
    participant_b_id: 'entry-b',
    pair_a_id: null,
    pair_b_id: null,
    updated_at: '2026-08-01T00:00:00.000Z',
    // The action selects `event:tournament_events(tournament_id)` as an embed, so
    // the fake row carries the embedded object rather than a joinable table.
    event: { tournament_id: TOURNAMENT },
    ...extra,
  }];
}

/** The other desk's score submission, committed between our read and our write. */
function otherDeskCompletes() {
  store.beforeUpdate = ({ table }) => {
    if (table !== 'tournament_matches') return;
    store.beforeUpdate = null;
    const row = match();
    row.status = 'completed';
    row.winner_participant_id = 'entry-a';
  };
}

beforeEach(() => {
  store.seq = 0;
  store.beforeUpdate = null;
  store.courtsMissing = false;
  store.updateError = null;
  store.db = { tournament_matches: [], tournament_audit_log: [], tournament_courts: [] };
  seedMatch();
});

describe('setMatchLive', () => {
  // The ordinary path, which must stay open — every guard below is worthless if
  // calling a match onto court stops working.
  it('starts a ready match and audits the transition it actually made', async () => {
    const res = await setMatchLive(MATCH, true);

    expect(res.ok).toBe(true);
    expect(match().status).toBe('live');
    expect(auditRows('match_started')).toHaveLength(1);
    expect((auditRows('match_started')[0]!.details as Row).previous_status).toBe('ready');
  });

  it('takes a live match back off court', async () => {
    seedMatch({ status: 'live' });

    const res = await setMatchLive(MATCH, false);

    expect(res.ok).toBe(true);
    expect(match().status).toBe('ready');
    expect(auditRows('match_start_undone')).toHaveLength(1);
  });

  // THE REPORTED DEFECT. The guard above the write read 'ready' and was right to
  // let it through; by the time the UPDATE ran the match was 'completed'.
  it('refuses to start a match that was completed between the read and the write', async () => {
    otherDeskCompletes();

    const res = await setMatchLive(MATCH, true);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/changed while you were looking at it/i);
    // The result survives, and so does everything the bracket derived from it.
    expect(match().status).toBe('completed');
    expect(match().winner_participant_id).toBe('entry-a');
    // And no log entry claiming a transition out of 'ready' that never happened.
    expect(auditRows()).toHaveLength(0);
  });

  // The same race in the other direction: Undo, against a match somebody has
  // just finished. 'live' -> 'ready' would un-complete it just as thoroughly.
  it('refuses to undo a start when the match was completed in the meantime', async () => {
    seedMatch({ status: 'live' });
    otherDeskCompletes();

    const res = await setMatchLive(MATCH, false);

    expect(res.ok).toBe(false);
    expect(match().status).toBe('completed');
    expect(auditRows()).toHaveLength(0);
  });

  // The guards that were already correct, kept honest: this file now owns the
  // write, so it owns the refusals that decide whether the write is reached.
  it('still refuses an already-decided match up front', async () => {
    seedMatch({ status: 'completed' });

    const res = await setMatchLive(MATCH, true);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/completed/i);
    expect(auditRows()).toHaveLength(0);
  });

  it('is idempotent in both directions without writing anything', async () => {
    seedMatch({ status: 'live' });
    expect((await setMatchLive(MATCH, true)).ok).toBe(true);
    expect(match().status).toBe('live');

    seedMatch({ status: 'ready' });
    expect((await setMatchLive(MATCH, false)).ok).toBe(true);
    expect(match().status).toBe('ready');

    expect(auditRows()).toHaveLength(0);
  });
});

describe('setMatchCourt', () => {
  // Naming a court where there was none is the COMMON case and it exercises the
  // null branch of the guard. `.eq('court', null)` would match no row here and
  // turn this into a permanent, inexplicable refusal.
  it('names a court on a match that had none', async () => {
    const res = await setMatchCourt(MATCH, '3');

    expect(res.ok).toBe(true);
    expect(match().court).toBe('3');
    expect(auditRows('match_court_set')).toHaveLength(1);
  });

  it('clears a court back to unassigned', async () => {
    seedMatch({ court: '3' });

    const res = await setMatchCourt(MATCH, '');

    expect(res.ok).toBe(true);
    expect(match().court).toBeNull();
    expect(auditRows('match_court_cleared')).toHaveLength(1);
  });

  it('moves a match from one court to another', async () => {
    seedMatch({ court: '3' });

    const res = await setMatchCourt(MATCH, '7');

    expect(res.ok).toBe(true);
    expect(match().court).toBe('7');
  });

  // The same read-then-write shape as Start: two execs typing a court on the same
  // row, and the loser used to overwrite the winner while auditing a
  // `previous_court` that had not been there for some time.
  it('refuses to overwrite a court another desk set in the meantime', async () => {
    store.beforeUpdate = ({ table }) => {
      if (table !== 'tournament_matches') return;
      store.beforeUpdate = null;
      match().court = '11';
    };

    const res = await setMatchCourt(MATCH, '3');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/changed while you were looking at it/i);
    expect(match().court).toBe('11');
    expect(auditRows()).toHaveLength(0);
  });

  it('refuses to clear a court another desk changed in the meantime', async () => {
    seedMatch({ court: '3' });
    store.beforeUpdate = ({ table }) => {
      if (table !== 'tournament_matches') return;
      store.beforeUpdate = null;
      match().court = '11';
    };

    const res = await setMatchCourt(MATCH, '');

    expect(res.ok).toBe(false);
    expect(match().court).toBe('11');
    expect(auditRows()).toHaveLength(0);
  });
});

// A TOURNAMENT'S OWN COURTS (00273). Without any, the text path above is
// unchanged; with them, the desk may only name one, and the match is linked.
describe('courts of the tournament', () => {
  function seedCourts() {
    store.db.tournament_courts = [
      { id: 'court-3', tournament_id: TOURNAMENT, label: 'Court 3', sort_order: 1, active: true, notes: null },
      { id: 'court-4', tournament_id: TOURNAMENT, label: '4', sort_order: 2, active: false, notes: null },
    ];
  }

  it('keeps the free text when the database has no courts table yet', async () => {
    store.courtsMissing = true;

    const res = await setMatchCourt(MATCH, '9');

    expect(res.ok).toBe(true);
    expect(match().court).toBe('9');
    // A database before 00273 has no court_id, so the write must not name it.
    expect('court_id' in match()).toBe(false);
  });

  it('resolves "3" to Court 3 and links the match', async () => {
    seedCourts();

    const res = await setMatchCourt(MATCH, '3');

    expect(res.ok).toBe(true);
    expect(match().court).toBe('Court 3');
    expect(match().court_id).toBe('court-3');
    expect((auditRows('match_court_set')[0]!.details as Row).court_id).toBe('court-3');
  });

  it('refuses a court the tournament does not have, and one switched off', async () => {
    seedCourts();

    for (const name of ['9', '4']) {
      const res = await setMatchCourt(MATCH, name);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.error).toBe(`Court ${name} is not one of this tournament's courts. Add it on the tournament page.`);
    }
    expect(match().court).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });

  it('clears both the text and the link', async () => {
    seedCourts();
    seedMatch({ court: 'Court 3', court_id: 'court-3' });

    const res = await setMatchCourt(MATCH, '');

    expect(res.ok).toBe(true);
    expect(match().court).toBeNull();
    expect(match().court_id).toBeNull();
  });

  it('names the court when a live match is moved onto a busy one', async () => {
    seedCourts();
    seedMatch({ status: 'live' });
    store.updateError = { code: '23505', message: 'duplicate key value violates unique constraint "tournament_matches_one_live_per_court"' };

    const res = await setMatchCourt(MATCH, '3');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('Court 3 already has a match on it. Finish or take that match off court first.');
    expect(auditRows()).toHaveLength(0);
  });

  it('names the court when Start finds another match live on it', async () => {
    seedMatch({ court: 'Court 3', court_id: 'court-3' });
    store.updateError = { code: '23505', message: 'duplicate key value violates unique constraint "tournament_matches_one_live_per_court"' };

    const res = await setMatchLive(MATCH, true);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('Court 3 already has a match on it. Finish or take that match off court first.');
    expect(match().status).toBe('ready');
    expect(auditRows()).toHaveLength(0);
  });
});

// A STAGED MATCH STAYS ON ITS STAGE'S COURTS after the draw: group A on court 1,
// group B on court 2, the knockout on its own list.
describe('the courts of a staged match\'s stage', () => {
  const groups = groupsThenTopKnockout({ pools: 2, courts: [['1'], ['2']] });
  const withKnockout = {
    ...groups,
    stages: groups.stages.map((s) => (s.kind === 'knockout' ? { ...s, courts: ['3', '4'] } : s)),
  };
  const stagedEvent = (cfg: unknown) => ({ tournament_id: TOURNAMENT, format: 'staged', format_config: cfg });

  function seedCourts() {
    store.db.tournament_courts = [1, 2, 3, 4].map((n) => (
      { id: `court-${n}`, tournament_id: TOURNAMENT, label: `Court ${n}`, sort_order: n, active: true, notes: null }
    ));
  }

  it('refuses a group 1 match on court 2, writing nothing, and takes court 1', async () => {
    seedCourts();
    seedMatch({ stage: 1, pool_number: 1, event: stagedEvent(groups) });

    const refused = await setMatchCourt(MATCH, '2');
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.error).toBe("Court 2 is not one of this group's courts. Use Court 1.");
    expect(match().court).toBeNull();
    expect(auditRows()).toHaveLength(0);

    const res = await setMatchCourt(MATCH, '1');
    expect(res.ok).toBe(true);
    expect(match().court).toBe('Court 1');
    expect(match().court_id).toBe('court-1');
  });

  it('keeps a knockout match to its listed courts', async () => {
    seedCourts();
    seedMatch({ stage: 2, pool_number: null, event: stagedEvent(withKnockout) });

    const refused = await setMatchCourt(MATCH, '1');
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.error).toBe("Court 1 is not one of this stage's courts. Use Courts 3, 4.");

    expect((await setMatchCourt(MATCH, '4')).ok).toBe(true);
    expect(match().court_id).toBe('court-4');
  });

  it('lets a knockout with no list take any court', async () => {
    seedCourts();
    seedMatch({ stage: 2, pool_number: null, event: stagedEvent(groups) });

    expect((await setMatchCourt(MATCH, '2')).ok).toBe(true);
  });

  it('always allows clearing the court', async () => {
    seedCourts();
    seedMatch({ stage: 1, pool_number: 1, court: 'Court 2', court_id: 'court-2', event: stagedEvent(groups) });

    const res = await setMatchCourt(MATCH, '');
    expect(res.ok).toBe(true);
    expect(match().court).toBeNull();
  });

  it('holds a free-text tournament to the same rule', async () => {
    seedMatch({ stage: 1, pool_number: 2, event: stagedEvent(groups) });

    const refused = await setMatchCourt(MATCH, 'Court 1');
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.error).toBe("Court 1 is not one of this group's courts. Use Court 2.");

    expect((await setMatchCourt(MATCH, 'court 2')).ok).toBe(true);
    expect(match().court).toBe('court 2');
  });
});
