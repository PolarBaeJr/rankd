// PUTTING THE NEXT MATCH ON COURT BY ITSELF, for a staged event. A saved
// result, Start, and a stage drawn while the event is live each end by filling
// every free court with the next match it may take (planCourtCalls). Server
// side only, and NOT 'use server': every export of such a file is a POST
// endpoint, and these must only run inside an action that has already checked
// its caller.
//
// THE DESK CAPABILITY IS NOT CHECKED AGAIN, deliberately. The call is a
// consequence of an action the caller was authorised for (entering a result,
// or moving the event's status), and the audit rows say so with `auto: true`
// and the caller as performed_by. It also saves a second getUser round trip.
//
// ONLY WHEN THE TOURNAMENT LISTS ITS COURTS. The one-live-per-court index
// guards court_id alone, so a court typed as text could take two matches.

import * as Sentry from '@sentry/nextjs';
import {
  busyCourtIds,
  courtLabel,
  eventIsPlaying,
  isDoublesEvent,
  parseFormatConfig,
  type TournamentCourt,
  type TournamentEventType,
} from '@badminton/shared';
import type { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { readLiveCourtUse, readTournamentCourts } from '../tournament-courts';
import { deskRows, planCourtCalls, type AutoCallReport, type AutoCallTrigger, type DeskMatch } from '../live-desk';

export type { AutoCallReport, AutoCallTrigger } from '../live-desk';

type AdminClient = ReturnType<typeof createAdminClient>;

export interface AutoCallEvent {
  id: string;
  tournament_id: string;
  format: string | null;
  format_config: unknown;
  status: string;
  event_type: string;
}

/**
 * One match onto one court in one guarded write: the status it was read in,
 * and when it moves court, the court it was on. 'lost' when another desk got
 * there first (the row moved, or the court's one-live index refused it).
 */
export async function callMatchOnCourt(
  client: AdminClient,
  ctx: { actorId: string; tournamentId: string; eventId: string; trigger: AutoCallTrigger },
  m: DeskMatch,
  court: TournamentCourt,
): Promise<'called' | 'lost'> {
  const moving = m.court_id !== court.id;
  let update = client
    .from('tournament_matches')
    .update({
      status: 'live',
      updated_at: new Date().toISOString(),
      ...(moving ? { court: court.label, court_id: court.id } : {}),
    })
    .eq('id', m.id)
    .eq('status', m.status);
  if (moving) update = m.court_id ? update.eq('court_id', m.court_id) : update.is('court_id', null);
  const { data, error } = await update.select('id').maybeSingle();
  if (error?.code === '23505') return 'lost';
  if (error) throw new Error(error.message);
  if (!data) return 'lost';

  if (moving) {
    await logAudit(client, {
      tournament_id: ctx.tournamentId,
      event_id: ctx.eventId,
      match_id: m.id,
      action: 'match_court_set',
      performed_by: ctx.actorId,
      details: {
        previous_court: m.court,
        court: court.label,
        previous_court_id: m.court_id ?? null,
        court_id: court.id,
        auto: true,
        trigger: ctx.trigger,
      },
    });
  }
  await logAudit(client, {
    tournament_id: ctx.tournamentId,
    event_id: ctx.eventId,
    match_id: m.id,
    action: 'match_started',
    performed_by: ctx.actorId,
    details: { previous_status: m.status, auto: true, trigger: ctx.trigger },
  });
  return 'called';
}

/**
 * Every free court of the tournament given its next match from this event.
 * null when the event is not a staged one being played. A court that fails is
 * reported and the rest still filled; a court another desk filled is skipped.
 */
export async function fillFreeCourts(
  client: AdminClient,
  opts: { event: AutoCallEvent; actorId: string; trigger: AutoCallTrigger; preferCourtId?: string | null },
): Promise<AutoCallReport | null> {
  const { event, actorId, trigger, preferCourtId } = opts;
  if (event.format !== 'staged' || !eventIsPlaying(event.status)) return null;

  const courts = await readTournamentCourts(client, event.tournament_id);
  if (!courts || courts.length === 0) {
    return { called: [], failed: [], off: 'This tournament lists no courts, so the next match is not called automatically.' };
  }
  const busy = busyCourtIds(courts, (await readLiveCourtUse(client, event.tournament_id)) ?? []);

  const { data: matches, error } = await client
    .from('tournament_matches')
    .select('id, status, is_bye, phase, stage, pool_number, group_number, slot, match_label, round_number, round_name, match_number, bracket_position, court, court_id, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', event.id);
  if (error) throw new Error(`Could not read the event's matches: ${error.message}`);

  const rows = deskRows(
    (matches ?? []) as DeskMatch[],
    (id) => ({ entryId: id }),
    isDoublesEvent(event.event_type as TournamentEventType),
  );
  const plan = planCourtCalls(rows, courts, busy, parseFormatConfig(event.format_config), preferCourtId);

  const report: AutoCallReport = { called: [], failed: [] };
  const ctx = { actorId, tournamentId: event.tournament_id, eventId: event.id, trigger };
  for (const { row, court } of plan) {
    try {
      if ((await callMatchOnCourt(client, ctx, row.match, court)) === 'called') {
        report.called.push({ matchId: row.match.id, court: courtLabel(court.label) ?? court.label });
      }
    } catch (err) {
      Sentry.captureException(err);
      report.failed.push({ court: courtLabel(court.label), reason: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
  return report;
}
