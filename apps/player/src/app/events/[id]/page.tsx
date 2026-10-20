import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PageHeader, Badge } from '@badminton/ui';
import {
  CLUB_EVENT_KIND_LABELS,
  clubEventSignupState,
  formatClubEventCost,
  formatClubEventTime,
  isUuid,
  type ClubEventKind,
} from '@badminton/shared';
import { createServerSupabaseClient, createServiceRoleClient, getViewer } from '@/lib/supabase-server';
import { CLUB_EVENT_COLUMNS, SIGNUP_STATE_LABEL, type ClubEventRow } from '@/lib/club-event-view';
import { SignupButton } from './signup-button';

export default async function ClubEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { player } = await getViewer();
  if (!player) redirect('/login');

  // A draft is not found here too: RLS hides it.
  const supabase = await createServerSupabaseClient();
  const { data: eventData } = await supabase
    .from('club_events')
    .select(CLUB_EVENT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  const event = eventData as ClubEventRow | null;
  if (!event) notFound();

  const [{ count: takenCount }, { data: mineRow }] = await Promise.all([
    createServiceRoleClient()
      .from('club_event_signups')
      .select('player_id', { count: 'exact', head: true })
      .eq('event_id', id),
    supabase
      .from('club_event_signups')
      .select('event_id')
      .eq('event_id', id)
      .eq('player_id', player.id)
      .maybeSingle(),
  ]);
  const taken = takenCount ?? 0;
  const state = clubEventSignupState(event, new Date(), taken, mineRow !== null);
  const cost = formatClubEventCost(event.cost_cents);

  // The tournament this event runs on (00292), once the exec has activated it:
  // the draw and results live there. Read with the service role, because the
  // link column is not one members are granted. Any error (before 00292): none.
  const { data: linkData } = await createServiceRoleClient()
    .from('club_events')
    .select('tournament_event:tournament_events(tournament_id, tournament:tournaments(status))')
    .eq('id', id)
    .maybeSingle();
  const linkedEvent = (linkData as {
    tournament_event: { tournament_id: string; tournament: { status: string } | null } | null;
  } | null)?.tournament_event;
  const drawHref =
    linkedEvent && linkedEvent.tournament && linkedEvent.tournament.status !== 'draft'
      ? `/tournaments/${linkedEvent.tournament_id}`
      : null;

  return (
    <div>
      <PageHeader
        title={event.title}
        sub={<Link href="/events">All club events</Link>}
      />
      {event.status === 'cancelled' && (
        <div
          role="status"
          style={{
            padding: 14,
            marginBottom: 16,
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-lg)',
            background: 'var(--surface)',
          }}
        >
          <strong>This event is cancelled.</strong>
          {event.cancelled_reason && <div style={{ marginTop: 4 }}>{event.cancelled_reason}</div>}
        </div>
      )}
      <div style={{ display: 'grid', gap: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Badge variant="neutral">{CLUB_EVENT_KIND_LABELS[event.kind as ClubEventKind] ?? event.kind}</Badge>
          <Badge variant={state === 'going' ? 'success' : state === 'cancelled' ? 'danger' : 'neutral'}>
            {SIGNUP_STATE_LABEL[state]}
          </Badge>
        </div>
        <div>
          {formatClubEventTime(event.starts_at)}
          {event.ends_at ? ` to ${formatClubEventTime(event.ends_at)}` : ''}
        </div>
        {event.location && <div>{event.location}</div>}
        <div className="muted">
          {event.capacity === null ? `${taken} going` : `${taken} of ${event.capacity} places taken`}
        </div>
        {cost && <div className="muted">Cost: {cost}</div>}
        {event.signup_closes_at && (
          <div className="muted">Sign-ups close {formatClubEventTime(event.signup_closes_at)}</div>
        )}
        {event.description && <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{event.description}</p>}
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          <SignupButton eventId={event.id} state={state} />
          {drawHref && (
            <Link href={drawHref} className="btn btn-ghost">
              See the draw
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
