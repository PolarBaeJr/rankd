// 00334: Generate teams. Confirm pairs only what the server re-checks, tells
// only the new teams, relinks confirmations and writes the run log; a full
// event offers the reserves; split and edit relink and tell; the switch off
// refuses everything.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tableFake, fakeId, type TableFake } from './table-fake';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

let fake: TableFake;
let flagOn = true;
vi.mock('../supabase-server', () => ({
  createAdminClient: () => fake.client,
  requireCapability: vi.fn(async () => ({ id: 'desk-1' })),
}));
vi.mock('../release-flags', () => ({
  releaseFlagOn: vi.fn(async () => flagOn),
  assertReleaseFlag: vi.fn(async () => {
    if (!flagOn) throw Object.assign(new Error('Generate teams is switched off.'), { expected: true });
  }),
}));

const notices: { ids: string[]; body: string; push: unknown; category: unknown }[] = [];
vi.mock('../notify', () => ({
  notifyPlayers: vi.fn(async (_client: unknown, ids: string[], input: { body: string }, push: unknown, category: unknown) => {
    notices.push({ ids, body: input.body, push, category });
    return { delivered: ids };
  }),
}));

const audits: { action: string; details: Record<string, unknown> }[] = [];
vi.mock('../audit', () => ({ logAudit: vi.fn(async (_client: unknown, row: { action: string; details: Record<string, unknown> }) => { audits.push(row); }) }));

const queued: { eventId: string; ids: readonly string[] }[] = [];
vi.mock('../social-posts/queue', () => ({
  queueTeamSocialPosts: vi.fn(async (_client: unknown, eventId: string, ids: readonly string[]) => { queued.push({ eventId, ids }); }),
}));

let full = false;
const paired: Array<[string, string]> = [];
vi.mock('../tournament-actions/entry-core', () => ({
  EXTERNAL_EVENT_REFUSAL: 'external',
  addPairCore: vi.fn(async (eventId: string, a: string, b: string) => {
    if (full) throw new Error('Event is full');
    paired.push([a, b]);
    const row = { id: fakeId(), event_id: eventId, player1_id: a, player2_id: b, status: 'registered' };
    (fake.tables.tournament_pairs as unknown[]).push(row);
    fake.tables.tournament_participants = (fake.tables.tournament_participants as Array<{ player_id: string }>).filter((p) => p.player_id !== a && p.player_id !== b) as never;
    return row;
  }),
  playersAlreadyPaired: vi.fn(async (_client: unknown, _eventId: string, ids: string[]) => {
    const inPairs = (fake.tables.tournament_pairs as Array<{ player1_id: string; player2_id: string }>).flatMap((p) => [p.player1_id, p.player2_id]);
    return new Set(ids.filter((id) => inPairs.includes(id)));
  }),
}));
vi.mock('../tournament-actions/_internal', () => ({ assertTournamentNotSuspended: vi.fn(async () => {}) }));

const swaps: unknown[] = [];
const splits: string[] = [];
vi.mock('../tournament-actions/participants', () => ({
  swapPairMember: vi.fn(async (...args: unknown[]) => { swaps.push(args); return { ok: true, data: { pairName: 'X & Y' } }; }),
  unpairEntry: vi.fn(async (pairId: string) => { splits.push(pairId); return { ok: true, data: { returned: 2, withdrawnName: null } }; }),
}));

let readsSignups = false;
vi.mock('../permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions')>()),
  permits: vi.fn(() => readsSignups),
}));

const { confirmTeams, addTeamByHand, editTeam, splitTeam, getTeamsBoard } = await import('../tournament-actions/teams');

const EVENT = 'bbbbbbbb-0000-4000-8000-000000000001';
const P = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const solo = (n: number, rating = 1000) => ({
  event_id: EVENT,
  player_id: P(n),
  status: 'registered',
  elo_before: rating,
  player: { full_name: `Member ${n} Placeholder`, competition_category: null, ratings: { doubles_elo: rating, doubles_provisional: false } },
});

function seed(extra: Record<string, unknown[]> = {}) {
  fake = tableFake({
    tournament_events: [{ id: EVENT, tournament_id: 't1', event_type: 'open_doubles', status: 'registration', draw_locked: false, external_event: false, max_participants: null, tournament: { name: 'Fall Open' } }],
    tournament_participants: [solo(1, 1600), solo(2, 1400), solo(3, 1200), solo(4, 1000)],
    tournament_pairs: [],
    tournament_audit_log: [],
    tournament_event_waitlist: [],
    event_entry_restrictions: [],
    players: [1, 2, 3, 4, 5].map((n) => ({ id: P(n), full_name: `Member ${n} Placeholder` })),
    ...extra,
  } as never);
}

beforeEach(() => {
  flagOn = true;
  readsSignups = false;
  full = false;
  notices.length = 0;
  audits.length = 0;
  queued.length = 0;
  paired.length = 0;
  swaps.length = 0;
  splits.length = 0;
  seed();
});

describe('confirmTeams', () => {
  it('pairs, relinks, tells both with a push, writes the run log and queues the posts', async () => {
    const result = await confirmTeams(EVENT, { pairs: [[P(1), P(4)], [P(2), P(3)]], mode: 'balanced' });
    expect(result).toMatchObject({ ok: true, data: { pairsMade: 2, refused: 0 } });
    expect(paired).toEqual([[P(1), P(4)], [P(2), P(3)]]);
    expect(fake.rpcs).toEqual([{ name: 'relink_event_confirmations', args: { p_event_id: EVENT, p_player_ids: [P(1), P(4), P(2), P(3)] } }]);
    expect(notices).toHaveLength(4);
    expect(notices[0]).toMatchObject({ ids: [P(1)], body: 'You are paired with Member 4 Placeholder for Fall Open Open Doubles.', category: 'tournaments' });
    expect(notices[0]!.push).toMatchObject({ title: 'Your team' });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'teams_published', details: { run_no: 1, mode: 'balanced', manual: false, member_ids: [P(1), P(4), P(2), P(3)] } });
    expect(queued[0]!.ids).toHaveLength(2);
  });

  it('a re-run tells only the new teams, and counts as run 2', async () => {
    await confirmTeams(EVENT, { pairs: [[P(1), P(4)]], mode: 'balanced' });
    (fake.tables.tournament_audit_log as unknown[]).push({ event_id: EVENT, action: 'teams_published', created_at: '2026-11-10T10:00:00Z', performed_by: 'desk-1', details: audits[0]!.details });
    notices.length = 0;
    const result = await confirmTeams(EVENT, { pairs: [[P(2), P(3)]], mode: 'similar' });
    expect(result).toMatchObject({ ok: true, data: { pairsMade: 1 } });
    expect(notices.flatMap((notice) => notice.ids).sort()).toEqual([P(2), P(3)].sort());
    expect(audits[1]!.details.run_no).toBe(2);
  });

  it('refuses a restricted member, somebody already in a team, and somebody not waiting, pairing the rest', async () => {
    seed({
      event_entry_restrictions: [{ player_id: P(3), lifted_at: null, starts_at: '2026-01-01T00:00:00Z', ends_at: null }],
      tournament_pairs: [{ id: 'pair-x', event_id: EVENT, player1_id: P(5), player2_id: P(9), status: 'registered' }],
    });
    const result = await confirmTeams(EVENT, { pairs: [[P(2), P(3)], [P(1), P(4)]], mode: 'balanced' });
    expect(result).toMatchObject({ ok: true, data: { pairsMade: 1, refused: 1 } });
    if (result.ok) expect(result.data.reasons[0]).toContain('restricted');
    expect(paired).toEqual([[P(1), P(4)]]);

    const twice = await confirmTeams(EVENT, { pairs: [[P(1), P(2)], [P(2), P(3)]], mode: 'balanced' });
    expect(twice.ok).toBe(false);
  });

  it('re-checks a mutual pair on Confirm: one of them left the pool, so it is refused and named', async () => {
    // The preview locked Member 1 and Member 2 as a mutual request; Member 2
    // was paired elsewhere before the desk pressed Confirm.
    seed({ tournament_participants: [solo(1), solo(3), solo(4)], tournament_pairs: [{ id: 'pair-y', event_id: EVENT, player1_id: P(2), player2_id: P(5), status: 'registered' }] });
    const result = await confirmTeams(EVENT, { pairs: [[P(1), P(2)], [P(3), P(4)]], mode: 'balanced' });
    expect(result).toMatchObject({ ok: true, data: { pairsMade: 1, refused: 1 } });
    if (result.ok) expect(result.data.reasons[0]).toBe('Member 1 Placeholder and This player were not paired: one of them is no longer waiting for a partner.');
    expect(paired).toEqual([[P(3), P(4)]]);
  });

  it('writes nothing when nothing pairs', async () => {
    const result = await confirmTeams(EVENT, { pairs: [[P(5), P(1)]], mode: 'balanced' });
    expect(result).toMatchObject({ ok: true, data: { pairsMade: 0, refused: 1 } });
    expect(fake.rpcs).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it('refuses everything with generate_teams off, and the board is hidden', async () => {
    flagOn = false;
    expect((await confirmTeams(EVENT, { pairs: [[P(1), P(4)]], mode: 'balanced' })).ok).toBe(false);
    expect((await addTeamByHand(EVENT, P(1), P(2))).ok).toBe(false);
    expect((await splitTeam('cccccccc-0000-4000-8000-000000000001')).ok).toBe(false);
    expect(await getTeamsBoard(EVENT)).toEqual({ ok: true, data: null });
    expect(paired).toHaveLength(0);
  });

  it('refuses a bad mode or a malformed id', async () => {
    expect((await confirmTeams(EVENT, { pairs: [[P(1), P(4)]], mode: 'cosmic' })).ok).toBe(false);
    expect((await confirmTeams('nope', { pairs: [[P(1), P(4)]], mode: 'balanced' })).ok).toBe(false);
  });
});

describe('getTeamsBoard', () => {
  it('carries the partner notes only for a viewer who may read the sign-ups', async () => {
    const hidden = await getTeamsBoard(EVENT);
    expect(hidden.ok && hidden.data?.notes).toEqual({ state: 'hidden' });
    readsSignups = true;
    const unlinked = await getTeamsBoard(EVENT);
    expect(unlinked.ok && unlinked.data?.notes).toEqual({ state: 'unlinked' });
    expect(unlinked.ok && unlinked.data?.pool).toHaveLength(4);
  });
});

describe('addTeamByHand', () => {
  it('suggests a partner from the pool when none is picked', async () => {
    const result = await addTeamByHand(EVENT, P(1), null);
    expect(result).toMatchObject({ ok: true, data: { added: true } });
    expect(paired[0]![0]).toBe(P(1));
    expect(audits[0]).toMatchObject({ action: 'team_added', details: { manual: true } });
    expect(fake.rpcs[0]!.name).toBe('relink_event_confirmations');
  });

  it('on a full event offers the reserves and adds nobody', async () => {
    full = true;
    seed({ tournament_event_waitlist: [{ id: 'w1', event_id: EVENT, player_id: P(5), status: 'waiting', joined_at: '2026-11-01T00:00:00Z', player: { full_name: 'Member 5 Placeholder' } }] });
    const result = await addTeamByHand(EVENT, P(1), P(5));
    expect(result).toEqual({ ok: true, data: { added: false, full: true, reserves: [{ id: 'w1', playerId: P(5), name: 'Member 5 Placeholder' }] } });
    expect(audits).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it('refuses somebody already in a team', async () => {
    seed({ tournament_pairs: [{ id: 'pair-x', event_id: EVENT, player1_id: P(5), player2_id: P(9), status: 'registered' }] });
    expect((await addTeamByHand(EVENT, P(1), P(5))).ok).toBe(false);
    expect(paired).toHaveLength(0);
  });
});

describe('split and edit', () => {
  const PAIR = 'cccccccc-0000-4000-8000-000000000001';
  const pair = { id: PAIR, event_id: EVENT, player1_id: P(1), player2_id: P(2), status: 'registered' };

  it('split frees both, relinks both, tells both, and logs it', async () => {
    seed({ tournament_pairs: [pair] });
    const result = await splitTeam(PAIR);
    expect(result).toEqual({ ok: true, data: { returned: 2 } });
    expect(splits).toEqual([PAIR]);
    expect(fake.rpcs[0]).toEqual({ name: 'relink_event_confirmations', args: { p_event_id: EVENT, p_player_ids: [P(1), P(2)] } });
    expect(notices.flatMap((notice) => notice.ids)).toEqual([P(1), P(2)]);
    expect(audits[0]).toMatchObject({ action: 'team_split', details: { pair_ids: [PAIR] } });
  });

  it('edit swaps through swapPairMember, relinks all three and tells them', async () => {
    seed({ tournament_pairs: [pair] });
    const result = await editTeam(PAIR, P(2), P(3));
    expect(result.ok).toBe(true);
    expect(swaps).toEqual([[PAIR, P(2), P(3)]]);
    expect(fake.rpcs[0]!.args).toEqual({ p_event_id: EVENT, p_player_ids: [P(2), P(3), P(1)] });
    expect(notices.find((notice) => notice.ids[0] === P(1))!.body).toContain('Your partner for');
    expect(audits[0]!.action).toBe('team_edited');
  });

  it('after the draw an edit points to Substitute', async () => {
    seed({ tournament_pairs: [pair] });
    (fake.tables.tournament_events![0] as { status: string }).status = 'bracket_generated';
    const result = await editTeam(PAIR, P(2), P(3));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Substitute');
    expect(swaps).toHaveLength(0);
  });
});
