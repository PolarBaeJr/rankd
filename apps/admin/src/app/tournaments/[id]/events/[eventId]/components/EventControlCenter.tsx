'use client';

import { useState } from 'react';
import { Badge } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
  summariseRedrawBlockers,
  isPoolToBracket,
  playsRoundRobin,
  endsInKnockout,
  eventHasDraw,
  currentPhase,
} from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentEventStatus,
  TournamentBonusSettings,
  EventWaiverStatus,
  TournamentCourt,
} from '@badminton/shared';
import { Trophy, Users, CheckCircle, BarChart3, Settings, Swords, ListOrdered, Pause, MapPin, Layers } from 'lucide-react';
import type {
  TournamentRow,
  TournamentEventRow,
  TournamentMatchRow,
  ParticipantWithPlayer,
  PairWithPlayers,
  WaitlistEntry,
  CategoryRequest,
} from '@/lib/tournament-types';
import type { SiblingEvent } from '../../../event-format-fields';
import { participantControls, type DrawCapabilities } from '@/lib/participant-controls';
import { hasResultsTab } from '@/lib/event-tabs';
import { EventHeader } from './EventHeader';
import { ParticipantsTab } from './ParticipantsTab';
import { CheckInTab } from './CheckInTab';
import { BracketTab } from './BracketTab';
import { RoundRobinTab } from './RoundRobinTab';
import { StagesTab } from './StagesTab';
import { ResultsTab } from './ResultsTab';
import { LeaderboardTab } from './LeaderboardTab';
import { CourtManagementTab } from './CourtManagementTab';
import { LiveStrip } from './LiveStrip';
import { CategoryRequestsPanel } from './CategoryRequestsPanel';
import { hasCourtsTab } from '@/lib/live-desk';

// 'pool' is a tab of its own rather than a mode of 'bracket' (00107). On a
// pool_to_bracket event BOTH halves exist at once from the moment the knockout
// is drawn, and they are different things to look at: the pool is a table and a
// fixture list, the bracket is a tree. One tab that switched between them would
// hide half the event behind a control, and would have no answer for the exec
// who wants the standings open while entering a quarter-final.
// 'courts' is where an event is RUN rather than recorded — named "Court
// Management" at the owner's request, having shipped as "Desk". Everything else
// here is a view of what has happened; this one carries the facts the console
// never had: which court a match is on, who is standing in front of you, which
// one is next, which one is being played, and — since the owner asked for score
// entry "on this side instead of the main thing" — the result too.
//
// A TAB OF ITS OWN because the bracket card is a single <button>, so the court
// input and the ready pills inside a row would nest interactives.
//
// THE ID IS NOT STORED ANYWHERE. It is `useState` only — no URL, no
// localStorage — so renaming it from 'desk' orphans nothing. Capability strings
// are the opposite (they live in permission_grants and
// permission_baselines.capabilities as data) and none of them was touched.
type TabId = 'participants' | 'checkin' | 'courts' | 'pool' | 'bracket' | 'stages' | 'results' | 'leaderboard';

interface Props {
  tournament: TournamentRow;
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  matches: TournamentMatchRow[];
  // avatar_url feeds the searchable player picker; siblingEvents feeds the
  // pool-seeding picker. Both are pass-through.
  allPlayers: Array<{ id: string; full_name: string; avatar_url?: string | null }>;
  siblingEvents: SiblingEvent[];
  isDoubles: boolean;
  // Resolved from platform_settings on the server — client components cannot
  // read the table, so the Results tab gets it as a prop.
  //
  // `null` when the event is not `completed`, because that is the only status
  // with a Results tab and the page does not spend a round trip on a value
  // nothing can render. Never substituted with a default: the fallback constants
  // exist to keep a FAILED read from reading as "bonuses off", and using them
  // for a read that never happened would make that distinction meaningless.
  bonusSettings: TournamentBonusSettings | null;
  // What the viewer may DO on the participants tab, one flag per server action
  // behind a control. Resolved on the server for the same reason bonusSettings
  // is: a client component cannot ask the permission model anything.
  drawCapabilities: DrawCapabilities;
  // Event-waiver state per player id, resolved on the server because the
  // comparison needs a SHA-256 of the tournament's text and node:crypto cannot
  // run here. `null` means DO NOT SHOW THE COLUMN — either this tournament has
  // no waiver, or this viewer does not hold tournaments.draw.waivers.read. An
  // empty map would read as "nobody has signed", which is a different and much
  // more alarming claim.
  waiverStates: Record<string, EventWaiverStatus> | null;
  // The tournament's courts (00273), null before that migration, and the ids
  // of the courts a live match is on anywhere in the tournament.
  courts: TournamentCourt[] | null;
  busyCourtIds: string[];
  // The members waiting for a place (00278), null before that migration.
  waitlist: WaitlistEntry[] | null;
  // Category changes waiting for approval (00279). Null before that
  // migration, and when the event or the viewer has no use for them.
  categoryRequests: CategoryRequest[] | null;
  /** Entries a Google Form made (00283), by participant or pair id. */
  imported?: Record<string, 'entered' | 'awaiting_partner'> | null;
  // Who is looking, so the panel offers Cancel on their own requests only.
  viewerId: string;
}

export function EventControlCenter({ tournament, event, participants, pairs, matches, allPlayers, siblingEvents, isDoubles, bonusSettings, drawCapabilities, waiverStates, courts, busyCourtIds, waitlist, categoryRequests, imported = null, viewerId }: Props) {
  const status = event.status as TournamentEventStatus;
  const eventType = event.event_type as TournamentEventType;
  const format = event.format;

  // Determine available tabs based on status
  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
    { id: 'participants', label: 'Participants', icon: <Users className="w-4 h-4" /> },
  ];

  if (status !== 'registration') {
    tabs.push({ id: 'checkin', label: 'Check-In', icon: <CheckCircle className="w-4 h-4" /> });
  }

  // WHICH HALVES EXIST. A single-phase event has exactly one of these and it is
  // the one it always had; a pool_to_bracket event grows the second when its
  // knockout is drawn.
  const poolToBracket = isPoolToBracket(format);
  const poolMatches = poolToBracket ? matches.filter((m) => m.phase === 'pool') : matches;
  const bracketMatches = poolToBracket ? matches.filter((m) => m.phase === 'bracket') : matches;
  const hasDraw = eventHasDraw(status);

  // ONLY WHILE THERE IS SOMETHING TO CALL. A completed event has no next match,
  // and a court set on one is history — the tab would be a working list with no
  // work in it. hasCourtsTab is also what shows the live strip, so the strip's
  // button can never point at a tab that is not in this list.
  if (hasCourtsTab(status)) {
    // LONGER LABEL THAN THE REST, and it fits by construction rather than by
    // luck: the tab row is `overflow-x-auto` with `min-w-fit` and every button is
    // `whitespace-nowrap`, so a long label scrolls the row horizontally and can
    // never wrap it. The text is also `hidden sm:inline`, so on a phone this is
    // the icon alone. Measured at 390 / 768 / 1280 against the compiled CSS.
    tabs.push({ id: 'courts', label: 'Court Management', icon: <MapPin className="w-4 h-4" /> });
  }

  // A STAGED EVENT (00272) HAS ONE TAB FOR ALL ITS STAGES, from check-in on,
  // because that is where stage 1 is drawn. playsRoundRobin and endsInKnockout
  // are both false for it here, so the legacy tabs never show.
  const staged = format === 'staged';
  if (staged && status !== 'registration') {
    tabs.push({ id: 'stages', label: 'Stages', icon: <Layers className="w-4 h-4" /> });
  }

  if (hasDraw && playsRoundRobin(format)) {
    tabs.push({
      id: 'pool',
      label: poolToBracket ? 'Round Robin' : 'Round Robin',
      icon: <Swords className="w-4 h-4" />,
    });
  }
  // The knockout tab appears only once there is a knockout. On a
  // pool_to_bracket event that is a real distinction: the pool is drawn and
  // played first, and offering an empty Bracket tab through all of it would
  // invite an exec to go looking for a draw that deliberately does not exist yet.
  if (hasDraw && endsInKnockout(format) && (!poolToBracket || bracketMatches.length > 0)) {
    tabs.push({ id: 'bracket', label: 'Bracket', icon: <Swords className="w-4 h-4" /> });
  }

  // hasResultsTab() rather than a second `status === 'completed'`: the event
  // page decides whether to fetch the bonus settings from the same predicate,
  // and the two must not be able to drift apart. Leaderboard needs nothing from
  // platform_settings, so it keeps its own condition.
  if (hasResultsTab(status)) {
    tabs.push({ id: 'results', label: 'Results', icon: <BarChart3 className="w-4 h-4" /> });
  }

  if (status === 'completed') {
    tabs.push({ id: 'leaderboard', label: 'Leaderboard', icon: <ListOrdered className="w-4 h-4" /> });
  }

  // Default to the most relevant tab
  // The half that is CURRENT, not a fixed tab id — an exec opening a
  // pool_to_bracket event mid-round-robin wants the round robin.
  // Court Management is not the default even while an event is live: an exec
  // opening this page mid-event is as likely to be reading the draw as calling a
  // match, and moving the landing tab under them is a change nobody asked for.
  const defaultTab: TabId = hasResultsTab(status) ? 'results'
    : staged && ['bracket_generated', 'live'].includes(status) ? 'stages'
    : ['pool_generated', 'pool_live'].includes(status) ? 'pool'
    : ['bracket_generated', 'live'].includes(status) ? (endsInKnockout(format) ? 'bracket' : 'pool')
    : status === 'checkin' ? 'checkin'
    : 'participants';

  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);

  // Stats
  const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
  const totalEntries = entries.length;
  const checkedIn = entries.filter((e) => e.status === 'checked_in').length;
  const totalMatches = matches.length;
  const completedMatches = matches.filter((m) =>
    m.status === 'completed' || m.status === 'walkover' || m.is_bye
  ).length;
  // A SECOND, NARROWER COUNT, and the two must not be merged. `completedMatches`
  // above is the PROGRESS figure — how many slots no longer need a court — so it
  // counts byes, which is right for "11/15 matches" and for greying Finalize.
  // `playedMatches` is how many matches somebody actually PLAYED, which is the
  // question the redraw asks: rebuilding the draw deletes every match, and a bye
  // has no score and no Elo to lose. Gating the redraw on the progress figure
  // would grey the button on every draw whose field is not a power of two.
  //
  // COUNTED WITHIN THE CURRENT PHASE (00107). The redraw rebuilds one half, and
  // assertDrawIsRebuildable refuses on that half's results only — so a
  // pool_to_bracket event arriving at its knockout with a fully played pool
  // must NOT show "9 matches have been played, void them first" against a
  // Regenerate button that would not touch any of them. currentPhase is null
  // for the other two formats, where this is the whole event exactly as before.
  const phaseNow = currentPhase(format, status);
  const phaseMatches = phaseNow === 'pool' ? poolMatches : phaseNow === 'bracket' ? bracketMatches : matches;
  // THREE COUNTS, NOT ONE, because "has a result" is not the whole of "a redraw
  // would destroy this". A match that is ON COURT has no result and no Elo, so
  // isPlayedMatch reads it as zero and the button used to stay live while three
  // rallies were in progress. A match whose row still carries an unreversed
  // elo_snapshot holds the only record of what it did to the ladder. Both are
  // separated out rather than folded into `playedMatches` so the greyed reason
  // can name the remedy that actually applies — see summariseRedrawBlockers.
  //
  // The server re-asks all three (delete_phase_matches, 00144) and its answer is
  // the one that decides; these only save the exec a click.
  const redrawBlockers = summariseRedrawBlockers(phaseMatches);
  const playedMatches = redrawBlockers.played;

  // Who may settle or withdraw a waiting category change (00279).
  const categoryControls = participantControls(
    { status, drawLocked: event.draw_locked as boolean, staged },
    drawCapabilities,
  );

  return (
    <div className="space-y-6">
      {/* Event Header */}
      <EventHeader
        tournament={tournament}
        event={event}
        siblingEvents={siblingEvents}
        isDoubles={isDoubles}
        totalEntries={totalEntries}
        checkedIn={checkedIn}
        totalMatches={totalMatches}
        completedMatches={completedMatches}
        playedMatches={playedMatches}
        liveMatches={redrawBlockers.inProgress}
        ratedMatches={redrawBlockers.rated}
        // How many matches the REDRAW would actually replace — the current
        // phase's, not the event's. The confirm dialog names this number, and
        // on a pool_to_bracket event "the 18 matches in the current draw are
        // deleted" would be a false and alarming claim about a knockout of 3.
        phaseMatches={phaseMatches.length}
        // The POOL's own progress, which is what decides whether the knockout
        // can be drawn yet. Equal to the whole event on the other two formats,
        // where nothing reads it.
        poolTotal={poolMatches.length}
        poolDecided={poolMatches.filter((m) => m.status === 'completed' || m.status === 'walkover' || m.is_bye).length}
        drawCapabilities={drawCapabilities}
        // WHETHER THE DRAW THAT EXISTS HAS A BRONZE MATCH, read off the matches
        // themselves. The third-place choice is deliberately not stored on
        // tournament_events — the generated match IS the record — so this is
        // the only truthful source, and it is what the Regenerate confirm
        // pre-ticks its checkbox from. Without it a regenerate would silently
        // drop the playoff (EventHeader's `offerThirdPlace` is false outside
        // `checkin`) or silently add one, which is the same defect from the
        // other side.
        hasThirdPlace={bracketMatches.some((m) => m.is_third_place)}
        stagesDrawn={[...new Set(matches.flatMap((m) => (m.stage != null ? [m.stage] : [])))]}
      />

      {/* Suspension Banner — server actions enforce the actual blocking */}
      {tournament.suspended_at && (
        <div className="rounded-xl border border-[color-mix(in_oklab,var(--color-accent)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent)_5%,transparent)] p-4 flex items-start gap-3" role="status">
          <Pause className="w-4 h-4 text-[var(--color-accent)] mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">This tournament is suspended — actions are paused until it is resumed.</p>
            {tournament.suspension_reason && (
              <p className="text-sm text-[var(--text-muted)] mt-1">{tournament.suspension_reason}</p>
            )}
          </div>
        </div>
      )}

      {/* What is on court and what is next, above whichever tab is open. It
          renders nothing unless the courts tab exists and has work in it. */}
      <LiveStrip
        matches={matches}
        event={event}
        participants={participants}
        pairs={pairs}
        isDoubles={isDoubles}
        canEnterResult={drawCapabilities.enterResult}
        courts={courts}
        busyCourtIds={busyCourtIds}
        onOpenCourts={() => setActiveTab('courts')}
      />

      {categoryRequests && categoryRequests.length > 0 && (
        <CategoryRequestsPanel
          requests={categoryRequests}
          event={event}
          pairs={pairs}
          canDecide={categoryControls.decideCategory}
          canCancel={drawCapabilities.seedSet && status !== 'completed'}
          viewerId={viewerId}
        />
      )}

      {/* Tab Navigation */}
      <div className="overflow-x-auto -mx-1 px-1">
        <div className="flex gap-1 p-1 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)] min-w-fit" role="tablist" aria-label="Event sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-label={tab.label}
              aria-selected={activeTab === tab.id}
              role="tab"
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
                activeTab === tab.id
                  ? 'bg-[var(--color-accent)] text-white shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)]'
              }`}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div role="tabpanel" aria-label={`${activeTab} tab content`}>
        {activeTab === 'participants' && (
          <ParticipantsTab
            event={event}
            participants={participants}
            pairs={pairs}
            allPlayers={allPlayers}
            isDoubles={isDoubles}
            capabilities={drawCapabilities}
            waiverStates={waiverStates}
            waitlist={waitlist}
            categoryRequests={categoryRequests}
            imported={imported}
          />
        )}
        {activeTab === 'checkin' && (
          <CheckInTab
            event={event}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
            waiverStates={waiverStates}
          />
        )}
        {activeTab === 'courts' && (
          <CourtManagementTab
            matches={matches}
            // The shared ScoreEntryDialog resolves the per-round match shape from
            // the event row, so this tab needs it now that it mounts the dialog.
            event={event}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
            // TWO KEYS, TWO SETS OF CONTROLS, on one screen. Running the door is
            // not the same permission as deciding who won.
            canManageCourts={drawCapabilities.manageCourts}
            canEnterResult={drawCapabilities.enterResult}
            courts={courts}
            busyCourtIds={busyCourtIds}
          />
        )}
        {activeTab === 'pool' && (
          <RoundRobinTab
            event={event}
            matches={poolMatches}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
            phase={poolToBracket ? 'pool' : null}
          />
        )}
        {activeTab === 'stages' && (
          <StagesTab
            event={event}
            matches={matches}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
            canGenerate={drawCapabilities.generate}
          />
        )}
        {activeTab === 'bracket' && (
          <BracketTab
            event={event}
            matches={bracketMatches}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
            phase={poolToBracket ? 'bracket' : null}
          />
        )}
        {/* Both conditions say the same thing — the tab only exists at
            `completed` and that is the only status the settings are fetched for
            — but the null check is what makes it true by construction rather
            than by two lists agreeing. */}
        {activeTab === 'results' && bonusSettings && (
          <ResultsTab
            event={event}
            participants={participants}
            pairs={pairs}
            matches={matches}
            isDoubles={isDoubles}
            bonusSettings={bonusSettings}
          />
        )}
        {activeTab === 'leaderboard' && (
          <LeaderboardTab
            event={event}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
          />
        )}
      </div>
    </div>
  );
}
