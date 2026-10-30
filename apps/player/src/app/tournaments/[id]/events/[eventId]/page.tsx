import * as Sentry from '@sentry/nextjs';
import { createServerSupabaseClient, createServiceRoleClient, getViewer } from '@/lib/supabase-server';
import {
  formatDate,
  isDoublesEvent,
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
  eventStatusLabel,
  formatResultsFrom,
  parseFormatConfig,
  describeStagedFormat,
  stagedMatchHeading,
  stagesView,
  describeMatchShape,
  isOutOfEvent,
  unwrap,
  unwrapMaybe,
  TOURNAMENT_EVENT_FORMAT_LABELS,
  isPoolToBracket,
  endsInKnockout,
  courtLabel,
  courtLabelOrTbc,
  SKIP_SLOT_LABEL,
  membershipUnpaidMessage,
  eventRecordFor,
  eventRatingLine,
  registrationWindowNotice,
  checkinWindowNotice,
} from '@badminton/shared';
import { loadEntryWindows, windowsFor } from '@/lib/tournament-windows';
import { getMyWaitlistState, type MyWaitlistState } from '@/lib/event-waitlist';
import type {
  TournamentEventType,
  TournamentEventStatus,
  TournamentMatchStatus,
} from '@badminton/shared';
import { notFound } from 'next/navigation';
import { Trophy, ArrowLeft, Crown, Swords, Medal, Star } from 'lucide-react';
import Link from 'next/link';
import { FadeIn } from '@/components/motion-wrapper';
import { EventActions } from './EventActions';
import { ParticipantsList, type ParticipantEntry } from './ParticipantsList';
import { LiveTournament } from '../../../live-tournament';
import { Draw, type DrawMatch } from './Draw';
import { Stages, type StagedPlayerMatch } from './Stages';
import { MatchReady } from './MatchReady';
import { loadMyMembershipScreen } from '@/lib/membership-screen';
import { getFeatureFlags } from '@/lib/feature-gate';
import { refuseClosedTournament } from '@/lib/tournament-closed';
import { YourEventSoFar } from './YourEventSoFar';

/**
 * The match's own state, said to a member rather than to a database.
 *
 * `{matchStatus}` under `capitalize` printed the raw enum, which is how a member
 * came to be looking at the word "Ready" in a bordered uppercase chip and
 * pressing it. The words matter as much as the styling did: "Ready" describes
 * the DRAW (both sides are known) and a member reads it as describing
 * THEMSELVES. "Waiting to be called" cannot be misread that way, and cannot be
 * mistaken for something to press.
 *
 * All seven values of tournament_matches' CHECK are here, not the three that
 * were obviously wrong: 'walkover', 'disputed' and 'voided' were painting the
 * same button-shaped chip and are just rarer.
 */
const MATCH_STATE_LABELS: Record<string, string> = {
  pending:   'Not scheduled yet',
  ready:     'Waiting to be called',
  live:      'On court now',
  completed: 'Played',
  walkover:  'Walkover',
  disputed:  'Result disputed',
  voided:    'Voided',
};

// The bracket's geometry used to be five constants here and five more in the
// console, drifting apart card height by card height. It is now one shared
// layout engine (@badminton/shared/utils/bracket-layout) with each app owning
// only the sizes it draws at — see ./Draw.

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id: tournamentId, eventId } = await params;
  const supabase = await createServerSupabaseClient();

  const tournamentRes = await supabase
    .from('tournaments')
    .select('*')
    .eq('id', tournamentId)
    .maybeSingle();
  const tournament = unwrapMaybe(tournamentRes, 'TRN-101');
  // Never a draft's events: see the same guard on /tournaments/[id].
  if (!tournament || tournament.status === 'draft') notFound();

  const eventRes = await supabase
    .from('tournament_events')
    .select('*')
    .eq('id', eventId)
    .maybeSingle();
  const event = unwrapMaybe(eventRes, 'TRN-101');
  if (!event) notFound();

  const eventType   = event.event_type as TournamentEventType;
  const eventStatus = event.status as TournamentEventStatus;
  // Reads the typed shape when the event has one, so a player sees the format
  // they will actually play rather than the enum it fell back from.
  const matchShape = describeMatchShape(event);
  const doubles     = isDoublesEvent(eventType);
  const statusColor = TOURNAMENT_EVENT_STATUS_COLORS[eventStatus];

  let participants: Array<Record<string, unknown>> = [];
  let pairs: Array<Record<string, unknown>> = [];

  // NAMED COLUMNS, NOT `*`, ON ALL THREE READS BELOW — and the reason is
  // 00117/00118 rather than payload size.
  //
  // Those two migrations moved the exec's own free text out of these tables and
  // into private ones, but deliberately did NOT drop the old columns: the owner
  // applies migrations by hand and deploys code separately, so a running build
  // may still be selecting them. `tournament_participants.notes` and
  // `tournament_pairs.notes` are the reason an entry was withdrawn or
  // disqualified; `tournament_matches.notes` is the reason a match was voided,
  // recorded as a double no-show, or restored. Every one of them still holds its
  // history, and this page — the one player screen that reads all three tables —
  // was shipping the lot to every member inside the RSC payload. Narrowing the
  // select is what actually stops that before the DROP COLUMN follow-up runs.
  //
  // The columns are enumerated from what the JSX below actually reads, not from
  // what looks plausible, because a column list is all-or-nothing: PostgREST
  // fails the WHOLE request on an unknown or ungranted column, and 00115 is the
  // write-up of that emptying five player screens. Here it would THROW rather
  // than blank — `unwrap` raises on `res.error` — but a loud wrong answer is
  // still a wrong answer. Note that the `as Array<Record<string, unknown>>`
  // casts erase the select-derived row type, so type-check cannot check this
  // list for you; it was checked by reading every access off these rows,
  // including the bracket-notation ones in getEntryName/isWinner/toDrawMatch
  // and the `(e: any)` ones in Final Standings.
  //
  // ONE STRING LITERAL EACH, never a concatenation: supabase-js parses the
  // select string as a literal type, and `'a, b' + 'c'` widens to `string`.
  if (doubles) {
    const data = unwrap(
      await supabase
        .from('tournament_pairs')
        // pair_name and points are read by Final Standings; final_position both
        // filters and sorts it. player1_id/player2_id are NOT here — the only
        // code that compares them is the "who is my partner" lookup below, which
        // has always had its own narrow select.
        .select('id, seed_number, status, final_position, points, pair_name, external1_name, external2_name, player1:players!tournament_pairs_player1_id_fkey(full_name, avatar_url), player2:players!tournament_pairs_player2_id_fkey(full_name, avatar_url)')
        .eq('event_id', eventId)
        .order('seed_number'),
      'TRN-101',
    );
    pairs = data as Array<Record<string, unknown>>;
  } else {
    const data = unwrap(
      await supabase
        .from('tournament_participants')
        // elo_change is the singles-only rating delta in Final Standings; it has
        // no counterpart on the pairs read above because that block is behind
        // `!doubles`. `players!player_id` is a foreign-key hint naming the
        // relationship, not a selected column, so player_id itself stays out.
        .select('id, seed_number, status, final_position, points, elo_change, player:players!player_id(full_name, avatar_url)')
        .eq('event_id', eventId)
        .order('seed_number'),
      'TRN-101',
    );
    participants = data as Array<Record<string, unknown>>;
  }

  // A STAGED EVENT (00272) also needs each match's stage, pool, group, slot,
  // label, number and head starts. Asked for only on a staged event, and with
  // the old list as the fallback, because PostgREST fails the whole request on
  // a column the database has not got (42703 / PGRST204), and 00272 is applied
  // by hand: a build ahead of the migration must still render every other event.
  const staged = event.format === 'staged';
  const stagedRes = staged
    ? await supabase
      .from('tournament_matches')
      .select('id, round_number, bracket_position, round_name, court, status, scores, is_bye, is_third_place, phase, participant_a_id, participant_b_id, pair_a_id, pair_b_id, winner_participant_id, winner_pair_id, ready_player_ids, stage, pool_number, group_number, slot, match_label, match_number, handicap_a, handicap_b')
      .eq('event_id', eventId)
      .order('round_number')
      .order('bracket_position')
    : null;
  const stagedColumnsMissing = stagedRes?.error != null
    && (stagedRes.error.code === '42703' || stagedRes.error.code === 'PGRST204');
  const matches = stagedRes && !stagedColumnsMissing ? unwrap(stagedRes, 'TRN-101') : unwrap(
    await supabase
      .from('tournament_matches')
      // bracket_position is the second .order() key rather than something the
      // JSX reads. PostgREST would sort on it whether or not it is selected;
      // it is named so the ordering and the projection cannot drift apart.
      //
      // What is deliberately gone, beyond `notes`: elo_snapshot (the rating
      // engine's working, a Json blob), walkover_reason / walkover_winner,
      // result_entered_by, the loser_* and *_to_* advancement wiring, and the
      // per-match format overrides — none of which this page draws.
      //
      // `ready_player_ids` (00135) is the newest name on this list and the one
      // that makes the migration ORDER-SENSITIVE in a way `court` never was:
      // PostgREST fails the whole request on an unknown column and `unwrap`
      // raises on res.error, so a build naming it against a database without it
      // 500s this page rather than degrading. 00135 says the same thing at the
      // top of the file — apply it before deploying, and applying it early is
      // harmless.
      .select('id, round_number, bracket_position, round_name, court, status, scores, is_bye, is_third_place, phase, participant_a_id, participant_b_id, pair_a_id, pair_b_id, winner_participant_id, winner_pair_id, ready_player_ids')
      .eq('event_id', eventId)
      .order('round_number')
      .order('bracket_position'),
    'TRN-101',
  );

  const allMatches = matches as Array<Record<string, unknown>>;

  const { player: currentPlayer } = await getViewer();
  // `paired` is the discriminator; `partnerName` is display only and may be
  // null even for a real pair, so nothing branches on it.
  let playerRegistration: { status: string; paired: boolean; partnerName?: string | null } | null = null;
  /**
   * THE ID THE MATCH ROWS ACTUALLY NAME — a tournament_participants id in a
   * singles event, a tournament_pairs id in a doubles one.
   *
   * This used to be `playerParticipantId`, set only inside a `!doubles` branch,
   * while "Your Matches" below both GATED on it and compared it against
   * `m.pair_a_id`/`m.pair_b_id` when `doubles`. A participant id is never a pair
   * id, so the gate was false for every doubles entrant and the block has never
   * rendered on a doubles event at all — nobody in a doubles draw has ever seen
   * their own next match on this page. It is fixed here rather than left,
   * because the court and the ready control both live in that block and doubles
   * is the case they were asked for ("both halves of a pair matter").
   */
  let playerEntryId: string | null = null;
  /** The viewer's own side of a doubles pair, for "your partner isn't here yet". */
  let playerPartnerId: string | null = null;

  // READ FOR DOUBLES TOO, since 00102. This was `!doubles` on the grounds that a
  // doubles entrant had no participant row — true until a member could enter
  // without a partner. Left as it was, somebody who self-entered would come back
  // to a page still offering them Register, and the second press would fail
  // "Already registered".
  if (currentPlayer) {
    const regRes = await supabase
      .from('tournament_participants')
      .select('id, status')
      .eq('event_id', eventId)
      .eq('player_id', currentPlayer.id)
      .maybeSingle();
    const reg = unwrapMaybe(regRes, 'TRN-101');
    if (reg) {
      playerRegistration = { status: reg.status, paired: false };
      // Singles only, and now for a reason that is stated rather than assumed: a
      // doubles match names a PAIR id in participant_a_id's place, so this id
      // would match nothing there. The doubles half is picked up below.
      if (!doubles) playerEntryId = reg.id;
    }

    // And the other way to be in a doubles event: on a formed team. The partner's
    // NAME, because a member who agreed to play with whoever they were given
    // wants exactly one thing off this page — who that turned out to be.
    if (doubles) {
      const pairRes = await supabase
        .from('tournament_pairs')
        // `id` is what the match rows name for a doubles event — see
        // playerEntryId above for the bug its absence caused. Safe to add: this
        // one query deliberately bypasses `unwrap` and fails soft, so a column
        // the database has not got yet costs the partner's name and nothing
        // else. (It has got `id`.)
        .select('id, status, player1_id, player2_id, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)')
        .eq('event_id', eventId)
        .or(`player1_id.eq.${currentPlayer.id},player2_id.eq.${currentPlayer.id}`)
        .limit(1);
      const mine = (pairRes.data ?? [])[0] as Record<string, unknown> | undefined;
      if (mine) {
        const partnerEmbed = mine.player1_id === currentPlayer.id ? mine.player2 : mine.player1;
        const one = Array.isArray(partnerEmbed) ? partnerEmbed[0] : partnerEmbed;
        playerRegistration = {
          status: mine.status as string,
          paired: true,
          partnerName: (one as { full_name?: string | null } | null)?.full_name ?? null,
        };
        playerEntryId = mine.id as string;
        playerPartnerId = (mine.player1_id === currentPlayer.id ? mine.player2_id : mine.player1_id) as string;
      }
    }
  }

  const playerOutOfEvent = isOutOfEvent(playerRegistration?.status);

  // The registration and check-in windows (00276), on their own read so a
  // database without them shows no window rather than no page.
  const entryWindows = windowsFor(
    await loadEntryWindows(supabase, { eventIds: [eventId], tournamentIds: [tournamentId] }),
    eventId,
    tournamentId,
  );
  const windowNow = new Date();
  const registrationNotice = registrationWindowNotice(entryWindows.registration, windowNow);
  const checkinNotice = checkinWindowNotice(entryWindows.checkin, windowNow);

  // A tournament run for a club event fills from the club event's list (00292),
  // and enter_tournament_event refuses a member's own entry (00307), so the
  // way in is a link there. A failed read shows the usual controls, which the
  // refusal then explains.
  let clubEvent: { href: string; title: string } | null = null;
  if (!playerRegistration) {
    const { data: linkedClubEvent } = await createServiceRoleClient()
      .from('club_events')
      .select('id, title')
      .eq('tournament_event_id' as never, eventId as never)
      .maybeSingle();
    const linked = linkedClubEvent as { id: string; title: string } | null;
    if (linked) clubEvent = { href: `/events/${linked.id}`, title: linked.title };
  }

  // The club-fee refusal registerForEvent would make (00260), said before the
  // click. Only asked of somebody not already in the event, and a failed read
  // says nothing: see lib/membership-screen.
  let membershipBlocked: { message: string; receiptPending: boolean; payHref: string | null } | null = null;
  if (
    currentPlayer && !playerRegistration && eventStatus === 'registration' && !registrationNotice &&
    !tournament.suspended_at && refuseClosedTournament(tournament.status, 'enter this event') === null
  ) {
    const [membership, flags] = await Promise.all([
      loadMyMembershipScreen(supabase, tournament, currentPlayer),
      getFeatureFlags(),
    ]);
    if (membership && !membership.screen.ok && membership.screen.reason === 'membership_unpaid') {
      membershipBlocked = {
        message: membershipUnpaidMessage(tournament.allowed_memberships, flags.membership),
        receiptPending: membership.receiptPending,
        payHref: flags.membership ? '/membership' : null,
      };
    }
  }

  // The waitlist (00278), on its own service-role read: the table has no
  // member-facing grant, and a database without 00278 shows no waitlist. A
  // failed read costs the waitlist controls, never the page.
  let waitlist: MyWaitlistState | null = null;
  if (currentPlayer && !playerRegistration && event.external_event !== true) {
    try {
      waitlist = await getMyWaitlistState(createServiceRoleClient(), eventId, currentPlayer.id, {
        max: (event.max_participants as number | null) ?? null,
        doubles,
      });
    } catch (err) {
      Sentry.captureException(err);
    }
  }

  const participantNameMap: Record<string, string> = {};
  const participantSeedMap: Record<string, number | null> = {};

  if (doubles) {
    for (const p of pairs) {
      const p1 = p.player1 as Record<string, unknown> | null;
      const p2 = p.player2 as Record<string, unknown> | null;
      // An external team (00269) has no player embeds; its names are on the row,
      // and pair_name is its team name when the desk gave one.
      const teamNamed = p.external1_name != null && p.pair_name !== `${p.external1_name} / ${p.external2_name}`;
      const name = teamNamed
        ? (p.pair_name as string)
        : [p1?.full_name ?? p.external1_name, p2?.full_name ?? p.external2_name].filter(Boolean).join(' & ');
      participantNameMap[p.id as string] = name || (p.pair_name as string | null) || 'Unknown Pair';
      participantSeedMap[p.id as string] = p.seed_number as number | null;
    }
  } else {
    for (const p of participants) {
      const player = p.player as Record<string, unknown> | null;
      participantNameMap[p.id as string] = (player?.full_name as string) || 'Unknown';
      participantSeedMap[p.id as string] = p.seed_number as number | null;
    }
  }

  // The participants card filters by name in the browser, so it is a client
  // component: flatten singles and pairs into one shape here rather than
  // shipping raw rows and branching again on the client.
  const participantEntries: ParticipantEntry[] = doubles
    ? pairs.map((p) => {
        const p1 = p.player1 as Record<string, unknown> | null;
        const p2 = p.player2 as Record<string, unknown> | null;
        return {
          id:            p.id as string,
          name:          participantNameMap[p.id as string] ?? 'Unknown Pair',
          seed:          p.seed_number as number | null,
          status:        p.status as string,
          finalPosition: p.final_position as number | null,
          avatars: [
            { name: (p1?.full_name as string) || (p.external1_name as string | null) || '', url: (p1?.avatar_url as string | null) ?? null },
            { name: (p2?.full_name as string) || (p.external2_name as string | null) || '', url: (p2?.avatar_url as string | null) ?? null },
          ],
        };
      })
    : participants.map((p) => {
        const player = p.player as Record<string, unknown> | null;
        return {
          id:            p.id as string,
          name:          participantNameMap[p.id as string] ?? 'Unknown',
          seed:          p.seed_number as number | null,
          status:        p.status as string,
          finalPosition: p.final_position as number | null,
          avatars: [
            { name: (player?.full_name as string) || '', url: (player?.avatar_url as string | null) ?? null },
          ],
        };
      });

  // The third-place playoff shares round_number with the final so the two are
  // scheduled together (00080), and it has to come OUT of the tree before the
  // layout is built. Left in, it is a round of two feeding a round of one —
  // the exact shape of "these two matches feed that one" — so the layout engine
  // would draw the semi-finals' elbows from a false premise and the playoff
  // would read as a second final. It is passed separately and placed in the
  // clear space under the final instead.
  //
  // "Your Matches" further down deliberately still reads it off allMatches: a
  // player who is in it wants to see it, and it identifies itself there by
  // round_name ("3rd Place Playoff") with nothing implied about the draw.
  const thirdPlaceMatch = allMatches.find((m) => m.is_third_place) ?? null;
  // TWO HALVES ON A pool_to_bracket EVENT (00107). The knockout diagram is
  // built from the bracket phase and the results list from the pool phase, so
  // both are shown and neither is fed the other's matches — a bracket drawn
  // over the pool's fixtures would be a tree of round-robin games.
  //
  // On the other two formats every match carries phase NULL, so `poolMatches`
  // is the whole list for a round robin and `bracketMatches` is the whole list
  // for a knockout, exactly as before.
  const poolToBracket = isPoolToBracket(event.format as string);
  const poolMatches = poolToBracket
    ? allMatches.filter((m) => m.phase === 'pool')
    : allMatches;
  const knockoutMatches = poolToBracket
    ? allMatches.filter((m) => m.phase === 'bracket')
    : allMatches;
  const bracketMatches = knockoutMatches.filter((m) => !m.is_third_place);

  // The pool half's own rounds, listed separately so a pool_to_bracket event
  // shows its round robin as a results list under the bracket.
  const poolRoundsMap = new Map<number, Array<Record<string, unknown>>>();
  for (const m of poolMatches) {
    const rn = m.round_number as number;
    if (!poolRoundsMap.has(rn)) poolRoundsMap.set(rn, []);
    poolRoundsMap.get(rn)!.push(m);
  }
  const sortedPoolRounds = Array.from(poolRoundsMap.entries()).sort(([a], [b]) => a - b);

  function getEntryName(match: Record<string, unknown>, side: 'a' | 'b'): string {
    const key = doubles
      ? side === 'a' ? 'pair_a_id' : 'pair_b_id'
      : side === 'a' ? 'participant_a_id' : 'participant_b_id';
    const pid = match[key] as string | null;
    // A skip match has one real entry and one empty slot — label only the empty
    // side, otherwise both names read as the placeholder.
    if (!pid) return match.is_bye ? SKIP_SLOT_LABEL : 'TBD';
    return participantNameMap[pid] || 'TBD';
  }

  // NO BYE GUARD HERE, unlike Draw's own isWinner. This one only ever sees pool
  // and non-bracket rows: every bracket match is handed to <Draw />, and the
  // generator only ever creates a skip inside a bracket. A defensive guard here
  // would be a guard against a case the data cannot produce.
  function isWinner(match: Record<string, unknown>, side: 'a' | 'b'): boolean {
    const key      = doubles ? (side === 'a' ? 'pair_a_id' : 'pair_b_id') : (side === 'a' ? 'participant_a_id' : 'participant_b_id');
    const winnerKey= doubles ? 'winner_pair_id' : 'winner_participant_id';
    const pid      = match[key] as string | null;
    const winnerId = match[winnerKey] as string | null;
    return !!pid && !!winnerId && pid === winnerId;
  }

  function formatScores(scores: Array<{ a: number; b: number }> | null): string {
    if (!scores || scores.length === 0) return '';
    return scores.map((s) => `${s.a}–${s.b}`).join(', ');
  }

  // endsInKnockout, not `=== 'single_elimination'`: a pool_to_bracket event has
  // a bracket too, and it is the half that decides the event. A staged event is
  // drawn stage by stage below instead, so neither legacy card shows for it.
  const isSingleElim = !staged && endsInKnockout(event.format as string, event.format_config);
  const stagedCfg = staged ? parseFormatConfig(event.format_config) : null;

  // The draw, flattened to entry ids ONCE. Everything below the flattening is
  // the same code for singles and for doubles — the `doubles` branch is spent
  // here rather than three times inside a renderer, which is what the four
  // near-identical key lookups above used to be.
  const toDrawMatch = (m: Record<string, unknown>): DrawMatch => ({
    id:               m.id as string,
    round_number:     m.round_number as number,
    bracket_position: (m.bracket_position as number) ?? 0,
    round_name:       (m.round_name as string | null) ?? null,
    status:           m.status as string,
    scores:           (m.scores as Array<{ a: number; b: number }> | null) ?? null,
    is_bye:           !!m.is_bye,
    aId:              (doubles ? m.pair_a_id : m.participant_a_id) as string | null,
    bId:              (doubles ? m.pair_b_id : m.participant_b_id) as string | null,
    winnerId:         (doubles ? m.winner_pair_id : m.winner_participant_id) as string | null,
  });
  const drawMatches = bracketMatches.map(toDrawMatch);
  const stagedMatches: StagedPlayerMatch[] = stagedCfg
    ? allMatches.filter((m) => m.stage != null).map((m) => ({
        ...toDrawMatch(m),
        stage:          m.stage as number,
        pool_number:    (m.pool_number as number | null) ?? null,
        group_number:   (m.group_number as number | null) ?? null,
        slot:           (m.slot as number | null) ?? null,
        match_label:    (m.match_label as string | null) ?? null,
        match_number:   (m.match_number as number | null) ?? null,
        is_third_place: !!m.is_third_place,
        handicap_a:     (m.handicap_a as number | null) ?? 0,
        handicap_b:     (m.handicap_b as number | null) ?? 0,
      }))
    : [];
  const stageViews = stagedCfg
    ? stagesView(stagedCfg, formatResultsFrom(
        stagedCfg,
        (doubles ? pairs : participants).map((e) => ({
          id: e.id as string, seed: (e.seed_number as number | null) ?? null, status: e.status as string,
        })),
        stagedMatches.map((m) => ({
          stage: m.stage, status: m.status, pool_number: m.pool_number, group_number: m.group_number,
          round_number: m.round_number, match_label: m.match_label, is_third_place: m.is_third_place,
          a: m.aId, b: m.bId, winner: m.winnerId, scores: m.scores,
        })),
      ))
    : [];
  const drawThirdPlace = thirdPlaceMatch ? toDrawMatch(thirdPlaceMatch) : null;

  // THE VIEWER'S OWN RECORD, over EVERY match in the event (pool, knockout and
  // the third-place playoff), since each of those is a match they played. phase
  // rides along so the last match is the knockout one on a pool_to_bracket
  // event, where round_number restarts.
  const myRecord = playerEntryId
    ? eventRecordFor(
        allMatches.map((m) => ({ ...toDrawMatch(m), phase: (m.phase as string | null) ?? null })),
        playerEntryId,
      )
    : null;
  const myLastOpponent = myRecord?.last?.opponentId
    ? participantNameMap[myRecord.last.opponentId] || 'TBD'
    : 'TBD';

  // THE VIEWER'S OWN RATING LINE, singles only (a pair has no rating row), read
  // on its own rather than by widening either participant read above. Adding
  // elo_before/elo_after to the all-participants select would ship every
  // entrant's absolute rating to every visitor; adding them to `regRes` would put
  // them behind `unwrap`, so a failed read would 500 the page. This one fails
  // soft, like the partner lookup: an error costs the rating line and nothing
  // else. Asked only once there is a result to put a rating beside.
  let myRating: ReturnType<typeof eventRatingLine> = null;
  if (!doubles && currentPlayer && playerEntryId && myRecord && myRecord.played > 0) {
    const ratingRes = await supabase
      .from('tournament_participants')
      .select('elo_before, elo_after, elo_change')
      .eq('id', playerEntryId)
      .eq('player_id', currentPlayer.id)
      .maybeSingle();
    const mine = ratingRes.data;
    if (mine) myRating = eventRatingLine(mine.elo_before, mine.elo_after, mine.elo_change);
  }

  return (
    <div className="space-y-5 pb-28 px-4 sm:px-0">
      {/* THE SCREEN THIS WHOLE CHANGE IS FOR. An entrant sits courtside with
          this page open waiting to learn whether their next match is ready, and
          every write that could tell them is made by an exec at the scoring
          table — so until now the answer only arrived if they thought to pull
          to refresh.

          `draw` is TRUE here and nowhere else on the player side: this is the
          one player screen that reads tournament_matches. One eventId, so the
          match filter is this event's and a score in the men's singles does not
          wake somebody watching the mixed doubles. */}
      <LiveTournament
        channel={`player-tournament-event-${eventId}`}
        tournamentId={tournamentId}
        eventIds={[eventId]}
        draw
      />
      <Link
        href={`/tournaments/${tournamentId}`}
        aria-label="Back to tournament"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors duration-150 group min-h-[44px] py-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <ArrowLeft className="w-4 h-4 transition-transform duration-150 group-hover:-translate-x-0.5" />
        Back to {tournament.name}
      </Link>

      {/* Event Header */}
      <FadeIn>
        <div className="card-elevated rounded-2xl overflow-hidden">
          <div className="h-1.5" style={{ background: statusColor }} />
          <div className="p-5">
            <p className="eyebrow mb-1">Event</p>
            <h1 className="display-lg leading-none mb-1 min-w-0 truncate">
              {TOURNAMENT_EVENT_TYPE_LABELS[eventType]}
            </h1>
            <p className="text-sm text-[var(--text-muted)] mb-3">
              {tournament.name} &middot; {formatDate(tournament.start_date)}
            </p>

            <div className="flex flex-wrap items-center gap-2 mb-4">
              <span
                className="chip"
                role="status"
                style={{ borderColor: `${statusColor}50`, background: `${statusColor}18`, color: statusColor }}
              >
                <span className="sr-only">Event status: </span>
                {eventStatusLabel(event.format as string, eventStatus)}
              </span>
              <span className="chip">
                {TOURNAMENT_EVENT_FORMAT_LABELS[event.format as keyof typeof TOURNAMENT_EVENT_FORMAT_LABELS]
                  ?? (event.format as string)}
              </span>
              <span className="chip">
                {staged ? describeStagedFormat(stagedCfg) : matchShape}
              </span>
              {playerRegistration && (
                <span className={`chip ${
                  playerOutOfEvent ? 'chip-red' : playerRegistration.status === 'checked_in' ? 'chip-success' : 'chip-info'
                }`}>
                  <span className="sr-only">Your status: </span>
                  {playerOutOfEvent
                    ? (playerRegistration.status === 'withdrawn' ? 'Withdrawn' : 'Disqualified')
                    : playerRegistration.status === 'checked_in' ? 'Checked In' : 'Registered'}
                </span>
              )}
              {tournament.suspended_at && (
                <span className="chip chip-red" role="status">
                  <span className="sr-only">Tournament status: </span>Suspended
                </span>
              )}
            </div>

            {tournament.suspended_at && (
              <p className="text-sm text-[var(--text-muted)] mb-4" role="status">
                This tournament is currently suspended
                {tournament.suspension_reason ? `: ${tournament.suspension_reason}` : '.'}
              </p>
            )}

            <EventActions
              eventId={eventId}
              eventStatus={eventStatus}
              playerRegistration={playerRegistration}
              isDoubles={doubles}
              suspended={!!tournament.suspended_at}
              eventWaiverText={tournament.waiver_text}
              membershipBlocked={membershipBlocked}
              registrationNotice={registrationNotice}
              checkinNotice={checkinNotice}
              waitlist={waitlist}
              clubEvent={clubEvent}
            />
          </div>
        </div>
      </FadeIn>

      {/* Your Matches — FIRST CARD ON THE PAGE, above the draw and the roster
          both. "keep this up top".

          Somebody opening this page is standing in the venue and came for one
          answer: which court, and am I on next. Everything below is reference
          material they can scroll to. This card used to sit under the draw,
          which put a converging wall chart — nine columns and up to 127 cards
          on a 128-entrant event — between the reader and the one line they
          opened the page for. The roster argument this comment used to make
          still holds; the draw is simply the bigger offender.

          It also owns the YOU'RE READY control, which is the only thing on the
          page a member ACTS on rather than reads, and an action buried under a
          wall chart is an action the desk does not hear about. */}
      {playerEntryId && allMatches.length > 0 && (
        <FadeIn delay={0.05}>
          <div className="card-elevated rounded-2xl overflow-hidden">
            <div className="p-4 pb-0 mb-3">
              <p className="eyebrow mb-1">For you</p>
              <div className="flex items-center gap-2">
                <Star className="w-4 h-4 text-[var(--color-gold)]" />
                <h2 className="display-md">Your Matches</h2>
              </div>
            </div>
            {/* An entry that is out of the event still owns rows here — the
                matches it played stay on the record. Say so once at the top so
                an unplayed one below is not read as "still on". */}
            {playerOutOfEvent && (
              <p className="px-4 pb-2 text-xs text-[var(--text-secondary)]" role="status">
                You are no longer in this event. Any unplayed match here is forfeited to your opponent.
              </p>
            )}
            <div className="px-4 pb-4 space-y-2">
              {myRecord && myRecord.played > 0 && (
                <YourEventSoFar
                  record={myRecord}
                  opponentName={myLastOpponent}
                  doubles={doubles}
                  rating={myRating}
                />
              )}
              {allMatches
                .filter((m) => {
                  const aId = doubles ? m.pair_a_id : m.participant_a_id;
                  const bId = doubles ? m.pair_b_id : m.participant_b_id;
                  return aId === playerEntryId || bId === playerEntryId;
                })
                .map((m) => {
                  const matchStatus  = m.status as TournamentMatchStatus;
                  const scores       = m.scores as Array<{ a: number; b: number }> | null;
                  const scoreStr     = formatScores(scores);
                  const playerSide   = (doubles ? m.pair_a_id : m.participant_a_id) === playerEntryId ? 'a' : 'b';
                  const opponentSide = playerSide === 'a' ? 'b' : 'a';
                  const won          = isWinner(m, playerSide as 'a' | 'b');
                  const opponentName = getEntryName(m, opponentSide as 'a' | 'b');
                  const done         = matchStatus === 'completed' || matchStatus === 'walkover';

                  // WHERE TO GO. `court` is free text an exec typed, so it is
                  // normalised rather than prefixed — see @badminton/shared
                  // courtLabel, which absorbs a desk that types "Court 3" as
                  // readily as one that types "3".
                  const court = courtLabelOrTbc(m.court as string | null);
                  const courtSet = !!courtLabel(m.court as string | null);

                  const readyIds = (m.ready_player_ids as string[] | null) ?? [];
                  const iAmReady = !!currentPlayer && readyIds.includes(currentPlayer.id);
                  const partnerReady = doubles && playerPartnerId ? readyIds.includes(playerPartnerId) : null;

                  // WHEN THE CONTROL IS OFFERED. A match still to be played, in
                  // an event the viewer is still in. Not on a finished one, and
                  // not once they have withdrawn or been disqualified —
                  // `playerOutOfEvent` already draws that line two lines below
                  // for the label, and turning up for a match you have forfeited
                  // is the one thing this button must not invite.
                  //
                  // 'pending' IS INCLUDED. A member whose opponent is not known
                  // yet is exactly the person the desk wants to hear from, and
                  // making them wait for the other semi-final to finish before
                  // they can say "I'm here" would be the label problem again in
                  // a different costume. 00135's function agrees.
                  //
                  // 'live' IS NOT, AND THAT CHANGED. It used to be in this list on
                  // the grounds that it was harmless — which was true only because
                  // nothing in either app could write 'live' at all (00136 traces
                  // it). Now that the desk can send a match on court, the state is
                  // reachable, and offering "I'm ready" to somebody who is already
                  // playing is a control with nothing behind it. The row says "On
                  // court now" instead, which is the informative thing.
                  const canSayReady =
                    !!currentPlayer && !done && !playerOutOfEvent &&
                    (matchStatus === 'ready' || matchStatus === 'pending');

                  return (
                    <div
                      key={m.id as string}
                      className={`p-3 border ${
                        done
                          ? won
                            ? 'border-[color-mix(in_oklab,var(--color-success)_20%,transparent)] bg-[color-mix(in_oklab,var(--color-success)_5%,transparent)]'
                            : 'border-[color-mix(in_oklab,var(--color-accent)_20%,transparent)] bg-[color-mix(in_oklab,var(--color-accent)_5%,transparent)]'
                          : 'border-[var(--border)] bg-white/[0.02]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm text-[var(--text-primary)] font-medium truncate">
                            vs {opponentName}
                          </p>
                          <p className="text-xs text-[var(--text-muted)] mt-0.5">
                            {(stagedCfg && stagedMatchHeading(stagedCfg, m)) || (m.round_name as string) || `Round ${m.round_number}`}
                            {/* A head start, said as the score the viewer's side begins on. */}
                            {Number(m[playerSide === 'a' ? 'handicap_a' : 'handicap_b'] ?? 0) > 0 && (
                              <> &middot; you start at {Number(m[playerSide === 'a' ? 'handicap_a' : 'handicap_b'])}</>
                            )}
                            {Number(m[playerSide === 'a' ? 'handicap_b' : 'handicap_a'] ?? 0) > 0 && (
                              <> &middot; they start at {Number(m[playerSide === 'a' ? 'handicap_b' : 'handicap_a'])}</>
                            )}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          {done ? (
                            <>
                              <span className={`text-sm font-bold ${won ? 'text-[var(--color-success)]' : 'text-[var(--color-accent)]'}`} role="status">
                                {won ? 'WIN' : 'LOSS'}
                              </span>
                              {scoreStr && (
                                <p className="nums text-xs text-[var(--text-muted)] mt-0.5">{scoreStr}</p>
                              )}
                            </>
                          ) : (
                            <>
                              {/* THE COURT TAKES THE SLOT THE SCORE WILL TAKE —
                                  "show which location the match is at before the
                                  score", literally. It outranks the round name
                                  on purpose: the round is context, the court is
                                  the instruction, and this is a page read while
                                  walking. "Court TBC" rather than a blank,
                                  because an empty right-hand slot is what made
                                  the old READY label read as a broken app. */}
                              <p
                                className={`display-md leading-none ${courtSet ? 'text-[var(--color-accent)]' : 'text-[var(--text-dim)]'}`}
                                role="status"
                              >
                                <span className="sr-only">Court: </span>
                                {court}
                              </p>
                              {/* A PLAIN SPAN, NOT A CHIP. The chip's border and
                                  uppercase weight are what made a status read as
                                  a control — the bug this whole change came out
                                  of. The WIN/LOSS branch immediately above has
                                  always been an unbordered span for exactly that
                                  reason, and every state that is not actionable
                                  now matches it. The one actionable state has a
                                  real button underneath instead. */}
                              <span className="block text-[11px] uppercase tracking-wide text-[var(--text-muted)] mt-1">
                                {playerOutOfEvent
                                  ? (playerRegistration?.status === 'withdrawn' ? 'Withdrawn' : 'Disqualified')
                                  : MATCH_STATE_LABELS[matchStatus] ?? matchStatus}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      {canSayReady && (
                        <MatchReady
                          matchId={m.id as string}
                          ready={iAmReady}
                          partnerReady={partnerReady}
                          isDoubles={doubles}
                        />
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        </FadeIn>
      )}

      {/* THE DRAW (single elimination, and the knockout half of a
          pool_to_bracket event).

          A CONVERGING WALL CHART on a tablet and up: the top half runs inwards
          from the left, the bottom half inwards from the right, and they meet
          at the final in the centre column. On a phone the same draw is a
          round-by-round list — see DrawRounds for why a phone does not get the
          chart. Both come out of one shared layout engine. */}
      {isSingleElim && bracketMatches.length > 0 && (
        <FadeIn delay={0.1}>
          <div className="card-elevated rounded-2xl overflow-hidden">
            {/* THE ONLY CARD ON THIS PAGE WHOSE HEADING IS NOT WRITTEN HERE.
                "let the full scren button on the one above" / "in the same row
                as draw" — the Full screen button had a stacked row of its own
                carrying nothing else, and it has to share a flex row with this
                title to stop looking orphaned. The button cannot come up here:
                it is owned by DrawScroller, which holds the fullscreen state,
                and it has to stay inside `.draw-chart-wrap` so a phone never
                sees a control for a chart a phone does not render. So the
                heading goes down to the button instead, and Draw renders it in
                the two places that between them cover every width. The markup
                stays here so it still matches the four sibling cards. */}
            <Draw
              matches={drawMatches}
              thirdPlace={drawThirdPlace}
              nameOf={participantNameMap}
              seedOf={participantSeedMap}
              heading={
                <>
                  <Trophy className="w-4 h-4 text-[var(--color-gold)]" />
                  <h2 className="display-md">Draw</h2>
                </>
              }
              // For the full-screen header only. Projected at a tournament the
              // chart is the whole screen, so it has to say which event it is.
              title={TOURNAMENT_EVENT_TYPE_LABELS[eventType]}
              subtitle={tournament.name}
            />
          </div>
        </FadeIn>
      )}

      {stagedCfg && stagedMatches.length > 0 && (
        <FadeIn delay={0.1}>
          <div className="space-y-5">
            <Stages
              cfg={stagedCfg}
              views={stageViews}
              matches={stagedMatches}
              nameOf={participantNameMap}
              seedOf={participantSeedMap}
              title={TOURNAMENT_EVENT_TYPE_LABELS[eventType]}
              subtitle={tournament.name}
            />
          </div>
        </FadeIn>
      )}

      {/* Round Robin View — the whole event on a round_robin, and the pool half
          on a pool_to_bracket. Shown ALONGSIDE the bracket on that format
          rather than instead of it: a player wants to see the pool they played
          and the draw it put them into. */}
      {!staged && poolMatches.length > 0 && (!isSingleElim || poolToBracket) && (
        <FadeIn delay={0.1}>
          <div className="card-elevated rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 p-4 pb-0 mb-3">
              <Swords className="w-4 h-4 text-[var(--color-accent)]" />
              <h2 className="display-md">{poolToBracket ? 'Round Robin' : 'Match Results'}</h2>
            </div>
            <div className="px-4 pb-4 space-y-4">
              {sortedPoolRounds.map(([roundNum, roundMatches]) => (
                <div key={roundNum}>
                  <h3 className="eyebrow mb-2">Round {roundNum}</h3>
                  <div className="space-y-2">
                    {roundMatches.map((m) => {
                      const scores      = m.scores as Array<{ a: number; b: number }> | null;
                      const scoreStr    = formatScores(scores);
                      const matchStatus = m.status as TournamentMatchStatus;
                      const winA        = isWinner(m, 'a');
                      const winB        = isWinner(m, 'b');

                      return (
                        <div
                          key={m.id as string}
                          className="border border-[var(--border)] rounded-xl overflow-hidden"
                        >
                          <div className="flex items-center">
                            <div className={`flex-1 p-2.5 text-sm truncate ${winA ? 'match-winner' : 'bg-white/[0.02] text-[var(--text-secondary)]'}`}>
                              {getEntryName(m, 'a')}{winA && <span className="sr-only"> (Winner)</span>}
                            </div>
                            <div className="nums px-3 text-xs text-[var(--text-dim)] bg-white/[0.02] py-2.5 border-x border-[var(--border)] shrink-0">
                              {matchStatus === 'completed' ? scoreStr || 'W/O' : 'vs'}
                            </div>
                            <div className={`flex-1 p-2.5 text-sm text-right truncate ${winB ? 'match-winner' : 'bg-white/[0.02] text-[var(--text-secondary)]'}`}>
                              {getEntryName(m, 'b')}{winB && <span className="sr-only"> (Winner)</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </FadeIn>
      )}

      {/* Participants / Pairs List — reference material: it keeps the heading
          but gives up the accent icon and the eyebrow, so the "for you" block
          above is the only thing on the page shouting. */}
      <FadeIn delay={0.15}>
        <ParticipantsList entries={participantEntries} doubles={doubles} />
      </FadeIn>

      {/* Final Standings */}
      {eventStatus === 'completed' && (
        <FadeIn delay={0.2}>
          <div className="card-elevated rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 p-4 pb-0 mb-3">
              <Medal className="w-4 h-4 text-[var(--color-gold)]" />
              <h2 className="display-md">Final Standings</h2>
            </div>
            <div className="px-4 pb-4 space-y-1.5">
              {(doubles ? pairs : participants)
                .filter((e: any) => e.final_position != null)
                .sort((a: any, b: any) => a.final_position - b.final_position)
                .map((e: any) => {
                  const pos    = e.final_position as number;
                  const name   = doubles
                    ? e.pair_name ?? `${(e.player1 as any)?.full_name} & ${(e.player2 as any)?.full_name}`
                    : (e.player as any)?.full_name ?? 'Unknown';
                  const points = e.points ?? 0;
                  const posColors: Record<number, string> = { 1: 'var(--color-gold)', 2: 'var(--color-silver)', 3: 'var(--color-bronze)' };
                  const isTop3 = pos <= 3;

                  return (
                    <div
                      key={e.id}
                      className={`flex items-center justify-between p-2.5 rounded-xl ${
                        pos === 1 ? 'bg-[color-mix(in_oklab,var(--color-gold)_5%,transparent)] border border-[color-mix(in_oklab,var(--color-gold)_20%,transparent)]' :
                        pos === 2 ? 'bg-white/[0.03] border border-white/[0.06]' :
                        pos === 3 ? 'bg-white/[0.02] border border-white/[0.04]' :
                        'bg-transparent border border-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className="nums text-sm font-black w-6 text-center shrink-0"
                          style={{ color: posColors[pos] ?? 'var(--text-muted)' }}
                        >
                          {pos}
                        </span>
                        {pos === 1 && <Crown className="w-3.5 h-3.5 text-[var(--color-gold)] shrink-0" aria-hidden />}
                        <span className={`text-sm font-medium truncate ${isTop3 ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                          {name}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="nums text-xs font-bold text-[var(--color-accent)]">{points} pts</span>
                        {!doubles && e.elo_change != null && (
                          <span className={`nums text-xs font-bold ${e.elo_change > 0 ? 'text-[var(--color-success)]' : e.elo_change < 0 ? 'text-[var(--color-accent)]' : 'text-[var(--text-muted)]'}`}>
                            <span className="sr-only">{e.elo_change > 0 ? 'Gained' : e.elo_change < 0 ? 'Lost' : 'No change'}: </span>
                            {e.elo_change > 0 ? '+' : ''}{e.elo_change} elo
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
