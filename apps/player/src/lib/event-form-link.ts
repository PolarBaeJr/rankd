import type { createServiceRoleClient } from './supabase-server';

// THE GOOGLE FORM A VISITOR SIGNS UP WITH. A signed-out visitor can see the
// club's events but not join one in the app; the event's form signs them up
// and enters them as a guest, the same path every non-member already takes
// (00284, 00292). The form is the one bound for import in the console.
//
// The link is built from the form's id. The id's /viewform address sends
// whoever opens it on to the form's public responder page, and the club's
// forms ask for a Google sign-in either way, so storing the responder address
// would gain nothing. Any read error is no link: the page then asks the
// visitor to sign in instead.

type Service = ReturnType<typeof createServiceRoleClient>;

const formLink = (formId: string) => `https://docs.google.com/forms/d/${encodeURIComponent(formId)}/viewform`;

async function firstActiveForm(service: Service, column: 'club_event_id' | 'tournament_id', ids: string[]) {
  if (ids.length === 0) return null;
  const { data, error } = await service
    .from('registration_import_forms' as never)
    .select('form_id')
    .in(column, ids)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return null;
  const formId = ((data ?? []) as { form_id: string }[])[0]?.form_id;
  return formId ? formLink(formId) : null;
}

/** A club event's form. */
export function clubEventFormLink(service: Service, eventId: string): Promise<string | null> {
  return firstActiveForm(service, 'club_event_id', [eventId]);
}

/**
 * A tournament's form: one bound to the tournament itself, or else the form
 * of a club event the tournament runs (00292), which signs people up there.
 */
export async function tournamentFormLink(service: Service, tournamentId: string): Promise<string | null> {
  const own = await firstActiveForm(service, 'tournament_id', [tournamentId]);
  if (own) return own;
  const { data: events } = await service.from('tournament_events').select('id').eq('tournament_id', tournamentId);
  const eventIds = ((events ?? []) as { id: string }[]).map((row) => row.id);
  if (eventIds.length === 0) return null;
  const { data: linked, error } = await service
    .from('club_events')
    .select('id')
    .in('tournament_event_id' as never, eventIds as never);
  if (error) return null;
  return firstActiveForm(service, 'club_event_id', ((linked ?? []) as { id: string }[]).map((row) => row.id));
}
