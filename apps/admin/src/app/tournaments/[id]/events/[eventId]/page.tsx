import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { notFound } from 'next/navigation';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  busyCourtIds,
  isDoublesEvent,
  resolveEventWaiverText,
  eventWaiverStatus,
  applyTournamentBonusOverride,
  type AcceptedEventWaiver,
  type EventWaiverStatus,
} from '@badminton/shared';
// By SUBPATH — node:crypto, server only.
import { eventWaiverHash } from '@badminton/shared/src/utils/event-waiver';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { EventControlCenter } from './components/EventControlCenter';
import { LiveTournament } from '../../../live-tournament';
import { readTournamentBonusSettingsForDisplay } from '@/lib/platform-settings';
import { TOURNAMENT_MATCH_NOTES, fetchPrivateNotes } from '@/lib/private-notes';
import { hasResultsTab } from '@/lib/event-tabs';
import { readLiveCourtUse, readTournamentCourts } from '@/lib/tournament-courts';
import type { DrawCapabilities } from '@/lib/participant-controls';
import type { Capability } from '@/lib/permissions';
import type { ParticipantWithPlayer, PairWithPlayers, PlayerSummary, WaitlistEntry, CategoryRequest } from '@/lib/tournament-types';
import type { SiblingEvent } from '../../event-format-fields';

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: tournamentId, eventId } = await params;

  // WHO IS LOOKING, asked here and not left to middleware. This page opened a
  // service-role client and queried straight away — the same shape the index,
  // /sessions and /fees have all been moved off. Middleware does resolve
  // `tournaments.page` for this path (longest-prefix '/tournaments', see
  // lib/permissions.ts), so this call is not a new door: it is the same door,
  // re-asked where the rows are actually read, because a fetch that runs for
  // the wrong viewer has already put its rows in the RSC payload by the time
  // any JSX decides not to draw them.
  //
  // `tournaments.page` and nothing narrower, deliberately. It is exactly what
  // sectionCapability() already resolves for this route, so the boundary does
  // not move in either direction.
  const viewer = await requireCapability('tournaments.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);

  const supabase = createAdminClient();

  // The tournament and the event first, and together: everything below needs
  // the event's type to know whether to read pairs or participants, and there is
  // nothing useful to render if either is missing.
  const [{ data: tournament }, { data: event }] = await Promise.all([
    supabase.from('tournaments').select('*').eq('id', tournamentId).single(),
    supabase.from('tournament_events').select('*').eq('id', eventId).single(),
  ]);
  if (!tournament) notFound();
  if (!event) notFound();

  const doubles = isDoublesEvent(event.event_type);

  // TWO OF THE SIX READS BELOW BELONG TO A CONTROL RATHER THAN TO THE PAGE, and
  // each is asked for with the capability that control's own server action
  // re-checks. Neither is a level and neither is `tournaments.page` again: the
  // club can hand somebody the results desk without the draw, and this page has
  // to be able to render that person without shipping them the pickers' data.
  //
  // THE ROSTER IS THE ONE THAT MATTERED. `allPlayers` is every non-suspended
  // member of the club — the whole roster, names and avatars — and it exists
  // for exactly one widget: the Add Player / Add Pair picker in ParticipantsTab.
  // It was fetched for everybody the section admitted, so a hand-picked
  // baseline holding `tournaments.page` without the add-writes had the club's
  // membership list delivered in its RSC payload behind a button it was never
  // offered.
  //
  // NOT `players.read`, which is the capability that owns the roster elsewhere:
  // ROLE_DEFAULTS.tournaments does not contain it, so gating on it would blank
  // the picker for the club's VP of Tournaments — the very person this page is
  // for. The right question here is "may this viewer add an entry?", and the
  // answer differs by discipline because the two adds are separate capabilities.
  //
  // BOTH KEYS FOR A DOUBLES EVENT, since 00102. A doubles event now takes solo
  // entrants as well as pairs, and the two adds are separate capabilities:
  // "Add Pair" asks pairs.add.write, "Add without a partner" asks
  // participants.add.write. Asking only the first would leave the picker behind
  // the second empty for anybody holding one and not the other — the dead
  // invitation this gating exists to remove, reintroduced from the other side.
  const canAddSolo = may('tournaments.draw.participants.add.write');
  const canAddEntries = doubles
    ? may('tournaments.draw.pairs.add.write') || canAddSolo
    : canAddSolo;
  // THE SAME QUESTION ASKED FOR EVERY CONTROL ON THE PARTICIPANTS TAB, not just
  // the one whose fetch it gates. The tab decided what to render from
  // `event.status === 'registration'` alone, so Add / Auto-Seed / Clear Seeds
  // were offered to anybody who could open the page and the server action
  // refused on click. Six controls, six capabilities — the ones the actions
  // themselves re-check. See lib/participant-controls.ts for the transcription.
  const drawCapabilities: DrawCapabilities = {
    // `add` is the DISCIPLINE'S add — Add Pair for doubles, Add Player for
    // singles — and stays the single key its own action re-checks. `soloAdd`
    // below is the second, separate one a doubles event now also needs.
    add: doubles ? may('tournaments.draw.pairs.add.write') : canAddSolo,
    remove: doubles
      ? may('tournaments.draw.pairs.remove.write')
      : may('tournaments.draw.participants.remove.write'),
    seedSet: may('tournaments.draw.seed.set.write'),
    seedAuto: may('tournaments.draw.seed.auto.write'),
    seedClear: may('tournaments.draw.seed.clear.write'),
    exit: may('tournaments.draw.exit.write'),
    soloAdd: canAddSolo,
    soloRemove: may('tournaments.draw.participants.remove.write'),
    // Feeds the header's Regenerate draw button rather than the participants
    // tab, and it is the same key both generators already ask for — no new
    // capability, and nothing gated on it that was not gated on it before.
    generate: may('tournaments.draw.generate.write'),
    // Feeds the Court Management tab's court field, ready pills and
    // start/stop. Same key check-in already asks, and the same key every one of
    // those server actions re-checks — see participant-controls.ts for why none
    // of them minted one of its own.
    manageCourts: may('tournaments.draw.checkin.mark.write'),
    // The Court Management tab's Score button. A DIFFERENT KEY from the line
    // above on purpose — see participant-controls.ts. This is the first time any
    // tournaments.results.* capability has reached a component at all; the
    // bracket and round-robin tabs still gate score entry on status alone.
    enterResult: may('tournaments.results.enter.write'),
    // Approving or declining a category change after play (00279). The key
    // correcting a recorded result asks; see participant-controls.ts.
    approveCategory: may('tournaments.results.edit.write'),
  };
  // `siblingEvents` feeds one picker too: the "seed from" list in
  // EventSettingsDialog, which is reached from EventHeader's settings button and
  // whose save calls updateEvent. Same capability that action asks for.
  const canEditEvent = may('tournaments.manage.event.update.write');

  // The remaining five reads do not depend on each other, and were awaited one
  // at a time. On a 100-player event that is five sequential round trips to the
  // Pi before a single byte renders — and this page is re-rendered by EVERY
  // mutation on it, because they all call revalidatePath. Checking in a full
  // field paid for it in one go.
  //
  // siblingEvents: the events this one may be seeded from. Excludes itself —
  // the schema forbids a self-seed outright.
  const [
    { data: siblingEvents },
    { data: pairRows },
    { data: participantRows },
    { data: matches },
    bonusSettings,
    { data: allPlayers },
    { data: waiverAcceptances },
    courts,
    liveCourtUse,
    waitlist,
    categoryRequests,
    importRows,
  ] = await Promise.all([
    canEditEvent
      ? supabase
          .from('tournament_events')
          // group_count so the picker can say "Group Stage (4)" rather than
          // "Round Robin" — the two seed very differently and an exec choosing
          // between two round-robin siblings has to be able to tell them apart.
          .select('id, event_type, format, group_count')
          .eq('tournament_id', tournamentId)
          .neq('id', eventId)
          .order('created_at')
      : Promise.resolve({ data: [] as SiblingEvent[] }),
    // Only the one that matches the discipline is actually queried; the other
    // resolves immediately to an empty result rather than reading a table whose
    // rows this event cannot have.
    doubles
      ? supabase
          .from('tournament_pairs')
          .select('*, player1:players!tournament_pairs_player1_id_fkey(id, full_name, avatar_url, competition_category), player2:players!tournament_pairs_player2_id_fkey(id, full_name, avatar_url, competition_category)')
          .eq('event_id', eventId)
          .order('seed_number', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [] as PairWithPlayers[] }),
    // FETCHED FOR A DOUBLES EVENT TOO, since 00102. This branch used to resolve
    // to an empty array on the grounds that a doubles entrant "has no
    // tournament_participants row at all" — which was true right up until
    // somebody could enter without a partner. Left as it was, the pool would be
    // written by the actions and never once appear on the screen that manages
    // it. Same embed for both, so the pool's Elo column reads the same way the
    // singles list does.
    supabase
      .from('tournament_participants')
      .select('*, player:players!player_id(id, full_name, avatar_url, ratings(singles_elo, doubles_elo, singles_provisional, doubles_provisional, singles_matches_played, doubles_matches_played))')
      .eq('event_id', eventId)
      .order('seed_number', { ascending: true, nullsFirst: false }),
    supabase
      .from('tournament_matches')
      .select('*')
      .eq('event_id', eventId)
      .order('round_number')
      .order('bracket_position'),
    // Placement bonus amounts + master switch. The Results tab projects the
    // bonus column from final_position rather than reading stored history, so it
    // has to use the same numbers (and the same on/off decision) the finaliser
    // would — otherwise the panel says "off" while the table advertises +32.
    //
    // ON NEED, NOT ON CAPABILITY. The Results tab is the only thing that reads
    // this and it exists only at `completed` (EventControlCenter builds its tab
    // list from the status), so for every other event this was a round trip to
    // platform_settings for a value nothing could render. NOT gated on
    // `platform.page` — no exec holds that key, and gating on it would blank the
    // Results tab for every exec in the club.
    //
    // `null` when not fetched, and never a default object — and now `null` on
    // a failed read as well, which is the same answer for the same reason.
    // Handing back the default constants would say "bonuses are on" on the
    // strength of a read that did not happen; the enforcement path refuses
    // outright for that, and a page that only RENDERS the figures has no
    // business taking itself down over it. Absent means absent either way,
    // and the tab it feeds is not rendered.
    //
    // The tournament's own amounts (00275) are laid over the club's here as the
    // finaliser lays them, off the tournament row already read above.
    hasResultsTab(event.status)
      ? readTournamentBonusSettingsForDisplay(supabase).then((s) => s && applyTournamentBonusOverride(
          s,
          (tournament as { placement_bonus_amounts?: unknown }).placement_bonus_amounts,
        ))
      : Promise.resolve(null),
    // Everyone the participant picker may offer (includes admins). Skipped
    // outright, not hidden, for a viewer who cannot add an entry: this is the
    // club roster and it crosses to the browser as a prop on a client
    // component, so trimming the JSX would leave it in the payload regardless.
    canAddEntries
      ? supabase
          .from('players')
          .select('id, full_name, avatar_url')
          .not('status', 'in', '("suspended","pending_approval")')
          .order('full_name')
      : Promise.resolve({ data: [] as PlayerSummary[] }),
    // WHO HAS SIGNED THE EVENT WAIVER — its own capability, its own fetch,
    // skipped outright rather than hidden for a viewer who does not hold it.
    // Same discipline as `allPlayers` above: this crosses to the browser as a
    // prop on a client component, so trimming the JSX would leave it in the
    // payload.
    //
    // A DISPLAY read, not the enforcement one. Check-in reads the same rows for
    // itself, without asking this capability, because gating a refusal on a
    // viewing permission would mean the narrower somebody's access the more the
    // rule relaxes.
    may('tournaments.draw.waivers.read')
      ? supabase
          .from('event_waiver_acceptances')
          .select('player_id, waiver_hash, accepted_at')
          .eq('tournament_id', tournamentId)
      : Promise.resolve({ data: null as AcceptedEventWaiver[] | null }),
    // The tournament's courts and which are in use across ALL its events
    // (00273), for the desk's court picker. Null before 00273 or on a failed
    // read, and the desk falls back to the text box.
    readTournamentCourts(supabase, tournamentId).catch(() => null),
    readLiveCourtUse(supabase, tournamentId).catch(() => null),
    // Who is queueing for a place (00278), first in line first. Null before
    // that migration, which hides the section rather than showing it empty.
    event.external_event === true
      ? Promise.resolve(null)
      : supabase
          .from('tournament_event_waitlist')
          .select('id, player_id, joined_at, player:players!tournament_event_waitlist_player_id_fkey(id, full_name, avatar_url)')
          .eq('event_id', eventId)
          .eq('status', 'waiting')
          .order('joined_at', { ascending: true })
          .order('id', { ascending: true })
          .then(({ data, error }) => {
            if (error) {
              if (['42P01', 'PGRST205'].includes(error.code ?? '')) return null;
              throw new Error(`Could not read the waitlist: ${error.message}`);
            }
            return (data ?? []) as unknown as WaitlistEntry[];
          }),
    // Category changes waiting for approval (00279), oldest first. Only a
    // staged doubles event has them, and only somebody who may ask for one or
    // decide one is shown them. Null before that migration.
    event.format === 'staged' && doubles
      && (drawCapabilities.seedSet || drawCapabilities.approveCategory)
      ? supabase
          .from('tournament_category_requests')
          .select('id, pair_id, from_category, to_category, reason, requested_by, requested_at, requester:players!tournament_category_requests_requested_by_fkey(full_name)')
          .eq('event_id', eventId)
          .eq('status', 'pending')
          .order('requested_at', { ascending: true })
          .then(({ data, error }) => {
            if (error) {
              if (['42P01', 'PGRST205'].includes(error.code ?? '')) return null;
              throw new Error(`Could not read the category change requests: ${error.message}`);
            }
            return (data ?? []) as unknown as CategoryRequest[];
          })
      : Promise.resolve(null),
    // Which entries a Google Form made (00283), for a tag beside them. Ids and
    // a status only, nothing typed into the form. Missing table: no tags.
    supabase
      .from('registration_import_entries')
      .select('participant_id, pair_id, status')
      .eq('tournament_event_id', eventId)
      .in('status', ['entered', 'awaiting_partner'])
      .then(({ data, error }) => {
        if (error) {
          if (['42P01', 'PGRST205'].includes(error.code ?? '')) return [];
          throw new Error(`Could not read the form entries: ${error.message}`);
        }
        return (data ?? []) as { participant_id: string | null; pair_id: string | null; status: 'entered' | 'awaiting_partner' }[];
      }),
  ]);
  const imported: Record<string, 'entered' | 'awaiting_partner'> = {};
  for (const row of importRows) {
    if (row.pair_id) imported[row.pair_id] = row.status;
    if (row.participant_id) imported[row.participant_id] = row.status;
  }
  const busyCourts = courts && liveCourtUse ? [...busyCourtIds(courts, liveCourtUse)] : [];

  const pairs: PairWithPlayers[] = (pairRows ?? []) as PairWithPlayers[];
  const participants: ParticipantWithPlayer[] = (participantRows ?? []) as ParticipantWithPlayer[];

  // The waiver state each row shows, resolved on the server. It has to be:
  // eventWaiverHash uses node:crypto, so a client component could not compute
  // the comparison even if it were handed the text.
  //
  // `null` means "do not show a waiver column at all" and covers two different
  // situations on purpose — this tournament has no waiver, or this viewer may
  // not see who signed. Neither should render an empty column implying nobody
  // has signed.
  const waiverText = resolveEventWaiverText(tournament);
  const waiverStates: Record<string, EventWaiverStatus> | null =
    waiverText && waiverAcceptances
      ? Object.fromEntries(
          // BOTH LISTS FOR A DOUBLES EVENT. A member waiting for a partner is
          // asked for the same signature at the same moment a paired one is —
          // being paired is not when they agreed to anything — so the pool
          // needs its waiver column filled in exactly as the pairs table does.
          (doubles
            ? [...pairs.flatMap((p) => [p.player1_id, p.player2_id]), ...participants.map((p) => p.player_id)]
            : participants.map((p) => p.player_id)
          ).filter((id): id is string => id != null).map((playerId) => [
            playerId,
            eventWaiverStatus(playerId, eventWaiverHash(waiverText), waiverAcceptances),
          ]),
        )
      : null;

  // THE VOID REASONS, RE-ATTACHED TO THE ROWS THAT NO LONGER CARRY THEM.
  //
  // 00118 moved this text off `tournament_matches` — the table is published to
  // Realtime (00113) and carries a plain SELECT grant, so an exec's reason for
  // voiding a match was both queryable by any member and streamed to every
  // subscriber of the live bracket. The restore panel in ScoreEntryDialog still
  // has to quote it back at whoever is restoring the match, so it is read here,
  // with the service-role client, and merged onto the rows the tabs already
  // receive.
  //
  // MERGED RATHER THAN PROP-DRILLED, and that is a deliberate choice over
  // threading a fifth map through EventControlCenter, BracketTab and
  // RoundRobinTab to reach one string in one panel. The field is the one the
  // dialog already reads; what changed is where the server got it.
  //
  // GATED ON THE AUTHOR UNION, which is NARROWER than this page's own
  // `tournaments.page`. Every viewer of this screen used to see every void
  // reason; now only the people who can write one can read one.
  //
  // FALLS BACK TO THE LEGACY COLUMN, which 00118 copies but does not drop, so
  // the panel reads correctly whichever order the migration and this build are
  // deployed in. Drop the fallback with the column.
  //
  // AND NULLED OUTRIGHT FOR EVERYONE ELSE — this is the half that would be easy
  // to miss. `select('*')` above still returns the legacy `notes` column, so
  // without this the text would keep reaching exactly the viewers this change
  // exists to exclude, straight past the capability check.
  const maySeeMatchNotes = TOURNAMENT_MATCH_NOTES.capabilities.some(may);
  const matchNotes = maySeeMatchNotes
    ? await fetchPrivateNotes(supabase, TOURNAMENT_MATCH_NOTES, (matches ?? []).map((m) => m.id as string))
    : new Map<string, string>();
  const matchesWithNotes = (matches ?? []).map((m) => ({
    ...m,
    notes: maySeeMatchNotes ? matchNotes.get(m.id as string) ?? m.notes ?? null : null,
  }));

  return (
    <div className="space-y-6">
      {/* THE CONSOLE SIDE OF THE SAME THING. Two execs running two halves of a
          tournament both have this open, and neither sees the other's work
          without a reload — which is how a draw gets generated against
          occupants that have already changed.

          `draw` is TRUE: this is a console screen that reads
          tournament_matches, and the bracket, results, round-robin and
          standings tabs are all folded out of it.

          MOUNTED HERE, A SIBLING OF EventControlCenter RATHER THAN INSIDE IT.
          The control centre is the screen's only client boundary and would work
          — but several of its tabs render through ResponsiveTable, which draws
          its rows twice (a table and a stack of cards, one CSS-hidden), and a
          subscriber that drifted into one of those would quietly become two
          channels for one screen. A server component renders this leaf once,
          whatever the tabs do. */}
      <LiveTournament
        channel={`admin-tournament-event-${eventId}`}
        tournamentId={tournamentId}
        eventIds={[eventId]}
        draw
      />
      <Link
        href={`/tournaments/${tournamentId}`}
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to {tournament.name}
      </Link>

      <EventControlCenter
        tournament={tournament}
        event={event}
        participants={participants}
        pairs={pairs}
        matches={matchesWithNotes}
        allPlayers={allPlayers ?? []}
        siblingEvents={siblingEvents ?? []}
        isDoubles={doubles}
        bonusSettings={bonusSettings}
        drawCapabilities={drawCapabilities}
        waiverStates={waiverStates}
        courts={courts}
        busyCourtIds={busyCourts}
        waitlist={waitlist}
        categoryRequests={categoryRequests}
        imported={imported}
        viewerId={viewer.id}
      />
    </div>
  );
}
