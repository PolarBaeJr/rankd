import Link from 'next/link';
import { PageHeader, Badge } from '@badminton/ui';
import {
  CLUB_EVENT_KIND_LABELS,
  clubEventSignupState,
  formatClubEventCost,
  formatClubEventTime,
  partitionClubEvents,
  type ClubEventKind,
} from '@badminton/shared';
import { createServerSupabaseClient, createServiceRoleClient, getViewer } from '@/lib/supabase-server';
import { CLUB_EVENT_COLUMNS, SIGNUP_STATE_LABEL, type ClubEventRow } from '@/lib/club-event-view';

export default async function ClubEventsPage() {
  const { player } = await getViewer();

  // Published and cancelled events only; a draft never reaches this page, and
  // created_by is never selected. A member reads through RLS, which already
  // filters; a signed-out visitor has no grant, so the service role reads with
  // the filter written out.
  const supabase = player ? await createServerSupabaseClient() : null;
  const { data: eventData } = await (supabase ?? createServiceRoleClient())
    .from('club_events')
    .select(CLUB_EVENT_COLUMNS)
    .in('status', ['published', 'cancelled'])
    .order('starts_at', { ascending: true });
  const events = (eventData ?? []) as ClubEventRow[];
  const now = new Date();
  const { upcoming, past } = partitionClubEvents(events, now);
  // Only an upcoming event's places can still matter: a past one reads as
  // started whatever its count.
  const ids = upcoming.map((e) => e.id);

  // How many places are taken is not something a member may read row by row,
  // so the count comes through the service role and only the number leaves.
  const [{ data: takenRows }, { data: mineRows }] = ids.length
    ? await Promise.all([
        createServiceRoleClient().from('club_event_signups').select('event_id').in('event_id', ids),
        supabase && player
          ? supabase.from('club_event_signups').select('event_id').eq('player_id', player.id)
          : { data: [] },
      ])
    : [{ data: [] }, { data: [] }];
  const taken = new Map<string, number>();
  for (const row of (takenRows ?? []) as { event_id: string }[]) {
    taken.set(row.event_id, (taken.get(row.event_id) ?? 0) + 1);
  }
  const mine = new Set(((mineRows ?? []) as { event_id: string }[]).map((r) => r.event_id));

  function EventCard({ event }: { event: ClubEventRow }) {
    const state = clubEventSignupState(event, now, taken.get(event.id) ?? 0, mine.has(event.id));
    const cost = formatClubEventCost(event.cost_cents);
    return (
      <Link
        href={`/events/${event.id}`}
        className="press"
        style={{
          display: 'block',
          padding: 18,
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--surface)',
        }}
      >
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <strong>{event.title}</strong>
          <Badge variant={state === 'going' ? 'success' : state === 'cancelled' ? 'danger' : 'neutral'}>
            {SIGNUP_STATE_LABEL[state]}
          </Badge>
        </div>
        <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
          {CLUB_EVENT_KIND_LABELS[event.kind as ClubEventKind] ?? event.kind} · {formatClubEventTime(event.starts_at)}
          {event.location ? ` · ${event.location}` : ''}
          {cost ? ` · ${cost}` : ''}
        </div>
      </Link>
    );
  }

  return (
    <div>
      <PageHeader title="Club events" sub="Socials, workshops, clinics, outings and the AGM." />
      <section style={{ display: 'grid', gap: 12 }}>
        {upcoming.length === 0 ? (
          <p className="muted">Nothing is coming up yet.</p>
        ) : (
          upcoming.map((event) => <EventCard key={event.id} event={event} />)
        )}
      </section>
      {past.length > 0 && (
        <section style={{ display: 'grid', gap: 12, marginTop: 28 }}>
          <h2 className="mono muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em' }}>
            Past
          </h2>
          {past.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </section>
      )}
    </div>
  );
}
