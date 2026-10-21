import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, MapPin } from "lucide-react";
import {
  CLUB_EVENT_KIND_LABELS,
  clubEventSignupState,
  formatClubEventCost,
  formatClubEventTime,
  isUuid,
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
import { clubEventFormLink } from "@/lib/event-form-link";
import { VisitorSignup } from "@/components/visitor-signup";
import { SignupButton } from "./signup-button";

export default async function ClubEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { player } = await getViewer();

  // Anyone may read a published or cancelled event. A member reads it through
  // RLS; a signed-out visitor has no grant, so the service role reads it with
  // the same filter written out, and a draft is not found either way.
  const supabase = player ? await createServerSupabaseClient() : null;
  const service = createServiceRoleClient();
  const { data: eventData } = await (supabase ?? service)
    .from("club_events")
    .select(CLUB_EVENT_COLUMNS)
    .eq("id", id)
    .in("status", ["published", "cancelled"])
    .maybeSingle();
  const event = eventData as ClubEventRow | null;
  if (!event) notFound();

  const [
    { count: takenCount },
    { data: takenByRpc, error: takenError },
    { data: mineRow },
    waitlist,
  ] = await Promise.all([
    service
      .from("club_event_signups")
      .select("player_id", { count: "exact", head: true })
      .eq("event_id", id),
    // The places taken as the sign-up RPC counts them: guests too, and not
    // no-shows (00294). Before 00294 the plain count stands.
    service.rpc("club_event_taken" as never, { p_event_id: id } as never),
    supabase && player
      ? supabase
          .from("club_event_signups")
          .select("event_id")
          .eq("event_id", id)
          .eq("player_id", player.id)
          .maybeSingle()
      : { data: null },
    player
      ? readWaitlist(service, id, player.id)
      : { available: false, position: null, waiting: 0 },
  ]);
  const taken =
    takenError || typeof takenByRpc !== "number"
      ? (takenCount ?? 0)
      : (takenByRpc as number);
  const state = clubEventSignupState(
    event,
    new Date(),
    taken,
    mineRow !== null,
  );
  const cost = formatClubEventCost(event.cost_cents);
  // A full event takes a waitlist until it ends, also after it starts: a
  // no-show's place is given at the door. So does one with a freed place that
  // members are already queued for.
  const endsAt = new Date(
    event.ends_at ?? new Date(event.starts_at).getTime() + 6 * 3_600_000,
  ).getTime();
  const canWait =
    waitlist.available &&
    !mineRow &&
    event.capacity !== null &&
    (taken >= event.capacity || waitlist.waiting > 0) &&
    endsAt > Date.now() &&
    (state === "full" || state === "started" || state === "open");

  // The tournament this event runs on (00292), once the exec has activated it:
  // the draw and results live there. Read with the service role, because the
  // link column is not one members are granted. Any error (before 00292): none.
  const formUrl = player ? null : await clubEventFormLink(service, id);
  const { data: linkData } = await service
    .from("club_events")
    .select(
      "tournament_event:tournament_events(tournament_id, tournament:tournaments(status))",
    )
    .eq("id", id)
    .maybeSingle();
  const linkedEvent = (
    linkData as {
      tournament_event: {
        tournament_id: string;
        tournament: { status: string } | null;
      } | null;
    } | null
  )?.tournament_event;
  const drawHref =
    linkedEvent &&
    linkedEvent.tournament &&
    linkedEvent.tournament.status !== "draft"
      ? `/tournaments/${linkedEvent.tournament_id}`
      : null;

  const starts = clubDateParts(event.starts_at);
  const ends = event.ends_at ? clubDateParts(event.ends_at) : null;
  const timeRange = ends
    ? `${starts.time} to ${ends.date === starts.date ? ends.time : `${ends.date}, ${ends.time}`}`
    : starts.time;
  const fill = event.capacity
    ? Math.min(100, Math.round((taken / event.capacity) * 100))
    : 0;
  const left =
    event.capacity === null ? null : Math.max(0, event.capacity - taken);
  const stateTag =
    state === "going"
      ? "tag tag-win"
      : state === "cancelled" || state === "full"
        ? "tag tag-red"
        : "tag";
  const kindLabel =
    CLUB_EVENT_KIND_LABELS[event.kind as ClubEventKind] ?? event.kind;

  return (
    <div>
      <Link
        href="/events"
        className="row press"
        style={{ gap: 8, fontSize: 13, color: "var(--mute)", marginBottom: 18 }}
      >
        <ArrowLeft size={16} />
        All club events
      </Link>

      {event.status === "cancelled" && (
        <div
          className="card-base"
          role="status"
          style={{ marginBottom: 20, borderColor: "var(--red)" }}
        >
          <h3 className="card-title">This event is cancelled</h3>
          {event.cancelled_reason && (
            <p className="card-sub" style={{ margin: 0 }}>
              {event.cancelled_reason}
            </p>
          )}
        </div>
      )}

      <section className="hero-banner" style={{ marginBottom: 20 }}>
        <div style={{ position: "relative", zIndex: 2, minWidth: 0 }}>
          <div
            className="row"
            style={{ gap: 10, flexWrap: "wrap", marginBottom: 12 }}
          >
            <div className="eyebrow" style={{ margin: 0 }}>
              Club event · {kindLabel}
            </div>
            <span className={stateTag}>{SIGNUP_STATE_LABEL[state]}</span>
          </div>
          <h2>{event.title}</h2>
          <div
            className="hero-meta row"
            style={{
              gap: 16,
              flexWrap: "wrap",
              fontSize: 14,
              marginBottom: 24,
            }}
          >
            <span className="row" style={{ gap: 6 }}>
              <CalendarDays size={15} /> {starts.date}, {timeRange}
            </span>
            {event.location && (
              <span className="row" style={{ gap: 6 }}>
                <MapPin size={15} /> {event.location}
              </span>
            )}
          </div>
          {player ? (
            <SignupButton
              eventId={event.id}
              state={state}
              position={waitlist.position}
              canWait={canWait}
              closesAt={
                event.signup_closes_at
                  ? formatClubEventTime(event.signup_closes_at)
                  : null
              }
              opensAt={
                event.signup_opens_at
                  ? formatClubEventTime(event.signup_opens_at)
                  : null
              }
            />
          ) : (
            <VisitorSignup
              formUrl={formUrl}
              open={state === "open" || state === "full"}
            />
          )}
          {drawHref && (
            <Link
              href={drawHref}
              className="btn btn-ghost"
              style={{ marginTop: 12 }}
            >
              See the draw
            </Link>
          )}
        </div>

        <div className="hero-stats">
          <div className="stat">
            <div className="stat-label">{starts.weekday}</div>
            <div className="stat-value">
              {starts.month} {starts.day}
            </div>
            <div className="hero-meta-dim mono" style={{ fontSize: 12 }}>
              {starts.time}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Places</div>
            <div className="stat-value">
              {taken}
              {event.capacity !== null && (
                <span className="hero-meta-dim">/{event.capacity}</span>
              )}
            </div>
            {event.capacity !== null && (
              <>
                <div className="capacity-bar" style={{ marginTop: 6 }}>
                  <div
                    className={`fill${fill >= 100 ? " full" : fill >= 80 ? " warn" : ""}`}
                    style={{ width: `${fill}%` }}
                  />
                </div>
                <div className="hero-meta-dim mono" style={{ fontSize: 12 }}>
                  {left === 0 ? "Full" : `${left} left`}
                </div>
              </>
            )}
          </div>
          <div className="stat">
            <div className="stat-label">Cost</div>
            <div className="stat-value">{cost ?? "Free"}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Type</div>
            <div className="stat-value" style={{ fontSize: 22 }}>
              {kindLabel}
            </div>
          </div>
        </div>
      </section>

      <div className="event-detail-grid">
        <div className="card-base">
          <h3 className="card-title">About this event</h3>
          {event.description ? (
            <p
              style={{
                whiteSpace: "pre-wrap",
                margin: "8px 0 0",
                lineHeight: 1.65,
                color: "var(--ink-2)",
              }}
            >
              {event.description}
            </p>
          ) : (
            <p className="card-sub" style={{ margin: "8px 0 0" }}>
              No details yet.
            </p>
          )}
        </div>
        <div className="card-base">
          <h3 className="card-title">Good to know</h3>
          <ul className="event-facts">
            {event.signup_opens_at && (
              <li>
                <span className="muted">Sign-ups open</span>
                <span>{formatClubEventTime(event.signup_opens_at)}</span>
              </li>
            )}
            <li>
              <span className="muted">Sign-ups close</span>
              <span>
                {event.signup_closes_at
                  ? formatClubEventTime(event.signup_closes_at)
                  : "When it starts"}
              </span>
            </li>
            {event.capacity !== null && (
              <li>
                <span className="muted">When it is full</span>
                <span>
                  Join the waitlist; a freed place is offered in the app
                </span>
              </li>
            )}
            {cost && cost !== "Free" && (
              <li>
                <span className="muted">Fee</span>
                <span>{cost}, kept if you do not show up</span>
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

// The member's own place on the waitlist (00294), read with the service role
// because members have no grant on the table. Any error (before 00294): no
// waitlist, and the page is as it was.
async function readWaitlist(
  service: ReturnType<typeof createServiceRoleClient>,
  eventId: string,
  playerId: string,
): Promise<{ available: boolean; position: number | null; waiting: number }> {
  const { data, error } = await service
    .from("club_event_waitlist" as never)
    .select("id, player_id, joined_at")
    .eq("event_id", eventId)
    .eq("status", "waiting")
    .order("joined_at")
    .order("id");
  if (error) return { available: false, position: null, waiting: 0 };
  const rows = (data ?? []) as { player_id: string }[];
  const index = rows.findIndex((row) => row.player_id === playerId);
  return {
    available: true,
    position: index === -1 ? null : index + 1,
    waiting: rows.length,
  };
}
