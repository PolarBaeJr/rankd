// COURT HELPERS (00310). Server side only, and NOT 'use server': the rule for
// who may save a courtside score, and the reads the pages and the actions
// share.
//
// Every read here degrades on a database older than 00310, so the tournament
// page and /my-courts still render before the migration is run.

import { hasConsoleAccess } from './permissions';
import { isCourtsSchemaMissing } from './tournament-courts';
import type { createAdminClient } from './supabase-server';

type AdminClient = ReturnType<typeof createAdminClient>;

export const COURT_HELPERS_MIGRATION_MISSING = 'Run migration 00310 first';

export type CourtHelperDecision =
  | { kind: 'desk' }
  | { kind: 'helper'; courtId: string }
  | { kind: 'refuse'; reason: string };

/**
 * May this person save this match's score, and on what authority. The desk's
 * capability wins outright; otherwise the match has to be live on a court the
 * person helps on, in a staged event.
 */
export function courtHelperDecision(input: {
  canDesk: boolean;
  match: { status: string; stage: number | null; court_id: string | null } | null;
  eventFormat: string | null | undefined;
  hasHelperRow: boolean;
}): CourtHelperDecision {
  if (input.canDesk) return { kind: 'desk' };
  const { match } = input;
  if (!match) return { kind: 'refuse', reason: 'Match not found' };
  if (match.court_id == null) return { kind: 'refuse', reason: 'This match is not on a court.' };
  if (match.status !== 'live') return { kind: 'refuse', reason: 'This match is not being played right now. Reload to see your courts.' };
  if (match.stage == null || input.eventFormat !== 'staged') {
    return { kind: 'refuse', reason: 'Courtside scoring is for staged events.' };
  }
  if (!input.hasHelperRow) return { kind: 'refuse', reason: 'You are not helping on this match\'s court.' };
  return { kind: 'helper', courtId: match.court_id };
}

export interface CourtHelper {
  court_id: string;
  player_id: string;
  full_name: string;
}

/** Everyone helping on this tournament's courts; null before 00310. */
export async function readCourtHelpers(client: AdminClient, tournamentId: string): Promise<CourtHelper[] | null> {
  const { data, error } = await client
    .from('tournament_court_helpers')
    .select('court_id, player_id, player:players!tournament_court_helpers_player_id_fkey(id, full_name)')
    .eq('tournament_id', tournamentId);
  if (isCourtsSchemaMissing(error)) return null;
  if (error) throw new Error(`Could not read this tournament's court helpers: ${error.message}`);
  return (data ?? []).map((row) => {
    const player = (Array.isArray(row.player) ? row.player[0] : row.player) as { full_name?: string | null } | null;
    return { court_id: row.court_id as string, player_id: row.player_id as string, full_name: player?.full_name ?? 'Unknown' };
  });
}

export interface HelperCandidate {
  id: string;
  full_name: string;
}

/** Console members in good standing, who are the only people who may help on a court. */
export async function readHelperCandidates(client: AdminClient): Promise<HelperCandidate[]> {
  const { data, error } = await client
    .from('players')
    .select('id, full_name, role, is_exec, is_trainer, is_banned, status, active_flag')
    .or('role.eq.admin,is_exec.eq.true,is_trainer.eq.true')
    .order('full_name');
  if (error) throw new Error(`Could not read the console members: ${error.message}`);
  return (data ?? [])
    .filter((p) => hasConsoleAccess(p))
    .map((p) => ({ id: p.id as string, full_name: (p.full_name as string | null) ?? 'Unknown' }));
}

export interface MyCourt {
  court_id: string;
  tournament_id: string;
  tournament_name: string;
}

/**
 * The courts this person helps on in tournaments still running; empty before 00310.
 * Draft counts: a draft tournament can still check in, draw and start its events.
 */
export async function readMyCourts(client: AdminClient, playerId: string): Promise<MyCourt[]> {
  const { data, error } = await client
    .from('tournament_court_helpers')
    .select('court_id, tournament_id, tournament:tournaments!tournament_court_helpers_tournament_id_fkey!inner(id, name, status)')
    .eq('player_id', playerId)
    .in('tournament.status', ['draft', 'active']);
  if (isCourtsSchemaMissing(error)) return [];
  if (error) throw new Error(`Could not read your courts: ${error.message}`);
  return (data ?? []).map((row) => {
    const tournament = (Array.isArray(row.tournament) ? row.tournament[0] : row.tournament) as { name?: string | null } | null;
    return {
      court_id: row.court_id as string,
      tournament_id: row.tournament_id as string,
      tournament_name: tournament?.name ?? 'Tournament',
    };
  });
}

/** Does this person help on this court? False before 00310. */
export async function hasHelperRow(client: AdminClient, courtId: string, playerId: string): Promise<boolean> {
  const { data, error } = await client
    .from('tournament_court_helpers')
    .select('id')
    .eq('court_id', courtId)
    .eq('player_id', playerId)
    .maybeSingle();
  if (isCourtsSchemaMissing(error)) return false;
  if (error) throw new Error(`Could not check who helps on this court: ${error.message}`);
  return !!data;
}
