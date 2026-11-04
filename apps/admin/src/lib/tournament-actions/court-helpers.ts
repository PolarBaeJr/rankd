'use server';

// COURT HELPERS (00310): naming a console member to keep score on a court, and
// taking them off it. A helper enters the result of the match on that court
// from /my-courts (enterCourtHelperResult in ./results.ts), or skips it for now
// when a team is not there (00314).
//
// Every courtId and playerId below is a client-controlled POST field, so the
// court is read back for the tournament it really belongs to, and the person
// is read back for their console access.

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { ExpectedError } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { hasConsoleAccess } from '../permissions';
import { COURTS_MIGRATION_MISSING, isCourtsSchemaMissing } from '../tournament-courts';
import { COURT_HELPERS_MIGRATION_MISSING, courtHelperDecision, hasHelperRow } from '../court-helpers';
import { requireConsoleUser } from '../court-helper-gate';
import { permits } from '../permissions';
import { requireCapability, assertTournamentNotSuspended, revalidateEventPaths } from './_internal';
import { fillFreeCourts, type AutoCallEvent, type AutoCallReport } from './auto-call';

type AdminClient = ReturnType<typeof createAdminClient>;

// The same key as editing the courts themselves (./courts.ts).
const CAPABILITY = 'tournaments.manage.update.write';

/** The court, and the tournament it really belongs to. */
async function readCourt(adminClient: AdminClient, courtId: string): Promise<{ id: string; tournament_id: string; label: string }> {
  const { data, error } = await adminClient
    .from('tournament_courts')
    .select('id, tournament_id, label')
    .eq('id', courtId)
    .maybeSingle();
  if (isCourtsSchemaMissing(error)) throw new ExpectedError(COURTS_MIGRATION_MISSING);
  if (error) throw new Error(`Could not read the court: ${error.message}`);
  if (!data) throw new ExpectedError('Court not found');
  return data;
}

function revalidateHelperPaths(tournamentId: string): void {
  revalidatePath(`/tournaments/${tournamentId}`);
  revalidatePath('/my-courts');
}

export async function addCourtHelper(courtId: string, playerId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await addCourtHelperImpl(courtId, playerId); });
}

async function addCourtHelperImpl(courtId: string, playerId: string) {
  const admin = await requireCapability(CAPABILITY);
  const adminClient = createAdminClient();
  const court = await readCourt(adminClient, courtId);
  await assertTournamentNotSuspended(adminClient, court.tournament_id);

  const { data: target, error: targetError } = await adminClient
    .from('players')
    .select('id, role, is_exec, is_trainer, is_banned, status, active_flag')
    .eq('id', playerId)
    .maybeSingle();
  if (targetError) throw new Error(`Could not read that member: ${targetError.message}`);
  if (!target || !hasConsoleAccess(target)) throw new ExpectedError('Only console members can help on a court.');

  const { error } = await adminClient
    .from('tournament_court_helpers')
    .insert({ tournament_id: court.tournament_id, court_id: courtId, player_id: playerId, created_by: admin.id });
  if (error?.code === '23505') throw new ExpectedError('Already helping on this court.');
  if (isCourtsSchemaMissing(error)) throw new ExpectedError(COURT_HELPERS_MIGRATION_MISSING);
  if (error) {
    Sentry.captureException(error);
    throw new Error(`Could not add the helper: ${error.message}`);
  }

  await logAudit(adminClient, {
    tournament_id: court.tournament_id,
    action: 'court_helper_added',
    performed_by: admin.id,
    details: { court_id: courtId, player_id: playerId },
  });
  revalidateHelperPaths(court.tournament_id);
}

export async function removeCourtHelper(courtId: string, playerId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await removeCourtHelperImpl(courtId, playerId); });
}

async function removeCourtHelperImpl(courtId: string, playerId: string) {
  const admin = await requireCapability(CAPABILITY);
  const adminClient = createAdminClient();
  const court = await readCourt(adminClient, courtId);
  await assertTournamentNotSuspended(adminClient, court.tournament_id);

  const { data: removed, error } = await adminClient
    .from('tournament_court_helpers')
    .delete()
    .eq('court_id', courtId)
    .eq('player_id', playerId)
    .select('id');
  if (isCourtsSchemaMissing(error)) throw new ExpectedError(COURT_HELPERS_MIGRATION_MISSING);
  if (error) {
    Sentry.captureException(error);
    throw new Error(`Could not remove the helper: ${error.message}`);
  }
  // Already gone, by another officer: nothing was removed, so nothing is audited.
  if ((removed ?? []).length === 0) {
    revalidateHelperPaths(court.tournament_id);
    return;
  }

  await logAudit(adminClient, {
    tournament_id: court.tournament_id,
    action: 'court_helper_removed',
    performed_by: admin.id,
    details: { court_id: courtId, player_id: playerId },
  });
  revalidateHelperPaths(court.tournament_id);
}

/**
 * SKIP FOR NOW (00314): a team is not at the court, so the match comes off it
 * and waits behind every other match that court can take, and the next one
 * goes on. The desk may skip any live match; a helper only the one on their
 * own court, by the same rule as saving its score. `back` is true when nothing
 * else could go on, so the skipped match was called straight back.
 */
export async function skipMatchForNow(
  matchId: string,
): Promise<ActionResult<{ autoCall: AutoCallReport | null; back: boolean }>> {
  return runAction(() => skipMatchForNowImpl(matchId));
}

async function skipMatchForNowImpl(matchId: string) {
  const { viewer, level, permissions } = await requireConsoleUser();
  const actorId = viewer.id as string;
  const adminClient = createAdminClient();

  const { data: match, error: readError } = await adminClient
    .from('tournament_matches')
    .select('id, status, stage, court_id, event_id, event:tournament_events(id, tournament_id, format, format_config, status, event_type)')
    .eq('id', matchId)
    .maybeSingle();
  if (readError) throw new Error(`Could not read the match: ${readError.message}`);
  if (!match) throw new ExpectedError('Match not found');
  const embed = match.event as unknown as AutoCallEvent | AutoCallEvent[] | null;
  const event = Array.isArray(embed) ? embed[0] : embed;
  if (!event) throw new Error('Match is not attached to an event');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const courtId = (match.court_id as string | null) ?? null;
  const decision = courtHelperDecision({
    canDesk: false,
    match: { status: match.status as string, stage: (match.stage as number | null) ?? null, court_id: courtId },
    eventFormat: event.format,
    hasHelperRow: courtId && !permits(level, permissions, 'tournaments.results.enter.write')
      ? await hasHelperRow(adminClient, courtId, actorId)
      : true,
  });
  if (decision.kind === 'refuse') throw new ExpectedError(decision.reason);

  // Off court only if it is still the live match on this court: a score saved
  // or a move made in the meantime is refused rather than undone.
  const { data: skipped, error } = await adminClient
    .from('tournament_matches')
    .update({ status: 'ready', deferred_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', matchId)
    .eq('status', 'live')
    .eq('court_id', courtId!)
    .select('id')
    .maybeSingle();
  if (error?.code === '42703') throw new ExpectedError('Run migration 00314 first');
  if (error) {
    Sentry.captureException(error);
    throw new Error(`Could not skip the match: ${error.message}`);
  }
  if (!skipped) throw new ExpectedError('This match changed in the meantime. Reload to see the court.');

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    match_id: matchId,
    action: 'match_start_undone',
    performed_by: actorId,
    details: { previous_status: 'live', skipped_for_now: true, court_id: courtId },
  });

  let autoCall: AutoCallReport | null = null;
  try {
    autoCall = await fillFreeCourts(adminClient, { event, actorId, trigger: 'skip', preferCourtId: courtId });
  } catch (err) {
    Sentry.captureException(err);
    autoCall = { called: [], failed: [{ court: null, reason: err instanceof Error ? err.message : 'Unknown error' }] };
  }

  revalidateEventPaths(event.tournament_id, event.id);
  revalidatePath('/my-courts');
  return { autoCall, back: !!autoCall?.called.some((c) => c.matchId === matchId) };
}
