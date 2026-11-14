'use server';

import * as Sentry from '@sentry/nextjs';
import {
  calculateTeamRating,
  categoryRequiredBy,
  ExpectedError,
  isDoublesEvent,
  screenPair,
  toCompetitionCategory,
  type TournamentEventType,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { assertReleaseFlag, releaseFlagOn } from '../release-flags';
import { requireConsoleUser } from '../court-helper-gate';
import { permits } from '../permissions';
import { assertTournamentNotSuspended, revalidateEventPaths } from './_internal';

// SUBSTITUTIONS (00327). Somebody comes in for one member of a pair (a partner
// sub) or for a whole entry (a team sub), before or during an event. The entry
// keeps its id, so its seed, group, standing and fixtures stay; the database
// records who played every match already decided before the people change.
//
// WHO. The desk, holding both the check-in key and the add key for the
// discipline, because a sub is an addition made at the desk; and the
// tournament's day lead, the exec named to make the calls on the day. A court
// helper holds neither and is refused: helpers mark a player as left, the
// desk decides who replaces them.
//
// The incoming person is already entered as a spare (a member in the event and
// not playing, a reserve entered from the waitlist, an exec or a guest added
// on the spot), so the entry path has made the fee decision and asked for the
// waiver.

export type SubstitutionKind = 'partner' | 'team';

export interface SubstitutionInput {
  kind: SubstitutionKind;
  entryId: string;
  /** Paired with `incoming` by position. */
  outgoing: string[];
  incoming: string[];
  note?: string | null;
  /** The incoming member is restricted from entering events and an exec says go ahead. */
  overrideRestriction?: boolean;
}

export interface SubstitutionResult {
  entryId: string;
  isPair: boolean;
  /** Decided matches that keep the outgoing people. */
  kept: number;
  /** Unplayed matches the incoming people take over. */
  moved: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.length <= 2 && value.every((id) => typeof id === 'string' && UUID_PATTERN.test(id));

const REFUSALS: Record<string, string> = {
  bad_kind: 'Choose a partner sub or a team sub.',
  bad_people: 'Pick who goes out and who comes in for each of them.',
  same_person: 'Somebody cannot come in for themselves or twice.',
  note_too_long: 'Keep the note to 500 characters.',
  event_not_found: 'That event is not there any more.',
  event_status: 'The event is finished, so its entries cannot change.',
  external: 'An external team is entered by name and cannot be subbed.',
  entry_not_found: 'That entry is not in this event.',
  entry_out: 'This entry is out of the event. Undo "Did not come" first, then sub.',
  not_in_entry: 'The person going out is not on this entry.',
  on_court: 'They are on court right now. Finish or void that match first.',
  already_in_event: 'The person coming in is already playing in this event.',
  not_entered: 'Enter the person coming in first: as a reserve, an exec or a guest.',
  restricted: 'The person coming in is restricted from entering events. An exec has to confirm.',
};

async function substituteEntryImpl(eventId: unknown, raw: unknown): Promise<SubstitutionResult> {
  const { viewer, level, permissions } = await requireConsoleUser();
  const actorId = viewer.id as string;
  if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId)) throw new Error('Event not found');
  const input = (raw ?? {}) as Partial<SubstitutionInput>;
  const adminClient = createAdminClient();

  const { data: event, error: eventError } = await adminClient.from('tournament_events')
    .select('id, tournament_id, event_type, status, tournament:tournaments!tournament_events_tournament_id_fkey(day_lead_player_id)')
    .eq('id', eventId)
    .maybeSingle();
  if (eventError) throw new Error(`Could not read the event: ${eventError.message}`);
  if (!event) throw new Error('Event not found');
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  const desk = permits(level, permissions, 'tournaments.draw.checkin.mark.write')
    && permits(level, permissions, doubles ? 'tournaments.draw.pairs.add.write' : 'tournaments.draw.participants.add.write');
  if (!desk) {
    const tournament = (Array.isArray(event.tournament) ? event.tournament[0] : event.tournament) as { day_lead_player_id?: string | null } | null;
    const dayLead = viewer.is_exec === true
      && tournament?.day_lead_player_id === actorId
      && await releaseFlagOn('day_lead');
    if (!dayLead) throw new ExpectedError('Only the desk or the day lead can sub somebody in.');
  }
  await assertReleaseFlag('substitutions');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  if (input.kind !== 'partner' && input.kind !== 'team') throw new ExpectedError(REFUSALS.bad_kind!);
  if (typeof input.entryId !== 'string' || !UUID_PATTERN.test(input.entryId)) throw new ExpectedError(REFUSALS.entry_not_found!);
  if (!uuidList(input.outgoing) || !uuidList(input.incoming) || input.outgoing.length !== input.incoming.length) {
    throw new ExpectedError(REFUSALS.bad_people!);
  }
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null;
  if (note && note.length > 500) throw new ExpectedError(REFUSALS.note_too_long!);
  // The override is an exec's decision, so nobody else can send it.
  const allowRestricted = input.overrideRestriction === true && viewer.is_exec === true;

  // THE NEW TEAM'S NAME, RATING AND CATEGORY, worked out here as swapPairMember
  // does: a sub that kept the old combined rating or name would seed and label
  // the team off somebody who is no longer on it.
  let pairName: string | null = null;
  let combinedElo: number | null = null;
  let eloBefore: number | null = null;
  if (doubles) {
    const { data: pair, error: pairError } = await adminClient.from('tournament_pairs')
      .select('player1_id, player2_id')
      .eq('id', input.entryId)
      .eq('event_id', event.id)
      .maybeSingle();
    if (pairError) throw new Error(`Could not read the pair: ${pairError.message}`);
    if (!pair?.player1_id || !pair.player2_id) throw new ExpectedError(REFUSALS.entry_not_found!);
    const swap = (id: string) => {
      const at = input.outgoing!.indexOf(id);
      return at >= 0 ? input.incoming![at]! : id;
    };
    const next1 = swap(pair.player1_id);
    const next2 = swap(pair.player2_id);
    const [{ data: ratings }, { data: players }] = await Promise.all([
      adminClient.from('ratings').select('player_id, doubles_elo').in('player_id', [next1, next2]),
      adminClient.from('players').select('id, full_name, competition_category').in('id', [next1, next2]),
    ]);
    const nameFor = (id: string) => players?.find((p) => p.id === id)?.full_name ?? '';
    const eloFor = (id: string) => ratings?.find((r) => r.player_id === id)?.doubles_elo ?? 400;
    if (categoryRequiredBy(event.event_type as TournamentEventType) === 'mixed') {
      const categoryFor = (id: string) => toCompetitionCategory(
        (players?.find((p) => p.id === id) as { competition_category?: unknown } | undefined)?.competition_category,
      );
      const screen = screenPair(
        event.event_type as TournamentEventType,
        { category: categoryFor(next1), name: nameFor(next1) || 'One player' },
        { category: categoryFor(next2), name: nameFor(next2) || 'The other player' },
      );
      if (!screen.ok) throw new ExpectedError(screen.message);
    }
    pairName = `${nameFor(next1)} / ${nameFor(next2)}`;
    combinedElo = calculateTeamRating([eloFor(next1), eloFor(next2)]);
  } else {
    const { data: rating } = await adminClient.from('ratings')
      .select('singles_elo')
      .eq('player_id', input.incoming[0]!)
      .maybeSingle();
    eloBefore = rating?.singles_elo ?? null;
  }

  const { data, error } = await adminClient.rpc('substitute_event_entry', {
    p_event_id: event.id,
    p_entry_id: input.entryId,
    p_kind: input.kind,
    p_outgoing: input.outgoing,
    p_incoming: input.incoming,
    p_note: note as string,
    p_actor: actorId,
    p_allow_restricted: allowRestricted,
    ...(pairName != null ? { p_pair_name: pairName } : {}),
    ...(combinedElo != null ? { p_combined_elo: combinedElo } : {}),
    ...(eloBefore != null ? { p_elo_before: eloBefore } : {}),
  });
  if (error) {
    if (['PGRST202', '42883'].includes(error.code ?? '')) throw new ExpectedError('Run migration 00327 first');
    Sentry.captureException(error);
    throw new Error(error.message);
  }
  const result = data as { ok: boolean; reason?: string; kept?: number; moved?: number; is_pair?: boolean } | null;
  if (!result?.ok) {
    const reason = result?.reason ?? '';
    if (reason === 'event_not_found') throw new Error('Event not found');
    throw new ExpectedError(REFUSALS[reason] ?? 'Could not make the substitution.');
  }

  // NO FEE HERE. The incoming people were entered as spares first, and that
  // entry made the fee decision: an exec or a guest the desk let in free has
  // no fee row, and ensureEntryFees would charge them.
  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'event_substitution_made',
    performed_by: actorId,
    details: {
      kind: input.kind,
      entry_id: input.entryId,
      outgoing_player_ids: input.outgoing,
      incoming_player_ids: input.incoming,
      kept: result.kept ?? 0,
      moved: result.moved ?? 0,
      by: desk ? 'desk' : 'day_lead',
      restriction_overridden: allowRestricted,
    },
  });
  revalidateEventPaths(event.tournament_id, event.id);
  return { entryId: input.entryId, isPair: doubles, kept: result.kept ?? 0, moved: result.moved ?? 0 };
}

export async function substituteEntry(eventId: string, input: SubstitutionInput): Promise<ActionResult<SubstitutionResult>> {
  return runAction(() => substituteEntryImpl(eventId, input));
}
