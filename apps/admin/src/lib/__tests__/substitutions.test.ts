// SUBSTITUTIONS (00327). Who may sub: the desk (check-in and the add key for
// the discipline) or the tournament's day lead; never a court helper. The
// switch off refuses. The restriction override is an exec's alone. The SQL
// itself is supabase/tests/00327_event_substitutions.sql.

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcs: [] as Array<{ name: string; args: Row }>,
  audits: [] as Row[],
}));

const makeClient = vi.hoisted(() => () => ({
  rpc: async (name: string, args: Row) => {
    db.rpcs.push({ name, args });
    return { data: { ok: true, kept: 2, moved: 3, is_pair: true }, error: null };
  },
  from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const rows = () => (db.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    const api: Record<string, unknown> = {
      select: () => api,
      in: () => api,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return api; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
    };
    return api;
  },
}));

const viewer = vi.hoisted(() => ({ id: 'aaaaaaaa-0000-4000-8000-000000000001', is_exec: false, caps: new Set<string>() }));
const flags = vi.hoisted(() => ({ off: new Set<string>() }));

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
vi.mock('../tournament-actions/_internal', () => ({ assertTournamentNotSuspended: async () => {}, revalidateEventPaths: () => {} }));

const { substituteEntry } = await import('../tournament-actions/substitutions');

const EVENT = 'eeeeeeee-0000-4000-8000-000000000001';
const PAIR = 'cccccccc-0000-4000-8000-000000000001';
const OUTGOING = 'bbbbbbbb-0000-4000-8000-000000000001';
const PARTNER = 'bbbbbbbb-0000-4000-8000-000000000002';
const INCOMING = 'bbbbbbbb-0000-4000-8000-000000000003';
const partnerSub = { kind: 'partner' as const, entryId: PAIR, outgoing: [OUTGOING], incoming: [INCOMING] };

beforeEach(() => {
  db.tables = {
    tournament_events: [{
      id: EVENT, tournament_id: 't1', event_type: 'open_doubles', status: 'pool_live',
      tournament: { day_lead_player_id: null },
    }],
    tournament_pairs: [{ id: PAIR, event_id: EVENT, player1_id: OUTGOING, player2_id: PARTNER }],
    players: [
      { id: PARTNER, full_name: 'Bob Partner', competition_category: 'mens' },
      { id: INCOMING, full_name: 'Carol Incoming', competition_category: 'mens' },
    ],
    ratings: [],
  };
  db.rpcs = [];
  db.audits = [];
  viewer.is_exec = false;
  viewer.caps = new Set();
  flags.off = new Set();
});

const subCall = () => db.rpcs.find((r) => r.name === 'substitute_event_entry');

describe('substituteEntry', () => {
  it('lets the desk sub, with the new name worked out, and audits it', async () => {
    viewer.caps = new Set(['tournaments.draw.checkin.mark.write', 'tournaments.draw.pairs.add.write']);
    const res = await substituteEntry(EVENT, { ...partnerSub, note: 'Twisted an ankle' });
    expect(res).toEqual({ ok: true, data: { entryId: PAIR, isPair: true, kept: 2, moved: 3 } });
    expect(subCall()?.args).toMatchObject({
      p_entry_id: PAIR, p_kind: 'partner', p_outgoing: [OUTGOING], p_incoming: [INCOMING],
      p_pair_name: 'Carol Incoming / Bob Partner', p_note: 'Twisted an ankle', p_allow_restricted: false,
    });
    expect(db.audits[0]).toMatchObject({ action: 'event_substitution_made', details: expect.objectContaining({ by: 'desk' }) });
  });

  it('lets the day lead sub without the desk keys', async () => {
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
    viewer.caps = new Set(['tournaments.draw.checkin.mark.write', 'tournaments.draw.pairs.add.write']);
    flags.off = new Set(['substitutions']);
    const res = await substituteEntry(EVENT, partnerSub);
    expect(res.ok === false && res.error).toBe('substitutions is switched off');
    expect(subCall()).toBeUndefined();
  });

  it('sends the restriction override only for an exec', async () => {
    viewer.caps = new Set(['tournaments.draw.checkin.mark.write', 'tournaments.draw.pairs.add.write']);
    await substituteEntry(EVENT, { ...partnerSub, overrideRestriction: true });
    expect(subCall()?.args.p_allow_restricted).toBe(false);
    db.rpcs = [];
    viewer.is_exec = true;
    await substituteEntry(EVENT, { ...partnerSub, overrideRestriction: true });
    expect(subCall()?.args.p_allow_restricted).toBe(true);
  });
});
