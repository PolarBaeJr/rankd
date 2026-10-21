import Link from 'next/link';
import { PageHeader } from '@badminton/ui';
import { CalendarDays, Clock, MapPin } from 'lucide-react';
import {
  CLUB_EVENT_KIND_LABELS,
  clubEventSignupState,
  formatClubEventCost,
  partitionClubEvents,
  type ClubEventKind,
  type ClubEventSignupState,
} from '@badminton/shared';
import { createServerSupabaseClient, createServiceRoleClient, getViewer } from '@/lib/supabase-server';
import { CLUB_EVENT_COLUMNS, SIGNUP_STATE_LABEL, clubDateParts, type ClubEventRow } from '@/lib/club-event-view';

type Show = 'upcoming' | 'going' | 'past';

export default async function ClubEventsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { player } = await getViewer();
  const requested = (await searchParams).show;
  // Going is a member's own list; a visitor asking for it gets Upcoming.
  const show: Show = requested === 'past' ? 'past' : requested === 'going' && player ? 'going' : 'upcoming';

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
  // The places taken as the sign-up RPC counts them (guests in, no-shows out,
  // 00294), as the event page shows them. Before 00294 the row count stands.
  const service = createServiceRoleClient();
  await Promise.all(
    ids.map(async (id) => {
      const { data, error } = await service.rpc('club_event_taken' as never, { p_event_id: id } as never);
      if (!error && typeof data === 'number') taken.set(id, data);
    }),
  );
  const mine = new Set(((mineRows ?? []) as { event_id: string }[]).map((r) => r.event_id));

  const card = (event: ClubEventRow, past = false) => {
    const count = taken.get(event.id) ?? 0;
    const state = clubEventSignupState(event, now, count, mine.has(event.id));
    return { count, state, when: clubDateParts(event.starts_at), cost: formatClubEventCost(event.cost_cents) ?? 'Free', past };
  };
  const tagOf = (state: ClubEventSignupState) =>
    state === 'going' ? 'tag tag-win' : state === 'cancelled' || state === 'full' ? 'tag tag-red' : 'tag';
  const fillOf = (event: ClubEventRow, count: number) =>
    event.capacity ? Math.min(100, Math.round((count / event.capacity) * 100)) : 0;
  const kindOf = (event: ClubEventRow) => CLUB_EVENT_KIND_LABELS[event.kind as ClubEventKind] ?? event.kind;

  const list = show === 'past' ? [...past].reverse() : show === 'going' ? upcoming.filter((e) => mine.has(e.id)) : upcoming;
  // Upcoming leads with the next event as a large card.
  const featured = show === 'upcoming' ? list[0] : undefined;
  const rest = featured ? list.slice(1) : list;

  function Featured({ event }: { event: ClubEventRow }) {
    const { count, state, when, cost } = card(event);
    const fill = fillOf(event, count);
    const left = event.capacity === null ? null : Math.max(0, event.capacity - count);
    return (
      <Link href={`/events/${event.id}`} className="ev-feature press">
        <div className="ev-date">
          <div className="month">{when.month}</div>
          <div className="day">{when.day}</div>
          <div className="weekday">{when.weekday}</div>
        </div>
        <div style={{ flex: '999 1 360px', minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span className="ev-label red">Next up · {kindOf(event)}</span>
            <span className={tagOf(state)}>{SIGNUP_STATE_LABEL[state]}</span>
          </div>
          <div className="ev-feature-title">{event.title}</div>
          <div className="ev-meta" style={{ marginTop: 0 }}>
            <span>
              <Clock size={15} /> {when.time}
            </span>
            {event.location && (
              <span>
                <MapPin size={15} /> {event.location}
              </span>
            )}
            <span>{cost}</span>
          </div>
        </div>
        {event.capacity !== null && (
          <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
            <div className="ev-places">
              <span className="ev-label">Places</span>
              <span className="mono" style={{ fontSize: 13 }}>
                {count} / {event.capacity}
              </span>
            </div>
            <div className="capacity-bar" style={{ height: 8 }}>
              <div className={`fill${fill >= 100 ? ' full' : fill >= 80 ? ' warn' : ''}`} style={{ width: `${fill}%` }} />
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {left === 0 ? 'Full' : `${left} ${left === 1 ? 'place' : 'places'} left`}
            </div>
          </div>
        )}
      </Link>
    );
  }

  function EventCard({ event, isPast }: { event: ClubEventRow; isPast: boolean }) {
    const { count, state, when, cost } = card(event);
    const fill = fillOf(event, count);
    return (
      <Link href={`/events/${event.id}`} className={`ev-card press${isPast ? ' past' : ''}`}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div className="row" style={{ gap: 14 }}>
            <div className="ev-date sm">
              <div className="month">{when.month}</div>
              <div className="day">{when.day}</div>
              <div className="weekday">{when.weekday}</div>
            </div>
            <span className="ev-label">{kindOf(event)}</span>
          </div>
          {!isPast && (
            <span className={tagOf(state)} style={{ flexShrink: 0 }}>
              {SIGNUP_STATE_LABEL[state]}
            </span>
          )}
        </div>
        <div className="ev-card-title">{event.title}</div>
        <div className="muted" style={{ fontSize: 14 }}>
          {[when.time, event.location, cost].filter(Boolean).join(' · ')}
        </div>
        {!isPast && event.capacity !== null && (
          <div className="capacity-bar">
            <div className={`fill${fill >= 100 ? ' full' : fill >= 80 ? ' warn' : ''}`} style={{ width: `${fill}%` }} />
          </div>
        )}
      </Link>
    );
  }

  const tabs: { id: Show; label: string }[] = [
    { id: 'upcoming', label: 'Upcoming' },
    ...(player ? [{ id: 'going' as const, label: 'Going' }] : []),
    { id: 'past', label: 'Past' },
  ];
  const empty =
    show === 'past'
      ? 'No past events yet.'
      : show === 'going'
        ? 'You are not signed up for anything coming up.'
        : 'Nothing is coming up yet. Check back soon.';

  return (
    <div>
      <div className="ev-head">
        <PageHeader eyebrow="CLUB EVENTS" title="Club events" sub="Socials, workshops, clinics, outings and the AGM." />
        <nav className="ev-tabs" aria-label="Which events">
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              href={tab.id === 'upcoming' ? '/events' : `/events?show=${tab.id}`}
              aria-current={show === tab.id ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>
      {list.length === 0 ? (
        <div className="card-base">
          <div className="empty">
            <CalendarDays size={36} style={{ display: 'block', margin: '0 auto 12px' }} />
            {empty}
          </div>
        </div>
      ) : (
        <>
          {featured && <Featured event={featured} />}
          {rest.length > 0 && (
            <>
              {featured && (
                <div className="ev-label" style={{ margin: '36px 0 14px' }}>
                  Later on
                </div>
              )}
              <section className="ev-grid">
                {rest.map((event) => (
                  <EventCard key={event.id} event={event} isPast={show === 'past'} />
                ))}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
