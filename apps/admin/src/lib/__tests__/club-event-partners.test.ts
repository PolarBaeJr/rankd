// The desk's partner actions (00311). Every parameter is a client POST field:
// shapes are strict, the partner has to be signed up to the same event, the
// audit row carries ids and never the typed note, and who asked for whom is
// re-derived on the server rather than taken from the client.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkPartners, type PartnerPerson } from '../partner-check';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const capabilities: string[] = [];
vi.mock('../actions/_shared', () => ({
  requireCapability: vi.fn(async (capability: string) => {
    capabilities.push(capability);
    return { id: 'admin-1' };
  }),
}));
const audits: { action_type: string; new_value: Record<string, unknown> }[] = [];
vi.mock('../audit', () => ({
  logAdminAudit: vi.fn(async (_client: unknown, entry: { action_type: string; new_value: Record<string, unknown> }) => {
    audits.push(entry);
  }),
}));

const pairs: { eventId: string; a: string; b: string }[] = [];
let pairResult: { ok: true; data: unknown } | { ok: false; error: string } = { ok: true, data: null };
vi.mock('../tournament-actions/participants', () => ({
  addPairToEvent: vi.fn(async (eventId: string, a: string, b: string) => {
    pairs.push({ eventId, a, b });
    return pairResult;
  }),
}));

const randomCalls: [number, number][] = [];
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomInt: vi.fn((min: number, max: number) => {
    randomCalls.push([min, max]);
    return max - 1;
  }),
}));

let board: {
  people: PartnerPerson[];
  teams: [string, string][];
  pool: Set<string>;
  linkedEventId: string | null;
  linkedTournamentId: string | null;
  doubles: boolean;
  choiceReady: boolean;
  result: ReturnType<typeof checkPartners>;
};
vi.mock('../partner-board', () => ({ loadPartnerBoard: vi.fn(async () => board) }));

let event: Record<string, unknown> | null;
/** `${table}:${id}` for every sign-up that exists. */
let signedUp: Set<string>;
const updates: { table: string; values: Record<string, unknown> }[] = [];

vi.mock('../supabase-server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let updating = false;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        update: (values: Record<string, unknown>) => {
          updates.push({ table, values });
          updating = true;
          return chain;
        },
        maybeSingle: async () => {
          if (table === 'club_events') return { data: event, error: null };
          if (table === 'tournament_events') return { data: { tournament_id: 'tournament-1' }, error: null };
          const id = (filters.player_id ?? filters.id) as string;
          return { data: signedUp.has(`${table}:${id}`) ? { id } : null, error: null };
        },
        then: (resolve: (value: unknown) => void) => {
          const id = (filters.player_id ?? filters.id) as string;
          resolve({ data: updating && signedUp.has(`${table}:${id}`) ? [{ event_id: filters.event_id }] : [], error: null });
        },
      });
      return chain;
    },
  }),
}));

const actions = await import('../actions/club-event-partners');

const EVENT = '11111111-1111-4111-8111-111111111111';
const ANN = '22222222-2222-4222-8222-222222222222';
const BEN = '33333333-3333-4333-8333-333333333333';
const CAL = '44444444-4444-4444-8444-444444444444';
const GUEST = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';

function boardOf(people: PartnerPerson[], pool: string[], linked = true) {
  const poolSet = new Set(pool);
  board = {
    people,
    teams: [],
    pool: poolSet,
    linkedEventId: linked ? 'tournament-event-1' : null,
    linkedTournamentId: linked ? 'tournament-1' : null,
    doubles: true,
    choiceReady: true,
    result: checkPartners({ people, pool: poolSet }),
  };
}
const member = (id: string, name: string, wrote: string | null = null): PartnerPerson => ({
  key: `member:${id}`,
  playerId: id,
  name,
  wrote,
  desk: null,
});

beforeEach(() => {
  capabilities.length = 0;
  audits.length = 0;
  updates.length = 0;
  pairs.length = 0;
  randomCalls.length = 0;
  pairResult = { ok: true, data: null };
  event = { id: EVENT, status: 'published', tournament_event_id: null };
  signedUp = new Set([
    `club_event_signups:${ANN}`,
    `club_event_signups:${BEN}`,
    `club_event_external_signups:${GUEST}`,
  ]);
});

describe('setClubEventPartnerChoice', () => {
  it('asks for the check-in capability', async () => {
    const result = await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: ANN }, { kind: 'none' });
    expect(result.ok).toBe(true);
    expect(capabilities).toEqual(['events.signups.checkin.write']);
  });

  it('refuses a stray field or a malformed id before reading', async () => {
    for (const result of [
      await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: ANN, extra: 1 } as never, { kind: 'none' }),
      await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: ANN }, { kind: 'none', note: 'x' } as never),
      await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: 'nope' }, { kind: 'typed' }),
      await actions.setClubEventPartnerChoice('nope', { kind: 'member', id: ANN }, { kind: 'typed' }),
    ]) {
      expect(result.ok).toBe(false);
    }
    expect(updates).toEqual([]);
  });

  it('refuses a partner signed up to another event, or not at all', async () => {
    const result = await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: ANN }, { kind: 'member', id: OTHER });
    expect(result.ok).toBe(false);
    expect(updates).toEqual([]);
  });

  it('refuses somebody as their own partner', async () => {
    const result = await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: ANN }, { kind: 'member', id: ANN });
    expect(result.ok).toBe(false);
    expect(updates).toEqual([]);
  });

  it('refuses a cancelled event', async () => {
    event = { id: EVENT, status: 'cancelled', tournament_event_id: null };
    expect((await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: ANN }, { kind: 'none' })).ok).toBe(false);
  });

  it('writes the columns each choice means', async () => {
    await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: ANN }, { kind: 'typed' });
    await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: ANN }, { kind: 'none' });
    await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: ANN }, { kind: 'member', id: BEN });
    await actions.setClubEventPartnerChoice(EVENT, { kind: 'guest', id: GUEST }, { kind: 'member', id: ANN });
    await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: BEN }, { kind: 'guest', id: GUEST });
    expect(updates.map((update) => update.table)).toEqual([
      'club_event_signups',
      'club_event_signups',
      'club_event_signups',
      'club_event_external_signups',
      'club_event_signups',
    ]);
    expect(updates[0]!.values).toEqual({
      preferred_partner_player_id: null,
      preferred_partner_external_id: null,
      preferred_partner_set_at: null,
    });
    expect(updates[1]!.values).toMatchObject({ preferred_partner_player_id: null, preferred_partner_external_id: null });
    expect(updates[1]!.values.preferred_partner_set_at).toEqual(expect.any(String));
    expect(updates[2]!.values).toMatchObject({ preferred_partner_player_id: BEN, preferred_partner_external_id: null });
    expect(updates[3]!.values).toMatchObject({ preferred_partner_player_id: ANN, preferred_partner_external_id: null });
    expect(updates[4]!.values).toMatchObject({ preferred_partner_player_id: null, preferred_partner_external_id: GUEST });
    for (const update of updates) expect(Object.keys(update.values)).not.toContain('preferred_partner');
  });

  it('audits ids only, never the typed note', async () => {
    await actions.setClubEventPartnerChoice(EVENT, { kind: 'member', id: ANN }, { kind: 'member', id: BEN });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action_type).toBe('club_event_partner_set');
    expect(audits[0]!.new_value).toEqual({
      player_id: ANN,
      choice: 'member',
      partner_player_id: BEN,
      partner_external_id: null,
    });
  });
});

describe('resolveContestedPartner', () => {
  beforeEach(() => {
    boardOf([member(ANN, 'Ann Ho', 'Ben'), member(BEN, 'Ben Wu'), member(CAL, 'Cal Ng', 'Ben')], [ANN, BEN, CAL]);
  });

  it('pairs the requester the officer chose, and leaves the other alone', async () => {
    const result = await actions.resolveContestedPartner(EVENT, BEN, { mode: 'choose', requesterPlayerId: CAL });
    expect(result).toEqual({ ok: true, data: { winnerName: 'Cal Ng' } });
    expect(pairs).toEqual([{ eventId: 'tournament-event-1', a: CAL, b: BEN }]);
    expect(audits[0]!.action_type).toBe('club_event_partner_contest_resolved');
    expect(capabilities).toEqual(['events.signups.read']);
  });

  it('refuses a choice that is not one of the requesters', async () => {
    const result = await actions.resolveContestedPartner(EVENT, BEN, { mode: 'choose', requesterPlayerId: OTHER });
    expect(result.ok).toBe(false);
    expect(pairs).toEqual([]);
  });

  it('picks at random among the server\'s requesters', async () => {
    const result = await actions.resolveContestedPartner(EVENT, BEN, { mode: 'random' });
    expect(randomCalls).toEqual([[0, 2]]);
    expect(result).toEqual({ ok: true, data: { winnerName: 'Cal Ng' } });
    expect(pairs).toEqual([{ eventId: 'tournament-event-1', a: CAL, b: BEN }]);
  });

  it('leaves a requester not waiting in the pool out of the draw', async () => {
    boardOf([member(ANN, 'Ann Ho', 'Ben'), member(BEN, 'Ben Wu'), member(CAL, 'Cal Ng', 'Ben')], [ANN, BEN]);
    const result = await actions.resolveContestedPartner(EVENT, BEN, { mode: 'random' });
    expect(randomCalls).toEqual([[0, 1]]);
    expect(result).toEqual({ ok: true, data: { winnerName: 'Ann Ho' } });
  });

  it('refuses an event that does not run as a tournament', async () => {
    boardOf([member(ANN, 'Ann Ho', 'Ben'), member(BEN, 'Ben Wu'), member(CAL, 'Cal Ng', 'Ben')], [ANN, BEN, CAL], false);
    expect((await actions.resolveContestedPartner(EVENT, BEN, { mode: 'random' })).ok).toBe(false);
    expect(pairs).toEqual([]);
  });

  it('refuses a target not waiting for a partner', async () => {
    boardOf([member(ANN, 'Ann Ho', 'Ben'), member(BEN, 'Ben Wu'), member(CAL, 'Cal Ng', 'Ben')], [ANN, CAL]);
    expect((await actions.resolveContestedPartner(EVENT, BEN, { mode: 'random' })).ok).toBe(false);
    expect(pairs).toEqual([]);
  });

  it('passes the tournament\'s refusal through', async () => {
    pairResult = { ok: false, error: 'Ben Wu is already in a pair for this event.' };
    const result = await actions.resolveContestedPartner(EVENT, BEN, { mode: 'choose', requesterPlayerId: ANN });
    expect(result).toMatchObject({ ok: false, error: 'Ben Wu is already in a pair for this event.' });
    expect(audits).toEqual([]);
  });

  it('refuses a stray field on the pick', async () => {
    expect((await actions.resolveContestedPartner(EVENT, BEN, { mode: 'random', winner: ANN } as never)).ok).toBe(false);
  });
});

describe('pairMutualPartners', () => {
  it('pairs two people who named each other', async () => {
    boardOf([member(ANN, 'Ann Ho', 'Ben'), member(BEN, 'Ben Wu', 'Ann')], [ANN, BEN]);
    expect((await actions.pairMutualPartners(EVENT, BEN, ANN)).ok).toBe(true);
    expect(pairs).toEqual([{ eventId: 'tournament-event-1', a: BEN, b: ANN }]);
  });

  it('refuses two who did not', async () => {
    boardOf([member(ANN, 'Ann Ho', 'Ben'), member(BEN, 'Ben Wu', 'none')], [ANN, BEN]);
    expect((await actions.pairMutualPartners(EVENT, ANN, BEN)).ok).toBe(false);
    expect(pairs).toEqual([]);
  });
});
