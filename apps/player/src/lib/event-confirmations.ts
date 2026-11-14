import * as Sentry from '@sentry/nextjs';
import { confirmationWindow, eventStartInstant } from '@badminton/shared';
import { createServiceRoleClient } from './supabase-server';

// "CONFIRM YOUR PLACE" (00325), the member's side. The table is service-role
// only, so a request-scoped read would come back empty with no error and the
// banner would never show; every read here is filtered by the caller's own
// player id instead. Never throws: a missing migration is "nothing to
// confirm", anything else goes to Sentry and is the same.

export interface PendingConfirmation {
  eventId: string;
  tournamentId: string;
  tournamentName: string;
  eventType: string;
  deadlineAt: string | null;
}

type EmbeddedEvent = {
  id: string;
  tournament_id: string;
  event_type: string;
  confirm_deadline_hours: number | null;
  tournament: { name: string; start_date: string | null; starts_time: string | null; status: string | null } | null;
};

function one<T>(embed: T | T[] | null | undefined): T | null {
  return Array.isArray(embed) ? embed[0] ?? null : embed ?? null;
}

export async function loadMyPendingConfirmations(
  playerId: string,
  eventId?: string,
): Promise<PendingConfirmation[]> {
  try {
    let query = createServiceRoleClient()
      .from('tournament_event_confirmations')
      .select(
        'event_id, status, event:tournament_events!tournament_event_confirmations_event_id_fkey(id, tournament_id, event_type, confirm_deadline_hours, tournament:tournaments!tournament_events_tournament_id_fkey(name, start_date, starts_time, status))',
      )
      .eq('player_id', playerId)
      .in('status', ['pending', 'unreached']);
    if (eventId) query = query.eq('event_id', eventId);
    const { data, error } = await query;
    if (error) {
      if (['42P01', '42703', 'PGRST205'].includes(error.code ?? '')) return [];
      Sentry.captureException(new Error(`Could not read pending confirmations: ${error.message}`));
      return [];
    }
    const out: PendingConfirmation[] = [];
    for (const row of (data ?? []) as unknown as Array<{ event_id: string; event: EmbeddedEvent | EmbeddedEvent[] | null }>) {
      const event = one(row.event);
      const tournament = one(event?.tournament);
      if (!event || !tournament || tournament.status === 'draft') continue;
      out.push({
        eventId: event.id,
        tournamentId: event.tournament_id,
        tournamentName: tournament.name,
        eventType: event.event_type,
        deadlineAt: tournament.start_date && event.confirm_deadline_hours != null
          ? confirmationWindow(eventStartInstant(tournament.start_date, tournament.starts_time), 0, event.confirm_deadline_hours).deadlineAt.toISOString()
          : null,
      });
    }
    return out;
  } catch (err) {
    Sentry.captureException(err);
    return [];
  }
}
