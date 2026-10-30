import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CalendarPlus, Clock, MapPin, Wallet } from 'lucide-react';
import {
  CLUB_EVENT_KIND_LABELS,
  clubEventSignupState,
  formatClubEventCost,
  formatClubEventTime,
  isUuid,
  type ClubEventKind,
} from '@badminton/shared';
import { createServerSupabaseClient, createServiceRoleClient, getViewer } from '@/lib/supabase-server';
import {
  CLUB_EVENT_COLUMNS,
  SIGNUP_STATE_LABEL,
  clubDateParts,
  googleCalendarLink,
  type ClubEventRow,
} from '@/lib/club-event-view';
import { clubEventFormLink } from '@/lib/event-form-link';
import { VisitorSignup } from '@/components/visitor-signup';
import { getMembershipPayments } from '@/lib/club-socials';
import { SignupButton, type SignupFee } from './signup-button';

export default async function ClubEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { player } = await getViewer();

  // Anyone may read a published or cancelled event. A member reads it through
  // RLS; a signed-out visitor has no grant, so the service role reads it with
  // the same filter written out, and a draft is not found either way.
  const supabase = player ? await createServerSupabaseClient() : null;
  const service = createServiceRoleClient();
  const { data: eventData } = await (supabase ?? service)
    .from('club_events')
    .select(CLUB_EVENT_COLUMNS)
    .eq('id', id)
    .in('status', ['published', 'cancelled'])
    .maybeSingle();
  const event = eventData as ClubEventRow | null;
  if (!event) notFound();

  const [{ count: takenCount }, { data: takenByRpc, error: takenError }, { data: mineRow }, waitlist] = await Promise.all([
    service.from('club_event_signups').select('player_id', { count: 'exact', head: true }).eq('event_id', id),
    // The places taken as the sign-up RPC counts them: guests too, and not
    // no-shows (00294). Before 00294 the plain count stands.
    service.rpc('club_event_taken' as never, { p_event_id: id } as never),
    supabase && player
      ? supabase.from('club_event_signups').select('event_id').eq('event_id', id).eq('player_id', player.id).maybeSingle()
      : { data: null },
    player ? readWaitlist(service, id, player.id) : { available: false, position: null, waiting: 0 },
  ]);
  const taken = takenError || typeof takenByRpc !== 'number' ? takenCount ?? 0 : (takenByRpc as number);
  const state = clubEventSignupState(event, new Date(), taken, mineRow !== null);
  const cost = formatClubEventCost(event.cost_cents);
  const fee =
    player && cost && (event.cost_cents ?? 0) > 0 && state !== 'going' ? await signupFee(service, id, player, cost) : null;
  // A full event takes a waitlist until it ends, also after it starts: a
  // no-show's place is given at the door. So does one with a freed place that
  // members are already queued for.
  const endsAt = new Date(event.ends_at ?? new Date(event.starts_at).getTime() + 6 * 3_600_000).getTime();
  const canWait =
    waitlist.available &&
    !mineRow &&
    event.capacity !== null &&
    (taken >= event.capacity || waitlist.waiting > 0) &&
    endsAt > Date.now() &&
    (state === 'full' || state === 'started' || state === 'open');

  // The tournament this event runs on (00292), once the exec has activated it:
  // the draw and results live there. Read with the service role, because the
  // link column is not one members are granted. Any error (before 00292): none.
  const formUrl = player ? null : await clubEventFormLink(service, id);
  const { data: linkData } = await service
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

  const starts = clubDateParts(event.starts_at);
  const ends = event.ends_at ? clubDateParts(event.ends_at) : null;
  const timeRange = ends
    ? `${starts.time} to ${ends.date === starts.date ? ends.time : `${ends.date}, ${ends.time}`}`
    : starts.time;
  const fill = event.capacity ? Math.min(100, Math.round((taken / event.capacity) * 100)) : 0;
  const left = event.capacity === null ? null : Math.max(0, event.capacity - taken);
  const stateTag =
    state === 'going' ? 'tag tag-win' : state === 'cancelled' || state === 'full' ? 'tag tag-red' : 'tag';
  const kindLabel = CLUB_EVENT_KIND_LABELS[event.kind as ClubEventKind] ?? event.kind;
  const opensLater = !!event.signup_opens_at && state === 'not_open_yet';

  return (
    <div>
      {event.status === 'cancelled' && (
        <div className="card-base" role="status" style={{ marginBottom: 20, borderColor: 'var(--red)' }}>
          <h3 className="card-title">This event is cancelled</h3>
          {event.cancelled_reason && <p className="card-sub" style={{ margin: 0 }}>{event.cancelled_reason}</p>}
        </div>
      )}

      <header className="ev-hero">
        <div className="ev-hero-watermark" aria-hidden="true">
          {starts.month} {String(starts.day).padStart(2, '0')}
        </div>
        <Link
          href="/events"
          className="row press"
          style={{ gap: 8, fontSize: 13, color: 'var(--mute)', position: 'relative' }}
        >
          <ArrowLeft size={16} />
          All club events
        </Link>
        <div className="ev-hero-body">
          <div className="ev-date">
            <div className="month">{starts.month}</div>
            <div className="day">{starts.day}</div>
            <div className="weekday">{starts.weekday}</div>
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              <span className="ev-label red">Club event · {kindLabel}</span>
              <span className={stateTag}>{SIGNUP_STATE_LABEL[state]}</span>
            </div>
            <h1 className="ev-title">{event.title}</h1>
            <div className="ev-meta">
              <span>
                <Clock size={17} /> {timeRange}
              </span>
              <span>
                <MapPin size={17} /> {event.location ?? 'Place to be announced'}
              </span>
              <span>
                <Wallet size={17} /> {cost ?? 'Free'}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="ev-layout">
        <div style={{ display: 'grid', gap: 20, minWidth: 0 }}>
          <section className="ev-panel">
            <div className="ev-label">About</div>
            <p className="ev-about">{event.description || 'No details yet.'}</p>
          </section>
          <section className="ev-panel">
            <div className="ev-label">Good to know</div>
            <div className="ev-facts">
              <div className="ev-fact">
                <div className="k">{opensLater ? 'Sign-ups open' : 'Sign-ups close'}</div>
                <div className="v">
                  {opensLater
                    ? formatClubEventTime(event.signup_opens_at as string)
                    : event.signup_closes_at
                      ? formatClubEventTime(event.signup_closes_at)
                      : 'When it starts'}
                </div>
              </div>
              <div className="ev-fact">
                <div className="k">When it is full</div>
                <div className="v">{event.capacity === null ? 'No limit on places' : 'Join the waitlist'}</div>
              </div>
              <div className="ev-fact">
                <div className="k">Fee</div>
                <div className="v">{cost ? 'Kept if you do not show' : 'Nothing to pay'}</div>
              </div>
            </div>
          </section>
        </div>

        <aside className="ev-panel ev-spot">
          <section>
            {player ? (
              <SignupButton
                eventId={event.id}
                state={state}
                position={waitlist.position}
                canWait={canWait}
                closesAt={event.signup_closes_at ? formatClubEventTime(event.signup_closes_at) : null}
                opensAt={event.signup_opens_at ? formatClubEventTime(event.signup_opens_at) : null}
                fee={fee}
              />
            ) : (
              <VisitorSignup formUrl={formUrl} open={state === 'open' || state === 'full'} />
            )}
          </section>
          <section>
            <div className="ev-places">
              <span className="ev-label">Places</span>
              <span className="mono" style={{ fontSize: 13 }}>
                <b>{taken}</b>
                {event.capacity !== null && ` / ${event.capacity}`}
              </span>
            </div>
            {event.capacity !== null && (
              <div className="capacity-bar">
                <div
                  className={`fill${fill >= 100 ? ' full' : fill >= 80 ? ' warn' : ''}`}
                  style={{ width: `${fill}%` }}
                />
              </div>
            )}
            <div className="muted" style={{ fontSize: 13 }}>
              {left === null
                ? `${taken} going`
                : left === 0
                  ? 'Full. New sign-ups join the waitlist.'
                  : `${left} ${left === 1 ? 'place' : 'places'} left`}
            </div>
          </section>
          {(drawHref || event.status !== 'cancelled') && (
            <section style={{ display: 'grid', gap: 8 }}>
              {drawHref && (
                <Link href={drawHref} className="btn btn-ghost" style={{ justifyContent: 'center' }}>
                  See the draw
                </Link>
              )}
              {event.status !== 'cancelled' && (
                <a
                  href={googleCalendarLink(event)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="row press"
                  style={{ gap: 8, justifyContent: 'center', fontSize: 14, color: 'var(--ink-2)', minHeight: 40 }}
                >
                  <CalendarPlus size={16} /> Add to Google Calendar
                </a>
              )}
            </section>
          )}
        </aside>
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
    .from('club_event_waitlist' as never)
    .select('id, player_id, joined_at')
    .eq('event_id', eventId)
    .eq('status', 'waiting')
    .order('joined_at')
    .order('id');
  if (error) return { available: false, position: null, waiting: 0 };
  const rows = (data ?? []) as { player_id: string }[];
  const index = rows.findIndex((row) => row.player_id === playerId);
  return { available: true, position: index === -1 ? null : index + 1, waiting: rows.length };
}

/**
 * The fee a member pays to sign up, as club_event_signup_fee charges it: not
 * an exec or fee-exempt, and no fee of theirs for it already paid or holding a
 * receipt (a withdraw keeps one). signUpWithReceipt decides again either way.
 */
async function signupFee(
  service: ReturnType<typeof createServiceRoleClient>,
  eventId: string,
  player: { id: string; is_exec?: boolean | null; fee_exempt?: boolean | null },
  amount: string,
): Promise<SignupFee | null> {
  if (player.is_exec || player.fee_exempt) return null;
  const [{ data }, payments] = await Promise.all([
    service
      .from('club_fees')
      .select('paid_at, fee_submissions!fee_submissions_club_fee_fkey(status)')
      .eq('fee_type', 'event')
      .eq('club_event_id', eventId)
      .eq('player_id', player.id)
      .maybeSingle(),
    getMembershipPayments(),
  ]);
  const existing = data as { paid_at: string | null; fee_submissions: { status: string }[] | null } | null;
  if (existing?.paid_at || (existing?.fee_submissions ?? []).some((s) => s.status === 'submitted' || s.status === 'confirmed')) {
    return null;
  }
  return { amount, etransferEmail: payments.etransferEmail };
}
