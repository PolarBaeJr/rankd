// SUBSTITUTIONS (00327, 00328). Who may sub: the desk (check-in and the add key
// for the discipline) or the tournament's day lead; never a court helper. The
// switch off refuses. The restriction override is an exec's alone. The person
// coming in is never entered through an entry path that counts the event's
// places: a reserve is resolved off the waitlist, an exec and a guest are
// attached directly. "Left, with a sub" is one call. The SQL itself is
// supabase/tests/00327_event_substitutions.sql and 00328_substitution_after_a_departure.sql.

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcs: [] as Array<{ name: string; args: Row }>,
  updates: [] as Array<{ table: string; payload: Row; filters: Array<[string, unknown]> }>,
  audits: [] as Row[],
  subResult: null as Row | null,
}));

const makeClient = vi.hoisted(() => () => ({
  rpc: async (name: string, args: Row) => {
    db.rpcs.push({ name, args });
    if (name === 'create_desk_guest') return { data: 'bbbbbbbb-0000-4000-8000-0000000000aa', error: null };
    return { data: db.subResult ?? { ok: true, kept: 2, moved: 3, is_pair: true, voided: [], departures: [] }, error: null };
  },
  from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let updating: Row | null = null;
    const rows = () => (db.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    const api: Record<string, unknown> = {
      select: () => api,
      in: () => api,
      limit: () => api,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return api; },
      update: (payload: Row) => { updating = payload; return api; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (updating) {
          db.updates.push({ table, payload: updating, filters: [...filters] });
          return resolve({ data: null, error: null });
        }
        return resolve({ data: rows(), error: null });
      },
    };
    return api;
  },
}));

const viewer = vi.hoisted(() => ({ id: 'aaaaaaaa-0000-4000-8000-000000000001', is_exec: false, caps: new Set<string>() }));
const flags = vi.hoisted(() => ({ off: new Set<string>() }));
const waiver = vi.hoisted(() => ({ requiredHash: null as string | null, acceptances: [] as Row[] }));
const spies = vi.hoisted(() => ({
  warnings: [] as Row[],
  notes: [] as Array<{ id: string; text: string }>,
  autoCalls: 0,
  entryPaths: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('server-only', () => ({}));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../audit', () => ({ logAudit: async (_client: unknown, row: Row) => { db.audits.push(row); } }));
vi.mock('../court-helper-gate', () => ({
  requireConsoleUser: async () => ({ viewer: { id: viewer.id, is_exec: viewer.is_exec }, level: 'exec', permissions: {} }),
}));
vi.mock('../permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions')>()),
  permits: (_level: unknown, _permissions: unknown, capability: string) => viewer.caps.has(capability),
}));
vi.mock('../release-flags', async () => {
  const { ExpectedError } = await import('@badminton/shared');
  return {
    releaseFlagOn: async (id: string) => !flags.off.has(id),
    assertReleaseFlag: async (id: string) => {
      if (flags.off.has(id)) throw new ExpectedError(`${id} is switched off`);
    },
  };
});
vi.mock('../tournament-actions/_internal', () => ({
  assertTournamentNotSuspended: async () => {},
  revalidateEventPaths: () => {},
  loadTournamentWaiverContext: async () => ({ requiredHash: waiver.requiredHash, acceptances: waiver.acceptances }),
}));
vi.mock('../attendance-warnings', () => ({
  issueAttendanceWarnings: async (_client: unknown, input: Row) => {
    spies.warnings.push(input);
    return (input.playerIds as string[]).map((playerId) => ({ playerId, warningId: `warning-${playerId}` }));
  },
}));
vi.mock('../private-notes', () => ({
  TOURNAMENT_MATCH_NOTES: {},
  writePrivateNote: async (_client: unknown, _spec: unknown, id: string, text: string) => {
    spies.notes.push({ id, text });
    return { recorded: true, error: null };
  },
}));
vi.mock('../tournament-actions/auto-call', () => ({
  fillFreeCourts: async () => { spies.autoCalls++; return null; },
}));
// The entry paths that count the event's places. A sub must never reach them.
vi.mock('../tournament-actions/on-the-spot', () => ({
  addOnTheSpot: async () => { spies.entryPaths.push('addOnTheSpot'); },
  addExecOnTheSpot: async () => { spies.entryPaths.push('addExecOnTheSpot'); },
}));
vi.mock('../tournament-actions/attendance', () => ({
  enterReserveAndCheckIn: async () => { spies.entryPaths.push('enterReserveAndCheckIn'); },
}));

const { substituteEntry, leaveAndSubstitute } = await import('../tournament-actions/substitutions');

const EVENT = 'eeeeeeee-0000-4000-8000-000000000001';
const SINGLES_EVENT = 'eeeeeeee-0000-4000-8000-000000000002';
const PAIR = 'cccccccc-0000-4000-8000-000000000001';
const SINGLE = 'cccccccc-0000-4000-8000-000000000002';
const OUTGOING = 'bbbbbbbb-0000-4000-8000-000000000001';
const PARTNER = 'bbbbbbbb-0000-4000-8000-000000000002';
const INCOMING = 'bbbbbbbb-0000-4000-8000-000000000003';
const EXEC = 'bbbbbbbb-0000-4000-8000-000000000004';
const RESERVE = 'bbbbbbbb-0000-4000-8000-000000000005';
const GUEST_ID = 'bbbbbbbb-0000-4000-8000-0000000000aa';
const WAITLIST = 'dddddddd-0000-4000-8000-000000000001';

const partnerSub = { kind: 'partner' as const, entryId: PAIR, outgoing: [OUTGOING], incoming: [{ source: 'spare' as const, playerId: INCOMING }] };
const DESK = ['tournaments.draw.checkin.mark.write', 'tournaments.draw.pairs.add.write', 'tournaments.draw.participants.add.write'];
const LEFT_KEYS = ['tournaments.draw.noshow.write', 'tournaments.results.void.write'];

beforeEach(() => {
  db.tables = {
    tournament_events: [
      {
        id: EVENT, tournament_id: 't1', event_type: 'open_doubles', status: 'pool_live', format: 'staged',
        max_participants: 2, tournament: { day_lead_player_id: null },
      },
      {
        id: SINGLES_EVENT, tournament_id: 't1', event_type: 'open_singles', status: 'live', format: 'staged',
        max_participants: 2, tournament: { day_lead_player_id: null },
      },
    ],
    tournament_pairs: [{ id: PAIR, event_id: EVENT, player1_id: OUTGOING, player2_id: PARTNER }],
    tournament_participants: [{ id: SINGLE, event_id: SINGLES_EVENT, player_id: OUTGOING }],
    players: [
      { id: PARTNER, full_name: 'Bob Partner', competition_category: 'mens' },
      { id: INCOMING, full_name: 'Carol Incoming', competition_category: 'mens' },
      { id: EXEC, full_name: 'Erin Exec', is_exec: true },
      { id: RESERVE, full_name: 'Rita Reserve', is_exec: false },
    ],
    ratings: [],
    tournament_event_waitlist: [],
    event_departures: [],
  };
  db.rpcs = [];
  db.updates = [];
  db.audits = [];
  db.subResult = null;
  viewer.is_exec = false;
  viewer.caps = new Set();
  flags.off = new Set();
  waiver.requiredHash = null;
  waiver.acceptances = [];
  spies.warnings = [];
  spies.notes = [];
  spies.autoCalls = 0;
  spies.entryPaths = [];
});

const subCall = () => db.rpcs.find((r) => r.name === 'substitute_event_entry');
const ENTRY_RPCS = ['fill_event_from_waitlist', 'add_participants_under_field_lock', 'enter_tournament_event', 'set_field_entry_status'];
const noEntryPath = () => {
  expect(spies.entryPaths).toEqual([]);
  expect(db.rpcs.map((r) => r.name).filter((name) => ENTRY_RPCS.includes(name))).toEqual([]);
};

describe('substituteEntry', () => {
  it('lets the desk sub, with the new name worked out, and audits it', async () => {
    viewer.caps = new Set(DESK);
    const res = await substituteEntry(EVENT, { ...partnerSub, note: 'Twisted an ankle' });
    expect(res).toEqual({ ok: true, data: { entryId: PAIR, isPair: true, kept: 2, moved: 3, voided: 0, warned: 0 } });
    expect(subCall()?.args).toMatchObject({
      p_entry_id: PAIR, p_kind: 'partner', p_outgoing: [OUTGOING], p_incoming: [INCOMING],
      p_pair_name: 'Carol Incoming / Bob Partner', p_note: 'Twisted an ankle', p_allow_restricted: false,
    });
    expect(subCall()?.args).not.toHaveProperty('p_departure_reason');
    expect(db.audits[0]).toMatchObject({ action: 'event_substitution_made', details: expect.objectContaining({ by: 'desk', fee_charged: false }) });
  });

  it('lets the day lead sub a spare without the desk keys', async () => {
    viewer.is_exec = true;
    db.tables.tournament_events![0]!.tournament = { day_lead_player_id: viewer.id };
    const res = await substituteEntry(EVENT, partnerSub);
    expect(res.ok).toBe(true);
    expect(db.audits[0]).toMatchObject({ details: expect.objectContaining({ by: 'day_lead' }) });
  });

  it('refuses a court helper, who holds neither the desk keys nor the day lead', async () => {
    const res = await substituteEntry(EVENT, partnerSub);
    expect(res).toEqual({ ok: false, error: 'Only the desk or the day lead can sub somebody in.' });
    expect(subCall()).toBeUndefined();
  });

  it('refuses while the switch is off', async () => {
    viewer.caps = new Set(DESK);
    flags.off = new Set(['substitutions']);
    const res = await substituteEntry(EVENT, partnerSub);
    expect(res.ok === false && res.error).toBe('substitutions is switched off');
    expect(subCall()).toBeUndefined();
  });

  it('sends the restriction override only for an exec', async () => {
    viewer.caps = new Set(DESK);
    await substituteEntry(EVENT, { ...partnerSub, overrideRestriction: true });
    expect(subCall()?.args.p_allow_restricted).toBe(false);
    db.rpcs = [];
    viewer.is_exec = true;
    await substituteEntry(EVENT, { ...partnerSub, overrideRestriction: true });
    expect(subCall()?.args.p_allow_restricted).toBe(true);
  });
});

// The event is full (max_participants 2, two entries) and being played. The
// sub reuses the entry, so none of these takes a place or goes near an entry
// path; 00328 attaches the incoming person directly.
describe('a mid-play sub in a full event', () => {
  beforeEach(() => { viewer.caps = new Set(DESK); });

  it('brings an exec in directly', async () => {
    const res = await substituteEntry(SINGLES_EVENT, {
      kind: 'team', entryId: SINGLE, outgoing: [OUTGOING], incoming: [{ source: 'exec', playerId: EXEC }],
    });
    expect(res.ok).toBe(true);
    expect(subCall()?.args).toMatchObject({ p_incoming: [EXEC], p_kind: 'team' });
    expect(subCall()?.args).not.toHaveProperty('p_waitlist_ids');
    noEntryPath();
  });

  it('refuses an exec while a reserve waits, before anything is written', async () => {
    db.tables.tournament_event_waitlist = [{ id: WAITLIST, event_id: SINGLES_EVENT, player_id: RESERVE, status: 'waiting' }];
    const res = await substituteEntry(SINGLES_EVENT, {
      kind: 'team', entryId: SINGLE, outgoing: [OUTGOING], incoming: [{ source: 'exec', playerId: EXEC }],
    });
    expect(res).toEqual({ ok: false, error: 'Call or remove the reserves first.' });
    expect(db.rpcs).toEqual([]);
  });

  it('makes a guest\'s record, not an entry, and subs them in by name', async () => {
    const res = await substituteEntry(EVENT, { ...partnerSub, incoming: [{ source: 'guest', name: 'Gina Guest' }] });
    expect(res.ok).toBe(true);
    expect(db.rpcs[0]).toMatchObject({ name: 'create_desk_guest', args: { p_display_name: 'Gina Guest', p_actor: viewer.id } });
    expect(subCall()?.args).toMatchObject({ p_incoming: [GUEST_ID], p_pair_name: 'Gina Guest / Bob Partner' });
    noEntryPath();
  });

  it('refuses a guest when the tournament asks for its waiver, before making them', async () => {
    waiver.requiredHash = 'hash';
    const res = await substituteEntry(EVENT, { ...partnerSub, incoming: [{ source: 'guest', name: 'Gina Guest' }] });
    expect(res.ok).toBe(false);
    expect(db.rpcs).toEqual([]);
  });

  it('takes a waiting reserve and resolves their waitlist row in the same call', async () => {
    db.tables.tournament_event_waitlist = [{ id: WAITLIST, event_id: SINGLES_EVENT, player_id: RESERVE, status: 'waiting' }];
    const res = await substituteEntry(SINGLES_EVENT, {
      kind: 'team', entryId: SINGLE, outgoing: [OUTGOING], incoming: [{ source: 'reserve', waitlistId: WAITLIST }],
    });
    expect(res.ok).toBe(true);
    expect(subCall()?.args).toMatchObject({ p_incoming: [RESERVE], p_waitlist_ids: [WAITLIST] });
    noEntryPath();
  });

  it('refuses a reserve who is no longer waiting', async () => {
    db.tables.tournament_event_waitlist = [{ id: WAITLIST, event_id: SINGLES_EVENT, player_id: RESERVE, status: 'promoted' }];
    const res = await substituteEntry(SINGLES_EVENT, {
      kind: 'team', entryId: SINGLE, outgoing: [OUTGOING], incoming: [{ source: 'reserve', waitlistId: WAITLIST }],
    });
    expect(res).toEqual({ ok: false, error: 'That reserve is no longer waiting. Reload to see the waitlist.' });
    expect(db.rpcs).toEqual([]);
  });

  it('needs the add key for a reserve, an exec or a guest', async () => {
    viewer.caps = new Set(['tournaments.draw.checkin.mark.write', 'tournaments.draw.pairs.add.write']);
    const res = await substituteEntry(EVENT, { ...partnerSub, incoming: [{ source: 'guest', name: 'Gina Guest' }] });
    expect(res.ok).toBe(false);
    expect(db.rpcs).toEqual([]);
  });
});

describe('leaveAndSubstitute', () => {
  const left = { ...partnerSub, departure: { reason: 'without_notice' as const, note: null } };
  beforeEach(() => {
    viewer.caps = new Set([...DESK, ...LEFT_KEYS]);
    db.subResult = {
      ok: true, kept: 1, moved: 2, is_pair: true,
      voided: ['ffffffff-0000-4000-8000-000000000001'],
      departures: [{ player_id: OUTGOING, departure_id: 'dep-1' }],
    };
  });

  it('is one call: the departure, the void and the sub go to substitute_event_entry together', async () => {
    const res = await leaveAndSubstitute(EVENT, left);
    expect(res).toEqual({ ok: true, data: { entryId: PAIR, isPair: true, kept: 1, moved: 2, voided: 1, warned: 1 } });
    expect(db.rpcs.map((r) => r.name)).toEqual(['substitute_event_entry']);
    expect(subCall()?.args).toMatchObject({ p_departure_reason: 'without_notice', p_outgoing: [OUTGOING] });
    noEntryPath();
  });

  it('warns only the person who went out, never the partner who stays, and links the warning', async () => {
    await leaveAndSubstitute(EVENT, left);
    expect(spies.warnings).toEqual([expect.objectContaining({ playerIds: [OUTGOING], kind: 'left_without_notice', source: 'desk' })]);
    expect(db.updates).toEqual([expect.objectContaining({ table: 'event_departures', payload: { warning_id: `warning-${OUTGOING}` }, filters: [['id', 'dep-1']] })]);
  });

  it('notes and audits the voided match, then calls the next match on', async () => {
    await leaveAndSubstitute(EVENT, left);
    expect(spies.notes).toEqual([{ id: 'ffffffff-0000-4000-8000-000000000001', text: 'Left the event: left without telling anyone' }]);
    expect(db.audits.map((a) => a.action)).toEqual(['match_voided', 'player_left_event', 'event_substitution_made']);
    expect(spies.autoCalls).toBe(1);
  });

  it('writes nothing else when the substitution refuses', async () => {
    db.subResult = { ok: false, reason: 'already_in_event' };
    const res = await leaveAndSubstitute(EVENT, left);
    expect(res).toEqual({ ok: false, error: 'The person coming in is already playing in this event.' });
    expect(spies.warnings).toEqual([]);
    expect(spies.notes).toEqual([]);
    expect(db.audits).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('warns nobody for a reason that does not warn', async () => {
    await leaveAndSubstitute(EVENT, { ...left, departure: { reason: 'injury', note: null } });
    expect(spies.warnings).toEqual([]);
    expect(subCall()?.args).toMatchObject({ p_departure_reason: 'injury' });
  });

  it('asks for the reason, and refuses before play or without the Left keys', async () => {
    expect(await leaveAndSubstitute(EVENT, { ...left, departure: { reason: 'other', note: null } }))
      .toEqual({ ok: false, error: 'Say why they left.' });
    viewer.caps = new Set(DESK);
    expect((await leaveAndSubstitute(EVENT, left)).ok).toBe(false);
    viewer.caps = new Set([...DESK, ...LEFT_KEYS]);
    db.tables.tournament_events![0]!.status = 'checkin';
    expect(await leaveAndSubstitute(EVENT, left)).toEqual({ ok: false, error: 'Start the event before marking anybody as left.' });
    expect(db.rpcs).toEqual([]);
  });
});
