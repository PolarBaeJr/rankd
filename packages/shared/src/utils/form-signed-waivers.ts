import type { SupabaseClient } from '@supabase/supabase-js';
import type { AcceptedEventWaiver } from './event-waiver-eligibility';

/**
 * Who signed a tournament's event waiver on the Google Form instead (00292).
 *
 * A club event run as a tournament takes its sign-ups from the Form, and the
 * Form carries the waiver: members and guests sign it there. A guest has no
 * login to sign in the app at all. So everyone the Form entered into the linked
 * club event (entry 'entered', not undone) counts as signed, against whatever
 * waiver hash is current; an officer who rewrites the waiver text is not
 * re-asking anyone the Form already covered.
 *
 * Returned as acceptances so every waiver gate (the console's check-in and draw,
 * the member app's prompt and self check-in) reads them exactly like real ones.
 * Pass a service-role client: the member's own client cannot read the import. A failed read throws, as the real
 * acceptances read does: it is not "nobody signed".
 */
export async function formSignedWaivers(
  adminClient: SupabaseClient,
  tournamentId: string,
  requiredHash: string,
): Promise<AcceptedEventWaiver[]> {
  const { data: events, error: eventsError } = await adminClient
    .from('tournament_events')
    .select('id')
    .eq('tournament_id', tournamentId);
  if (eventsError) throw new Error('Could not check who signed the waiver on the Form. Nothing was changed. Try again.');
  const eventIds = (events ?? []).map((e) => e.id as string);
  if (eventIds.length === 0) return [];

  // club_events.tournament_event_id is 00292's column, newer than the
  // generated types, so this read is untyped.
  const { data: clubEvents, error: clubError } = await adminClient
    .from('club_events')
    .select('id')
    .in('tournament_event_id' as never, eventIds);
  if (clubError) throw new Error('Could not check who signed the waiver on the Form. Nothing was changed. Try again.');
  const clubEventIds = ((clubEvents ?? []) as { id: string }[]).map((e) => e.id);
  if (clubEventIds.length === 0) return [];

  const { data: entries, error: entriesError } = await adminClient
    .from('registration_import_entries')
    .select('entrant_id, created_at')
    .in('club_event_id', clubEventIds)
    .eq('status', 'entered')
    .is('undone_at', null)
    .not('entrant_id', 'is', null);
  if (entriesError) throw new Error('Could not check who signed the waiver on the Form. Nothing was changed. Try again.');

  return ((entries ?? []) as { entrant_id: string; created_at: string }[]).map((e) => ({
    player_id: e.entrant_id,
    waiver_hash: requiredHash,
    accepted_at: e.created_at,
  }));
}
