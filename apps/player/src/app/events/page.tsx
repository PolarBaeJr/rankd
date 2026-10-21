import Link from "next/link";
import { PageHeader } from "@badminton/ui";
import { CalendarDays, Clock, MapPin } from "lucide-react";
import {
  CLUB_EVENT_KIND_LABELS,
  clubEventSignupState,
  formatClubEventCost,
  partitionClubEvents,
  type ClubEventKind,
} from "@badminton/shared";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
  getViewer,
} from "@/lib/supabase-server";
import {
  CLUB_EVENT_COLUMNS,
  SIGNUP_STATE_LABEL,
  clubDateParts,
  type ClubEventRow,
} from "@/lib/club-event-view";

export default async function ClubEventsPage() {
  const { player } = await getViewer();

  // Published and cancelled events only; a draft never reaches this page, and
  // created_by is never selected. A member reads through RLS, which already
  // filters; a signed-out visitor has no grant, so the service role reads with
  // the filter written out.
  const supabase = player ? await createServerSupabaseClient() : null;
  const { data: eventData } = await (supabase ?? createServiceRoleClient())
    .from("club_events")
    .select(CLUB_EVENT_COLUMNS)
    .in("status", ["published", "cancelled"])
    .order("starts_at", { ascending: true });
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
        createServiceRoleClient()
          .from("club_event_signups")
          .select("event_id")
          .in("event_id", ids),
        supabase && player
          ? supabase
              .from("club_event_signups")
              .select("event_id")
              .eq("player_id", player.id)
          : { data: [] },
      ])
    : [{ data: [] }, { data: [] }];
  const taken = new Map<string, number>();
  for (const row of (takenRows ?? []) as { event_id: string }[]) {
    taken.set(row.event_id, (taken.get(row.event_id) ?? 0) + 1);
  }
  const mine = new Set(
    ((mineRows ?? []) as { event_id: string }[]).map((r) => r.event_id),
  );

  function EventCard({
    event,
    past = false,
  }: {
    event: ClubEventRow;
    past?: boolean;
  }) {
    const count = taken.get(event.id) ?? 0;
    const state = clubEventSignupState(event, now, count, mine.has(event.id));
    const cost = formatClubEventCost(event.cost_cents);
    const when = clubDateParts(event.starts_at);
    const fill = event.capacity
      ? Math.min(100, Math.round((count / event.capacity) * 100))
      : 0;
    const stateTag =
      state === "going"
        ? "tag tag-win"
        : state === "cancelled" || state === "full"
          ? "tag tag-red"
          : "tag";
    return (
      <Link
        href={`/events/${event.id}`}
        className={`event-card press${past ? " past" : ""}`}
      >
        <div className="event-date">
          <span className="month">{when.month}</span>
          <span className="day">{when.day}</span>
          <span className="weekday">{when.weekday}</span>
        </div>
        <div
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            className="row"
            style={{
              gap: 8,
              alignItems: "flex-start",
              justifyContent: "space-between",
            }}
          >
            <div className="event-card-title">{event.title}</div>
            {!past && (
              <span className={stateTag} style={{ flexShrink: 0 }}>
                {SIGNUP_STATE_LABEL[state]}
              </span>
            )}
          </div>
          <div
            className="muted row"
            style={{ gap: 12, flexWrap: "wrap", fontSize: 13 }}
          >
            <span className="row" style={{ gap: 5 }}>
              <Clock size={13} /> {when.time}
            </span>
            {event.location && (
              <span className="row" style={{ gap: 5 }}>
                <MapPin size={13} /> {event.location}
              </span>
            )}
            <span>{cost ?? "Free"}</span>
          </div>
          {!past && event.capacity !== null && (
            <div style={{ display: "grid", gap: 4 }}>
              <div className="capacity-bar">
                <div
                  className={`fill${fill >= 100 ? " full" : fill >= 80 ? " warn" : ""}`}
                  style={{ width: `${fill}%` }}
                />
              </div>
              <span className="mono muted" style={{ fontSize: 11 }}>
                {count} of {event.capacity} places
              </span>
            </div>
          )}
          <span className="tag" style={{ alignSelf: "flex-start" }}>
            {CLUB_EVENT_KIND_LABELS[event.kind as ClubEventKind] ?? event.kind}
          </span>
        </div>
      </Link>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="CLUB EVENTS"
        title="Club events"
        sub="Socials, workshops, clinics, outings and the AGM."
        watermark="EVENTS"
      />
      {upcoming.length === 0 ? (
        <div className="card-base">
          <div className="empty">
            <CalendarDays
              size={36}
              style={{ display: "block", margin: "0 auto 12px" }}
            />
            Nothing is coming up yet. Check back soon.
          </div>
        </div>
      ) : (
        <section className="event-list">
          {upcoming.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </section>
      )}
      {past.length > 0 && (
        <>
          <div className="stat-label" style={{ margin: "32px 0 12px" }}>
            Past
          </div>
          <section className="event-list">
            {past.map((event) => (
              <EventCard key={event.id} event={event} past />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
