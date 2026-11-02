import { createServerSupabaseClient, createServiceRoleClient, getViewer } from '@/lib/supabase-server';
import {
  formatDate,
  describeTournamentTimes,
  isDoublesEvent,
  TOURNAMENT_EVENT_TYPE_LABELS,
  eventStatusLabel,
  TOURNAMENT_STATUS_TAG,
  hasTournamentEnded,
  getAccountStanding,
  resolveEventWaiverText,
  TOURNAMENT_EVENT_FORMAT_LABELS,
  membershipUnpaidMessage,
  registrationWindowNotice,
  checkinWindowNotice,
} from '@badminton/shared';
import { loadEntryWindows, windowsFor } from '@/lib/tournament-windows';
import { loadMyEventWaiver } from '@/lib/event-waiver';
import { loadMyMembershipScreen } from '@/lib/membership-screen';
import { getFeatureFlags } from '@/lib/feature-gate';
import { refuseClosedTournament } from '@/lib/tournament-closed';
import { EventWaiverGate } from './EventWaiverGate';
import { StandingNote } from '@/components/standing-notice';
import type { TournamentEventType, TournamentEventStatus } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { Trophy, Users, Zap, ArrowLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { EventRegistrationButton } from './EventRegistrationButton';
import { FeedbackForm } from './feedback-form';
import { LiveTournament } from '../live-tournament';
import { tournamentFormLink } from '@/lib/event-form-link';
import { VisitorSignup } from '@/components/visitor-signup';

/**
 * The teams this member is in, across these events, and WHO WITH.
 *
 * Its own function because the `.or()` is the easy thing to get wrong: a pair
 * names its two members in separate columns, so a filter on one of them misses
 * every entry where the member happens to be player2 — and would show no waiver
 * demand to half the doubles field.
 *
 * The partner's NAME, not just a boolean, since a member can now enter a doubles
 * event on their own and be paired by an exec afterwards. "You are in this
 * event" is not enough to tell somebody who agreed to play with whoever they
 * were given; the one thing they want off this screen is who that turned out to
 * be.
 */
async function loadMyPairs(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  eventIds: string[],
  playerId: string,
): Promise<Record<string, { status: string; partnerName: string | null }>> {
  // The KEY's presence is what says "this member is on a team". The name is
  // display, and it is nullable — the object-or-array embed unwrap below can
  // legitimately come back empty. Deciding "paired" from a non-null name would
  // tell somebody with an unreadable partner that they have no partner, and
  // hand them a Withdraw button the server then refuses.
  if (eventIds.length === 0) return {};
  const { data } = await supabase
    .from('tournament_pairs')
    .select('event_id, status, player1_id, player2_id, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
    .in('event_id', eventIds)
    .or(`player1_id.eq.${playerId},player2_id.eq.${playerId}`);

  const out: Record<string, { status: string; partnerName: string | null }> = {};
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const partnerEmbed = r.player1_id === playerId ? r.player2 : r.player1;
    const one = Array.isArray(partnerEmbed) ? partnerEmbed[0] : partnerEmbed;
    out[r.event_id as string] = {
      status: r.status as string,
      partnerName: (one as { full_name?: string | null } | null)?.full_name ?? null,
    };
  }
  return out;
}

export default async function TournamentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { player: currentPlayer } = await getViewer();
  // A signed-out visitor may read a tournament's overview (not its draws or
  // entries, which are one level down and stay behind sign-in). They have no
  // grant, so they read through the service role; the draft check below is
  // what keeps an unpublished tournament private for both.
  const supabase = currentPlayer ? await createServerSupabaseClient() : createServiceRoleClient();

  const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', id).single();
  // A draft is unpublished. RLS lets a member read it (tournaments_select is
  // USING (TRUE)), so the page is what keeps it private.
  if (!tournament || tournament.status === 'draft') notFound();
  // Its own daily times and venue (00304), shown only when the club set them.
  const tournamentTimes = describeTournamentTimes(tournament.starts_time, tournament.ends_time);

  const { data: events } = await supabase
    .from('tournament_events')
    .select('*, tournament_participants(count), tournament_pairs(count)')
    .eq('tournament_id', id)
    .order('event_type');

  // The registration and check-in windows (00276), on their own read so a
  // database without them shows no window rather than no page.
  const windows = await loadEntryWindows(supabase, {
    eventIds: (events ?? []).map((e) => e.id as string),
    tournamentIds: [id],
  });
  const now = new Date();
  const notices = (eventId: string) => {
    const w = windowsFor(windows, eventId, id);
    return { registration: registrationWindowNotice(w.registration, now), checkin: checkinWindowNotice(w.checkin, now) };
  };

  // `paired` is the discriminator and `partnerName` is only ever display: a
  // pair whose partner name did not resolve is still a pair, and inferring the
  // state from the name would show a paired member "Waiting for a partner".
  const registrationMap: Record<string, { status: string; paired: boolean; partnerName?: string | null }> = {};
  let myPairs: Record<string, { status: string; partnerName: string | null }> = {};
  if (currentPlayer && events) {
    const eventIds = events.map((e) => e.id);
    if (eventIds.length > 0) {
      // BOTH TABLES, always. A member can be an unpaired entrant in one doubles
      // event and half of a team in another at the same tournament.
      const [{ data: regs }, pairs] = await Promise.all([
        supabase
          .from('tournament_participants')
          .select('event_id, status')
          .eq('player_id', currentPlayer.id)
          .in('event_id', eventIds),
        loadMyPairs(supabase, eventIds, currentPlayer.id),
      ]);
      myPairs = pairs;
      for (const r of regs ?? []) {
        registrationMap[r.event_id] = { status: r.status, paired: false };
      }
      // The pair wins where both somehow exist: it is the entry that plays.
      for (const [eventId, pair] of Object.entries(pairs)) {
        registrationMap[eventId] = { status: pair.status, paired: true, partnerName: pair.partnerName };
      }
    }
  }

  // The current player's existing feedback for this tournament, if any.
  let myFeedback: { rating: number | null; comment: string | null } | null = null;
  if (currentPlayer) {
    // Service role, NOT the request-scoped client. 00172 revoked feedback_reports
    // from `authenticated` outright so bug reports stay staff-only, and 00175
    // moved the survey into that same table — so a user-scoped read here comes
    // back as an empty list with NO error, and the form silently forgets what
    // the player already submitted. The row is still scoped to this player by
    // the player_id filter below, so nothing widens.
    const { data: fb } = await createServiceRoleClient()
      // 00175 folded the survey into feedback_reports; `comment` is that table's
      // `body`, aliased here so the form below keeps its own vocabulary.
      .from('feedback_reports')
      .select('rating, comment:body')
      .eq('kind', 'tournament_feedback')
      .eq('tournament_id', id)
      .eq('player_id', currentPlayer.id)
      .maybeSingle();
    myFeedback = (fb as { rating: number | null; comment: string | null } | null) ?? null;
  }

  // ---------------------------------------------------------------------
  // EVENT WAIVER — is this member entered here without having signed?
  // ---------------------------------------------------------------------
  // Only asked of somebody who is actually IN the tournament: the panel is a
  // demand for a signature, and demanding one from a browsing member would be
  // noise. BOTH disciplines are checked, because a doubles entrant has no
  // tournament_participants row at all — they exist only as half of a pair,
  // and pairs are created exclusively by an exec. That is the population this
  // whole feature is about.
  let waiverGate: { text: string; state: 'unsigned' | 'stale' } | null = null;
  if (currentPlayer && resolveEventWaiverText(tournament)) {
    // registrationMap already folds in both tables, so a pair entry is covered.
    const entered = Object.keys(registrationMap).length > 0 || Object.keys(myPairs).length > 0;
    if (entered) {
      // Service role: event_waiver_acceptances' SELECT policy admits a member's
      // own rows, so the user client would work — but loadMyEventWaiver also
      // hashes the text, which has to happen server-side either way.
      const { text, status } = await loadMyEventWaiver(createServiceRoleClient(), id, currentPlayer.id);
      if (text && (status.state === 'unsigned' || status.state === 'stale')) {
        waiverGate = { text, state: status.state };
      }
    }
  }

  // The member's own standing — distinct from tournament.suspended_at, which is
  // the event being paused for everyone.
  const standing = getAccountStanding(currentPlayer);

  // INTERNAL MEANS THIS SEASON'S CLUB FEE IS PAID (00260). Only the refusal
  // paying would fix is surfaced here; a failed read shows nothing and leaves
  // the decision to registerForEvent. Only asked while there is an event this
  // member could still enter, so a past tournament never asks for a fee.
  const couldEnter =
    !!currentPlayer &&
    !tournament.suspended_at &&
    refuseClosedTournament(tournament.status, 'enter this event') === null &&
    (events ?? []).some((e) => e.status === 'registration' && !registrationMap[e.id] && !notices(e.id).registration);
  const [membership, flags] = couldEnter
    ? await Promise.all([loadMyMembershipScreen(supabase, tournament, currentPlayer), getFeatureFlags()])
    : [null, null];
  const formUrl = currentPlayer ? null : await tournamentFormLink(createServiceRoleClient(), id);
  const feeNeeded =
    flags && membership && !membership.screen.ok && membership.screen.reason === 'membership_unpaid'
      ? { receiptPending: membership.receiptPending, payOnline: flags.membership }
      : null;

  return (
    <div data-screen-label="Tournament">
      {/* The event list below prints each event's status and its entry count,
          and both move while a member is looking at them — an exec generating
          a draw, closing check-in or finalising an event, and every other
          member registering.

          `draw` STAYS FALSE. This page never reads tournament_matches; the
          brackets are one level down. Watching matches here would wake the
          overview for every score in every event it is only summarising. */}
      {currentPlayer && (
        <LiveTournament
          channel={`player-tournament-${id}`}
          tournamentId={id}
          eventIds={(events ?? []).map((e) => e.id as string)}
        />
      )}
      <div className="page-header" style={{ marginBottom: 18 }}>
        <Link href="/tournaments" className="row press" style={{ gap: 8, fontSize: 13, color: 'var(--mute)' }}>
          <ArrowLeft size={16} />
          Back to tournaments
        </Link>
      </div>

      <div className="card-base" style={{ marginBottom: 20 }}>
        <div className="card-head" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="page-eyebrow" style={{ marginBottom: 4 }}>
              <span className="bar" /> TOURNAMENT
            </div>
            <h1
              style={{
                fontFamily: 'var(--display)',
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: '-.02em',
                margin: 0,
              }}
            >
              {tournament.name}
            </h1>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', fontSize: 12 }}>
              <span className="mono muted">{formatDate(tournament.start_date)}</span>
              {tournamentTimes && (
                <>
                  <span className="muted">·</span>
                  <span className="mono muted">{tournamentTimes}</span>
                </>
              )}
              {tournament.location && (
                <>
                  <span className="muted">·</span>
                  <span className="muted">{tournament.location}</span>
                </>
              )}
              <span className="muted">·</span>
              <span className="muted" style={{ textTransform: 'capitalize' }}>{tournament.format}</span>
              <span className="muted">·</span>
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className={TOURNAMENT_STATUS_TAG[tournament.status as string] ?? 'tag'}>
              {(tournament.status as string)?.toUpperCase()}
            </span>
            {tournament.suspended_at && <span className="tag tag-red">SUSPENDED</span>}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="tag tag-gold row" style={{ gap: 4 }}>
            <Zap size={10} /> {tournament.event_multiplier}× MULTIPLIER
          </span>
        </div>
      </div>

      {tournament.suspended_at && (
        <div className="card-base" style={{ marginBottom: 20 }} role="status">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <h3 className="card-title">Tournament suspended</h3>
            <span className="tag tag-red">PAUSED</span>
          </div>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Registration and check-in are paused
            {tournament.suspension_reason ? `: ${tournament.suspension_reason}` : ' until further notice.'}
          </p>
        </div>
      )}

      {feeNeeded && (
        <div className="card-base" style={{ marginBottom: 20 }} role="status">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <h3 className="card-title">Club fee needed</h3>
            {feeNeeded.receiptPending && <span className="tag">RECEIPT UNDER REVIEW</span>}
          </div>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {membershipUnpaidMessage(tournament.allowed_memberships, feeNeeded.payOnline)}
            {feeNeeded.receiptPending && ' Your receipt is waiting for an exec to confirm it.'}
          </p>
          {feeNeeded.payOnline && (
            <Link href="/membership" className="row press" style={{ gap: 6, fontSize: 13, marginTop: 10 }}>
              Go to Membership
              <ChevronRight size={14} />
            </Link>
          )}
        </div>
      )}

      {!currentPlayer && (
        <div className="card-base" style={{ marginBottom: 20 }}>
          <VisitorSignup
            formUrl={formUrl}
            open={!tournament.suspended_at && (events ?? []).some((e) => e.status === 'registration')}
          />
        </div>
      )}

      {/* Above the event list, so it is the first thing between the member and
          the buttons they are about to be refused at. */}
      {waiverGate && (
        <EventWaiverGate tournamentId={id} text={waiverGate.text} state={waiverGate.state} />
      )}

      <div className="card-head" style={{ marginBottom: 14 }}>
        <div>
          <h3 className="card-title">Events</h3>
          {/* The draw, the entries and the results all stay readable; only the
              Register/Check in/Withdraw buttons are withheld. */}
          <StandingNote standing={standing} activity="Entries and check-in" style={{ marginTop: 6 }} />
        </div>
        {events && events.length > 0 && <span className="tag">{events.length}</span>}
      </div>

      {(!events || events.length === 0) ? (
        <div className="card-base">
          <div className="empty">
            <Trophy size={40} className="text-[var(--mute)]" style={{ display: 'block', margin: '0 auto 12px' }} />
            No events have been created yet.
          </div>
        </div>
      ) : (
        <div className="grid grid-2">
          {events.map((event) => {
            const eventType = event.event_type as TournamentEventType;
            const eventStatus = event.status as TournamentEventStatus;
            const doubles = isDoublesEvent(eventType);
            const participantCount = doubles
              ? (event.tournament_pairs as unknown as { count: number }[])?.[0]?.count ?? 0
              : (event.tournament_participants as unknown as { count: number }[])?.[0]?.count ?? 0;
            const myReg = registrationMap[event.id] ?? null;
            const windowNotices = notices(event.id);

            return (
              <div
                key={event.id}
                style={{
                  padding: 18,
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-lg)',
                  background: 'var(--surface)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                }}
              >
                <Link href={`/tournaments/${id}/events/${event.id}`} className="press" style={{ textDecoration: 'none' }}>
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: 'var(--display)',
                          fontSize: 18,
                          fontWeight: 600,
                          letterSpacing: '-.01em',
                        }}
                      >
                        {TOURNAMENT_EVENT_TYPE_LABELS[eventType]}
                      </div>
                      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <span className={TOURNAMENT_STATUS_TAG[eventStatus] ?? 'tag'}>
                          {eventStatusLabel(event.format as string, eventStatus).toUpperCase()}
                        </span>
                        <span className="tag">
                          {(TOURNAMENT_EVENT_FORMAT_LABELS[event.format as keyof typeof TOURNAMENT_EVENT_FORMAT_LABELS]
                            ?? (event.format as string)).toUpperCase()}
                        </span>
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-[var(--mute)]" />
                  </div>
                </Link>

                <div className="row" style={{ gap: 10, justifyContent: 'space-between' }}>
                  <div className="row" style={{ gap: 6, fontSize: 12 }}>
                    <Users size={12} className="text-[var(--mute)]" />
                    <span className="mono muted">
                      {participantCount} {doubles ? 'pair' : 'player'}{participantCount !== 1 ? 's' : ''}
                      {event.max_participants ? ` / ${event.max_participants}` : ''}
                    </span>
                  </div>
                  {/* An external event (00269) is entered by the organisers. */}
                  {event.external_event ? (
                    <span className="mono muted" style={{ fontSize: 12 }}>External</span>
                  ) : !currentPlayer ? null : (
                  <EventRegistrationButton
                    eventId={event.id}
                    eventStatus={eventStatus}
                    registration={myReg}
                    isDoubles={doubles}
                    suspended={!!tournament.suspended_at}
                    eventWaiverText={tournament.waiver_text}
                    membershipBlocked={feeNeeded ? 'Club fee needed' : null}
                    registrationNotice={windowNotices.registration}
                    checkinNotice={windowNotices.checkin}
                  />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Only once the event is over. Rating a tournament that has not happened
          yet is not feedback, and it is the exec team's only read on how an
          event actually went. The server action enforces the same rule. */}
      {currentPlayer && hasTournamentEnded(tournament) && (
        <div style={{ marginTop: 24 }}>
          {/* submitEventFeedback also starts with requirePlayer(), so a form
              that could only ever fail on submit is replaced by the reason. */}
          {standing.ok ? (
            <FeedbackForm
              tournamentId={id}
              initialRating={myFeedback?.rating ?? null}
              initialComment={myFeedback?.comment ?? null}
            />
          ) : (
            <div className="card-base" style={{ padding: 20 }}>
              <div className="card-title">Feedback paused</div>
              <p className="card-sub" style={{ marginTop: 6 }}>{standing.detail}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
