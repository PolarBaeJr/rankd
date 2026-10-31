'use server';

// COURT HELPERS (00310): naming a console member to keep score on a court, and
// taking them off it. A helper enters the result of the match on that court
// from /my-courts (enterCourtHelperResult in ./results.ts).
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
import { COURT_HELPERS_MIGRATION_MISSING } from '../court-helpers';
import { requireCapability, assertTournamentNotSuspended } from './_internal';

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
