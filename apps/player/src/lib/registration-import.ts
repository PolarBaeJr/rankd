import * as Sentry from '@sentry/nextjs';
import { ExpectedError, calculateTeamRating } from '@badminton/shared';
import type { createServiceRoleClient } from './supabase-server';

// A GOOGLE FORM ENTRY THAT WAITS FOR ITS MEMBER (00283).
//
// A form response that used a member's email never enters them: the database
// leaves an `awaiting_member` row and a notification, and the member confirms
// it here or says it was not them. Confirming runs the member's own self-entry
// path (registerForEvent / signUpForClubEvent), so the event waiver, the site
// legal documents, the solo-doubles acknowledgement and the fee are all the
// member's own act, exactly as if they had pressed Enter on the event page.
//
// These helpers are the database half, shared by the two confirm actions. Not
// a server action module: nothing here is callable from a client.

type Service = ReturnType<typeof createServiceRoleClient>;

export interface ImportEntryRow {
  id: string;
  status: string;
  entrant_id: string | null;
  tournament_event_id: string | null;
  club_event_id: string | null;
  requested_partner_id: string | null;
}

/**
 * The entry, only when it belongs to this member. Ownership is the database
 * row's `entrant_id`, never a parameter, so another member's entry id reads as
 * not found.
 */
export async function loadOwnImportEntry(
  service: Service,
  entryId: string,
  playerId: string,
): Promise<ImportEntryRow> {
  const { data, error } = await service
    .from('registration_import_entries')
    .select('id, status, entrant_id, tournament_event_id, club_event_id, requested_partner_id')
    .eq('id', entryId)
    .eq('entrant_id', playerId)
    .maybeSingle();
  if (error) {
    Sentry.captureException(error, { tags: { action: 'registrationImport', read: 'entry' } });
    throw new ExpectedError('That did not go through. Please try again shortly.');
  }
  if (!data) throw new ExpectedError('That entry could not be found.');
  return data as ImportEntryRow;
}

export interface SettleResult {
  ok: boolean;
  reason?: string;
  status?: string;
  partner_entry_id?: string;
  partner_player_id?: string;
}

/**
 * Marks the entry confirmed once the member is in the field. Answers
 * `not_entered` without writing anything while they are not, which is how the
 * confirm action learns it still has to enter them.
 */
export async function settleImportEntry(
  service: Service,
  entryId: string,
  playerId: string,
): Promise<SettleResult> {
  const { data, error } = await service.rpc('settle_registration_import_entry', {
    p_entry_id: entryId,
    p_player_id: playerId,
  });
  if (error) {
    Sentry.captureException(error, { tags: { action: 'registrationImport', rpc: 'settle' } });
    throw new ExpectedError('That did not go through. Please try again shortly.');
  }
  return (data ?? { ok: false, reason: 'not_found' }) as SettleResult;
}

/**
 * Both partners named each other and both are now in the pool: form the pair,
 * with the name and combined rating the console would give it.
 *
 * Never throws for a pairing the database refuses: the member is entered
 * either way, and an exec can still pair them by hand.
 */
export async function pairMutualImportEntries(
  service: Service,
  entryId: string,
  playerId: string,
  partnerId: string,
): Promise<boolean> {
  const [playersRes, ratingsRes] = await Promise.all([
    service.from('players').select('id, full_name').in('id', [playerId, partnerId]),
    service.from('ratings').select('player_id, doubles_elo').in('player_id', [playerId, partnerId]),
  ]);
  if (playersRes.error || ratingsRes.error) {
    Sentry.captureException(playersRes.error ?? ratingsRes.error, {
      tags: { action: 'registrationImport', read: 'pair' },
    });
    return false;
  }
  const name = (id: string) => playersRes.data?.find((p) => p.id === id)?.full_name ?? '';
  const elo = (id: string) => ratingsRes.data?.find((r) => r.player_id === id)?.doubles_elo ?? 400;
  const { data, error } = await service.rpc('pair_registration_import_entries', {
    p_entry_id: entryId,
    p_player_id: playerId,
    p_pair_name: `${name(playerId)} / ${name(partnerId)}`,
    p_combined_elo: calculateTeamRating([elo(playerId), elo(partnerId)]),
  });
  if (error) {
    Sentry.captureException(error, { tags: { action: 'registrationImport', rpc: 'pair' } });
    return false;
  }
  return (data as { ok?: boolean } | null)?.ok === true;
}

/** The sentence for a settle that did not land on a confirmed entry. */
export function settleRefusal(result: SettleResult): string {
  if (result.reason === 'not_waiting') return 'This entry is no longer waiting for you.';
  if (result.reason === 'not_found') return 'That entry could not be found.';
  return 'That did not go through. Please try again shortly.';
}
