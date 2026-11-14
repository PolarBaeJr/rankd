'use server';

import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import {
  canPairForEvent,
  categoryRequiredBy,
  ExpectedError,
  isExpectedFailure,
  parseOrThrow,
  planTeams,
  TEAM_MODES,
  type TeamCandidate,
  type TournamentEventType,
} from '@badminton/shared';
import { createAdminClient, requireCapability } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { assertReleaseFlag, releaseFlagOn } from '../release-flags';
import { loadRestrictedPlayerIds } from '../entry-restriction';
import { loadAvoidPartnerCheck } from '../teams/avoid-partners';
import { candidatesOf, loadTeamsBoard, type TeamsBoard } from '../teams/load-teams-board';
import { EDIT_AFTER_DRAW_REFUSAL, refreshTeamSocialPosts, relinkConfirmations, sendTeamNotices, type TeamNotice } from '../teams/publish';
import { addPairCore, EXTERNAL_EVENT_REFUSAL, playersAlreadyPaired } from './entry-core';
import { assertTournamentNotSuspended } from './_internal';
import { swapPairMember, unpairEntry } from './participants';

// GENERATE TEAMS (generate_teams, 00334). The desk plans teams in the console
// (the planner is pure and runs in the browser, so nothing is written while
// they look), then Confirm publishes them here.
//
// EVERY PAIR GOES THROUGH addPairCore, the one pairing path, one transaction
// per pair, as Auto pair does: every fee row, field check and audit row that
// pairing performs happens here too. Confirm is not atomic across pairs, by
// design; a refused pair is named and the rest stand.
//
// RE-CHECKED HERE, whatever the browser sent: both people in the pool (or, by
// hand, anybody not already in a team), not restricted from entering (the
// owner asked this tool to apply restrictions, which the ordinary desk add
// does not), allowed to pair by the event's rule, and not on each other's
// avoid list.
//
// AFTER EACH CHANGE: the confirmation rows follow the entry
// (relink_event_confirmations), both members are told with a push, one audit
// row is the run log, and the Marketing sets are refreshed.

const uuid = z.string().uuid();
const modeSchema = z.enum(TEAM_MODES as [string, ...string[]]);
const confirmSchema = z.object({
  pairs: z.array(z.tuple([uuid, uuid])).min(1).max(128),
  mode: modeSchema,
});

type AdminClient = ReturnType<typeof createAdminClient>;

async function openBoard(adminClient: AdminClient, eventId: string): Promise<TeamsBoard> {
  const board = await loadTeamsBoard(adminClient, eventId);
  if (!board) throw new ExpectedError('Teams can only be made for a doubles event.');
  if (board.event.status !== 'registration' && board.event.status !== 'checkin') {
    throw new ExpectedError('Teams can only be made while the event is taking entries.');
  }
  if (board.event.external) throw new ExpectedError(EXTERNAL_EVENT_REFUSAL);
  if (board.event.drawLocked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  await assertTournamentNotSuspended(adminClient, board.event.tournamentId);
  return board;
}

function pairRule(eventType: string) {
  const type = eventType as TournamentEventType;
  return categoryRequiredBy(type) === 'mixed'
    ? (a: TeamCandidate, b: TeamCandidate) => canPairForEvent(type, a.category ?? null, b.category ?? null)
    : undefined;
}

/** The board for the console, or null while the switch is off (the panel then hides). */
export async function getTeamsBoard(eventId: string): Promise<ActionResult<TeamsBoard | null>> {
  return runAction(async () => {
    await requireCapability('tournaments.draw.pairs.add.write');
    if (!(await releaseFlagOn('generate_teams'))) return null;
    return loadTeamsBoard(createAdminClient(), parseOrThrow(uuid, eventId));
  });
}

export interface ConfirmTeamsResult {
  pairsMade: number;
  refused: number;
  reasons: string[];
  notified: number;
}

export async function confirmTeams(eventId: string, input: { pairs: Array<[string, string]>; mode: string }): Promise<ActionResult<ConfirmTeamsResult>> {
  return runAction(() => confirmTeamsImpl(eventId, input));
}

async function confirmTeamsImpl(eventId: string, input: { pairs: Array<[string, string]>; mode: string }): Promise<ConfirmTeamsResult> {
  const admin = await requireCapability('tournaments.draw.pairs.add.write');
  await assertReleaseFlag('generate_teams');
  const id = parseOrThrow(uuid, eventId);
  const { pairs, mode } = parseOrThrow(confirmSchema, input);
  const adminClient = createAdminClient();
  const board = await openBoard(adminClient, id);

  const people = [...new Set(pairs.flat())];
  if (people.length !== pairs.length * 2) throw new ExpectedError('A person appears in two teams. Nothing was paired.');

  const inPool = new Map(board.pool.map((person) => [person.playerId, person]));
  const candidates = new Map(candidatesOf(board.pool).map((candidate) => [candidate.playerId, candidate]));
  const [restricted, alreadyPaired, avoid] = await Promise.all([
    loadRestrictedPlayerIds(adminClient, people),
    playersAlreadyPaired(adminClient, id, people),
    loadAvoidPartnerCheck(adminClient, id),
  ]);
  const eligible = pairRule(board.event.eventType);
  const nameOf = (playerId: string) => inPool.get(playerId)?.name ?? 'This player';

  const reasons: string[] = [];
  const made: Array<{ pairId: string; a: string; b: string }> = [];
  let refused = 0;
  for (const [a, b] of pairs) {
    const why =
      !inPool.has(a) || !inPool.has(b)
        ? 'one of them is no longer waiting for a partner'
        : alreadyPaired.has(a) || alreadyPaired.has(b)
          ? 'one of them is already in a team'
          : restricted.has(a) || restricted.has(b)
            ? 'one of them is restricted from entering events'
            : avoid(a, b)
              ? 'they are on each other\'s avoid list'
              : eligible && !eligible(candidates.get(a)!, candidates.get(b)!)
                ? 'the event does not allow this pair'
                : null;
    if (why) {
      refused += 1;
      reasons.push(`${nameOf(a)} and ${nameOf(b)} were not paired: ${why}.`);
      continue;
    }
    try {
      const pair = await addPairCore(id, a, b);
      if (pair?.id) made.push({ pairId: pair.id, a, b });
    } catch (err) {
      refused += 1;
      reasons.push(`${nameOf(a)} and ${nameOf(b)} were not paired: ${err instanceof Error ? err.message : 'the pair was refused'}.`);
      if (!isExpectedFailure(err)) Sentry.captureException(err);
    }
  }

  if (made.length === 0) return { pairsMade: 0, refused, reasons, notified: 0 };

  const members = made.flatMap((pair) => [pair.a, pair.b]);
  await relinkConfirmations(adminClient, id, members);
  const notified = await sendTeamNotices(
    adminClient,
    { id, tournamentId: board.event.tournamentId, name: board.event.name },
    made.flatMap((pair): TeamNotice[] => [
      { playerId: pair.a, kind: 'paired', partnerName: nameOf(pair.b) },
      { playerId: pair.b, kind: 'paired', partnerName: nameOf(pair.a) },
    ]),
  );
  await logAudit(adminClient, {
    tournament_id: board.event.tournamentId,
    event_id: id,
    action: 'teams_published',
    performed_by: admin.id,
    details: { run_no: board.runs + 1, mode, manual: false, pair_ids: made.map((pair) => pair.pairId), member_ids: members, refused },
  });
  await refreshTeamSocialPosts(adminClient, id, made.map((pair) => pair.pairId));
  return { pairsMade: made.length, refused, reasons, notified };
}

export type AddTeamResult =
  | { added: true; pairId: string; partnerName: string }
  | { added: false; full: true; reserves: TeamsBoard['reserves'] };

/**
 * One team by hand. With no second person, the planner suggests the partner
 * from the pool. Anybody not already in a team may be picked; a new entrant
 * spends a place, so on a full event this offers the reserves instead and
 * never overfills (addPairCore's own capacity check is the authority).
 */
export async function addTeamByHand(eventId: string, player1Id: string, player2Id: string | null): Promise<ActionResult<AddTeamResult>> {
  return runAction(() => addTeamByHandImpl(eventId, player1Id, player2Id));
}

async function addTeamByHandImpl(eventId: string, player1Id: string, player2Id: string | null): Promise<AddTeamResult> {
  const admin = await requireCapability('tournaments.draw.pairs.add.write');
  await assertReleaseFlag('generate_teams');
  const id = parseOrThrow(uuid, eventId);
  const first = parseOrThrow(uuid, player1Id);
  let second = player2Id === null ? null : parseOrThrow(uuid, player2Id);
  const adminClient = createAdminClient();
  const board = await openBoard(adminClient, id);
  const avoid = await loadAvoidPartnerCheck(adminClient, id);
  const eligible = pairRule(board.event.eventType);

  if (second === null) {
    const pool = candidatesOf(board.pool);
    const self = pool.find((candidate) => candidate.playerId === first);
    if (!self) throw new ExpectedError('Only somebody waiting for a partner can be given a suggested one.');
    const plan = planTeams({ candidates: pool, mode: 'similar', eligible, avoid });
    const planned = plan.pairs.find((pair) => pair.includes(first));
    // The planner's choice, else the nearest rating the rules allow.
    second = planned ? planned.find((playerId) => playerId !== first)! : null;
    if (!second) {
      const ratings = new Map(pool.map((candidate) => [candidate.playerId, candidate.rating ?? 0]));
      const nearest = pool
        .filter((candidate) => candidate.playerId !== first && !avoid(first, candidate.playerId) && (!eligible || eligible(self, candidate)))
        .sort((a, b) => Math.abs((ratings.get(a.playerId) ?? 0) - (self.rating ?? 0)) - Math.abs((ratings.get(b.playerId) ?? 0) - (self.rating ?? 0)) || a.playerId.localeCompare(b.playerId))[0];
      second = nearest?.playerId ?? null;
    }
    if (!second) throw new ExpectedError('Nobody in the pool can partner them. Pick a partner by hand.');
  }
  if (first === second) throw new ExpectedError('A team needs two different people.');

  const [restricted, alreadyPaired] = await Promise.all([
    loadRestrictedPlayerIds(adminClient, [first, second]),
    playersAlreadyPaired(adminClient, id, [first, second]),
  ]);
  if (alreadyPaired.size > 0) throw new ExpectedError('One of them is already in a team in this event.');
  if (restricted.size > 0) throw new ExpectedError('One of them is restricted from entering events.');
  if (avoid(first, second)) throw new ExpectedError('They are on each other\'s avoid list.');

  let pair: { id: string } | null;
  try {
    pair = await addPairCore(id, first, second);
  } catch (err) {
    if (err instanceof Error && err.message === 'Event is full') {
      return { added: false, full: true, reserves: board.reserves };
    }
    throw err;
  }
  if (!pair?.id) throw new Error('The team was not saved. Try again.');

  const { data: names } = await adminClient.from('players').select('id, full_name').in('id', [first, second]);
  const nameOf = (playerId: string) => names?.find((row) => row.id === playerId)?.full_name ?? 'your partner';
  await relinkConfirmations(adminClient, id, [first, second]);
  await sendTeamNotices(adminClient, { id, tournamentId: board.event.tournamentId, name: board.event.name }, [
    { playerId: first, kind: 'paired', partnerName: nameOf(second) },
    { playerId: second, kind: 'paired', partnerName: nameOf(first) },
  ]);
  await logAudit(adminClient, {
    tournament_id: board.event.tournamentId,
    event_id: id,
    action: 'team_added',
    performed_by: admin.id,
    details: { manual: true, pair_ids: [pair.id], member_ids: [first, second] },
  });
  await refreshTeamSocialPosts(adminClient, id, [pair.id]);
  return { added: true, pairId: pair.id, partnerName: nameOf(second) };
}

async function readPair(adminClient: AdminClient, pairId: string) {
  const { data, error } = await adminClient
    .from('tournament_pairs')
    .select('id, event_id, player1_id, player2_id, status')
    .eq('id', pairId)
    .maybeSingle();
  if (error) throw new Error(`The team could not be read: ${error.message}`);
  if (!data) throw new ExpectedError('Team not found');
  return data;
}

/** Swap one member for somebody not in a team. After the draw, Substitute is the path. */
export async function editTeam(pairId: string, outgoingPlayerId: string, incomingPlayerId: string): Promise<ActionResult<{ pairName: string }>> {
  return runAction(() => editTeamImpl(pairId, outgoingPlayerId, incomingPlayerId));
}

async function editTeamImpl(pairId: string, outgoingPlayerId: string, incomingPlayerId: string): Promise<{ pairName: string }> {
  const admin = await requireCapability('tournaments.draw.pairs.add.write');
  await assertReleaseFlag('generate_teams');
  const id = parseOrThrow(uuid, pairId);
  const outgoing = parseOrThrow(uuid, outgoingPlayerId);
  const incoming = parseOrThrow(uuid, incomingPlayerId);
  const adminClient = createAdminClient();
  const pair = await readPair(adminClient, id);
  const board = await loadTeamsBoard(adminClient, pair.event_id);
  if (!board) throw new ExpectedError('Teams can only be made for a doubles event.');
  if (board.event.status !== 'registration' && board.event.status !== 'checkin') throw new ExpectedError(EDIT_AFTER_DRAW_REFUSAL);
  const partner = pair.player1_id === outgoing ? pair.player2_id : pair.player2_id === outgoing ? pair.player1_id : null;
  if (!partner) throw new ExpectedError('That player is not in this team.');

  const [restricted, avoid] = await Promise.all([
    loadRestrictedPlayerIds(adminClient, [incoming]),
    loadAvoidPartnerCheck(adminClient, pair.event_id),
  ]);
  if (restricted.size > 0) throw new ExpectedError('They are restricted from entering events.');
  if (avoid(partner, incoming)) throw new ExpectedError('They are on each other\'s avoid list.');

  const result = await swapPairMember(id, outgoing, incoming);
  if (!result.ok) throw new ExpectedError(result.error);

  const { data: names } = await adminClient.from('players').select('id, full_name').in('id', [partner, incoming]);
  const nameOf = (playerId: string) => names?.find((row) => row.id === playerId)?.full_name ?? 'a new partner';
  await relinkConfirmations(adminClient, pair.event_id, [outgoing, incoming, partner]);
  await sendTeamNotices(adminClient, { id: pair.event_id, tournamentId: board.event.tournamentId, name: board.event.name }, [
    { playerId: partner, kind: 'partner_changed', partnerName: nameOf(incoming) },
    { playerId: incoming, kind: 'paired', partnerName: nameOf(partner) },
    { playerId: outgoing, kind: 'unpaired' },
  ]);
  await logAudit(adminClient, {
    tournament_id: board.event.tournamentId,
    event_id: pair.event_id,
    action: 'team_edited',
    performed_by: admin.id,
    details: { manual: true, pair_ids: [id], member_ids: [incoming], replaced: outgoing },
  });
  await refreshTeamSocialPosts(adminClient, pair.event_id, []);
  return result.data;
}

/** Split a team; both go back to the pool, and are told. */
export async function splitTeam(pairId: string): Promise<ActionResult<{ returned: number }>> {
  return runAction(() => splitTeamImpl(pairId));
}

async function splitTeamImpl(pairId: string): Promise<{ returned: number }> {
  const admin = await requireCapability('tournaments.draw.pairs.add.write');
  await assertReleaseFlag('generate_teams');
  const id = parseOrThrow(uuid, pairId);
  const adminClient = createAdminClient();
  const pair = await readPair(adminClient, id);
  const board = await loadTeamsBoard(adminClient, pair.event_id);
  if (!board) throw new ExpectedError('Teams can only be made for a doubles event.');

  const result = await unpairEntry(id);
  if (!result.ok) throw new ExpectedError(result.error);

  const members = [pair.player1_id, pair.player2_id].filter((playerId): playerId is string => !!playerId);
  await relinkConfirmations(adminClient, pair.event_id, members);
  await sendTeamNotices(
    adminClient,
    { id: pair.event_id, tournamentId: board.event.tournamentId, name: board.event.name },
    members.map((playerId): TeamNotice => ({ playerId, kind: 'unpaired' })),
  );
  await logAudit(adminClient, {
    tournament_id: board.event.tournamentId,
    event_id: pair.event_id,
    action: 'team_split',
    performed_by: admin.id,
    details: { manual: true, pair_ids: [id], member_ids: members },
  });
  await refreshTeamSocialPosts(adminClient, pair.event_id, []);
  return { returned: result.data.returned };
}
