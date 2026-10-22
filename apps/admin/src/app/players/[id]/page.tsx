import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { accessLevelFor, effectiveCapabilities, permissionsOf, permits } from '@/lib/permissions';
// THE WHOLE PERMISSION EDITOR, in its one-person mode. Imported across routes
// rather than copied, because a second console-access control is a second place
// that can disagree about what Admin means — see console-access.ts.
import { PermissionEditor } from '@/app/permissions/permission-editor';
import { customBaselinesFrom, personRowFrom } from '@/lib/person-row';
import {
  Badge,
  AvatarChip,
  EmptyState,
  ResponsiveTable,
  TableCard,
  Atomic,
  EditableSectionProvider,
  EditableSectionToggle,
  EditableSectionContent,
} from '@badminton/ui';
import {
  clubDate,
  readFeatureFlags,
  seasonDuesState,
  type SeasonDuesState,
  entryMembership,
  isFeeExempt,
  loadPaidDues,
  resolveEntrySeasonId,
  formatMembershipType,
} from '@badminton/shared';
import { PLAYER_STATUS_LABELS, describeMatchShape, TOURNAMENT_EVENT_TYPE_LABELS, MEMBERSHIP_TYPES, getWinRate, getStreakDisplay, getPointDifferential, formatMemberCode, summarizeSeason } from '@badminton/shared';
import type { SeasonMatchRow } from '@badminton/shared';
import { PlayerEditForm, PlayerRecordSummary } from './edit-form';
import { VarsityNotes } from './varsity-notes';
import { ReliabilityEditor } from './reliability-editor';
import { CancelDeletionButton } from './cancel-deletion-button';
import { RequireWaiverResignatureButton } from './require-waiver-resignature-button';
import { DiscordLinkPanel } from './discord-link-panel';
import { GuestMembership } from './guest-membership';
import { Panel, PanelLabel, PanelRow } from './panel';
import { notFound } from 'next/navigation';
import { ArrowLeft, Shield, Trophy, FileText, AlertTriangle, ArrowUpRight, ArrowDownRight, SquarePen, Link2, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { SeasonPicker } from './season-picker';
import { RecentMatches } from './recent-matches';
import { matchSearchKeys } from '@/lib/match-search';
import { WALKOVER_NOTES, canReadPrivateNotes, fetchPrivateNotes } from '@/lib/private-notes';

/**
 * The most matches one member can play in one season before the tally
 * under-counts. A guard against a runaway read, not a page size: the busiest
 * member on the club's books has never been within an order of magnitude of
 * this, and a number that could plausibly be hit would be a silent wrong
 * answer rather than a cap.
 */
const SEASON_TALLY_CAP = 2000;

/** Local date only. The hour a match was played is noise in a history list. */
const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default async function PlayerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { id } = await params;
  const { season: seasonParam } = await searchParams;
  // Execs manage this page; privilege, account lifecycle, the legal
  // re-signature gate and reliability counters stay with admins.
  //
  // A varsity trainer sees the same page with everything writable removed
  // EXCEPT the varsity notes panel — which is the only reason they are here.
  const viewer = await getAuthenticatedConsoleUser();
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const isAdmin = level === 'admin';
  // Ask for the capability the edit form's Save invokes, not for a level —
  // anyone holding only players.read sees this page exactly as a trainer does,
  // read-only. Same reasoning as /players itself.
  const canManage = permits(level, permissions, 'players.update.write');
  // Approving a pending signup is its own capability, and the edit form saves
  // through approvePlayer for exactly those members — so a holder of the update
  // write alone would meet a Save that can only refuse.
  const canApprove = permits(level, permissions, 'players.approve.write');
  // This page is a data view of the same rows /players lists, one member at a
  // time and in far more detail, so it is behind the same capability. Elo,
  // reliability, match history and the season archive are all withheld without
  // it.
  const canRead = permits(level, permissions, 'players.read');
  // ...but the two WRITES that live here are not. The coaching log is a
  // trainer's whole reason to be in the console and the edit form is an exec's,
  // and both need the row they act on — so a holder of either keeps the identity
  // header and their own panel. Withholding the record from them would recreate,
  // in the same breath, the blank-panel bug this change is fixing on /fees.
  const canWriteNotes = permits(level, permissions, 'players.editor.varsitynotes.write');
  const showNotes = canRead || canWriteNotes;
  /** How many of the three panels below this viewer gets — the grid's columns. */
  const panelCount = [canManage, canRead, showNotes].filter(Boolean).length;
  // CONSOLE PERMISSIONS, THE OTHER HALF OF WHAT A MEMBER'S RECORD IS. The two
  // halves are separate capabilities on purpose and either one alone is enough to
  // draw the panel: the editor itself hides the tree without the compose write
  // and hides the access control without the console write, so a holder of one
  // gets exactly the half they can use.
  //
  // Resolved once into a set because three questions are asked of it, and it is
  // the same pair permits() is given above.
  //
  // NOT gated on `permissions.page`. The resolver prunes any capability whose
  // area page is absent, so `permissions.write` cannot resolve without it —
  // asking for it here would be a second copy of a rule the resolver already
  // enforces, and the two copies would only ever disagree by going stale.
  const viewerSet = effectiveCapabilities(level, permissions);
  const canConsoleAccess = viewerSet.has('players.consoleaccess.write');
  const canComposePermissions = viewerSet.has('permissions.write');
  const showPermissions = canComposePermissions || canConsoleAccess;
  // ATTACHING A DISCORD ACCOUNT BY HAND, off the same resolved set. It gates the
  // fetch below as well as the panel, because what the panel shows is not roster
  // data: it is the current state of the act this capability performs, so
  // `players.read` is not the right question to ask about it.
  const canForceLink = viewerSet.has('players.discordlink.write');
  // Nobody with a claim on this member at all. Every query below is skipped —
  // including the one that decides notFound(), which is deliberate: whether a
  // particular id exists is itself something the roster would tell them.
  if (!canRead && !canManage && !canWriteNotes) {
    return (
      <div className="space-y-6">
        <Link href="/players" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to Players
        </Link>
        <Panel>
          <EmptyState
            title="Member records are not shown to you"
            description="You can open the roster section, but not the people in it."
          />
        </Panel>
      </div>
    );
  }
  const supabase = createAdminClient();

  // Which season this page is showing. Defaults to the active one; ?season=
  // overrides it so a particular season's view is a shareable link. Everything
  // it scopes is behind players.read, so without that there is nothing to scope
  // and no picker to draw.
  const { data: seasons } = canRead
    ? await supabase
        .from('seasons')
        .select('id, term, year, active_flag, start_date, end_date')
        .order('year', { ascending: false })
        .order('term')
    : { data: null };
  const seasonList = seasons ?? [];
  const selectedSeason =
    seasonList.find((s) => s.id === seasonParam)
    ?? seasonList.find((s) => s.active_flag)
    ?? seasonList[0]
    ?? null;
  // Null without players.read, because the season list it is chosen from was
  // never fetched. The season-archive query further down leans on exactly that
  // — keep the implication if this is ever restructured.
  const seasonId = selectedSeason?.id ?? null;
  const isActiveSeason = Boolean(selectedSeason?.active_flag);

  const [
    { data: player },
    { data: rating },
    { data: reliability },
    { data: recentMatches },
    { data: seasonTallyRows },
    { data: varsityNotes },
    { data: walkoverEvents },
    { data: tournamentNoShows },
    { data: baselineRows },
    { data: discordLink },
  ] = await Promise.all([
    // The member row itself stays: it is what notFound() reads, what the
    // identity header draws, and what seeds the edit form for somebody who may
    // change this person without browsing the club.
    supabase.from('players').select('*').eq('id', id).single(),
    // Everything from here down is the DETAIL, and every one of these is skipped
    // rather than hidden — a row that reaches this component reaches the RSC
    // payload whether or not it is drawn.
    canRead
      ? supabase.from('ratings').select('*').eq('player_id', id).single()
      : Promise.resolve({ data: null }),
    canRead
      ? supabase.from('reliability_metrics').select('*').eq('player_id', id).maybeSingle()
      : Promise.resolve({ data: null }),
    // !inner so the season filter on the embedded matches row actually
    // excludes the participant row rather than just nulling the embed.
    canRead
      ? supabase.from('match_participants')
          .select('*, match:matches!inner(*, match_games(*))')
          .eq('player_id', id)
          .eq('match.season_id', seasonId ?? '')
          .order('created_at', { ascending: false, referencedTable: 'matches' })
          .limit(10)
      : Promise.resolve({ data: null }),
    // The SEASON'S RECORD, counted from that season's own match rows.
    //
    // Deliberately a second read rather than a bigger `recentMatches`: that one
    // draws a table and pulls `matches(*)` plus every `match_games` row, and
    // widening it from 10 to the whole season to get six integers would drag
    // the game-by-game scores of an entire term into the RSC payload. This
    // selects only the six columns `summarizeSeason` reads.
    //
    // SEASON_TALLY_CAP is a guard, not a page size. A member playing more than
    // this in one term would under-count, which is why it is far above any
    // plausible season rather than a round number.
    canRead
      ? supabase.from('match_participants')
          .select('win_flag, points_scored, points_allowed, match:matches!inner(match_type, result_status, played_at)')
          .eq('player_id', id)
          .eq('match.season_id', seasonId ?? '')
          .limit(SEASON_TALLY_CAP)
      : Promise.resolve({ data: null }),
    // The coaching log follows the NOTE capability as well as the read. It is
    // not roster data — it is the thing a varsity trainer comes here to write —
    // and gating it on the roster alone would leave a holder of the write
    // staring at the blank panel this change exists to abolish.
    showNotes
      ? supabase.from('varsity_notes').select('*, author:players!varsity_notes_author_id_fkey(full_name)').eq('player_id', id).order('created_at', { ascending: false })
      : Promise.resolve({ data: null }),
    // walkovers carries no season_id and reaches a match only through the
    // challenge, which has none either — so it is scoped by date against the
    // season window instead of a two-hop embed filter.
    canRead
      ? supabase.from('walkovers')
          // admin_notes IS NO LONGER SELECTED. 00118 moved the exec's verdict
          // to walkover_admin_notes, and this panel is the sharpest reason it
          // had to move: it is the walkover history of ONE named member, so
          // every note on it is that member's own file.
          .select('id, walkover_type, notice_hours, reported_at, status, challenge:challenges(type), reporter:players!walkovers_reported_by_fkey(full_name)')
          .eq('forfeit_player_id', id)
          .gte('reported_at', selectedSeason?.start_date ?? '1970-01-01')
          .lte('reported_at', selectedSeason?.end_date ?? '2999-12-31')
          .order('reported_at', { ascending: false })
      : Promise.resolve({ data: null }),
    canRead
      ? supabase.from('tournament_participants')
          .select('id, status, event:tournament_events!inner(event_type, tournament:tournaments!inner(name, season_id))')
          .eq('player_id', id)
          .eq('event.tournament.season_id', seasonId ?? '')
          .eq('status', 'no_show')
      : Promise.resolve({ data: null }),
    // The club's own baselines, for the permission editor's "Starts from"
    // picker. Read here for the same reason /permissions reads them in its page:
    // the editor is a client component, and this is a query the service-role
    // client is already open for. No holder count — that is a question the
    // baseline MANAGER asks, and this panel has no manager in it.
    //
    // Ordered the same way /permissions orders it, so the picker offers the
    // club's jobs in the same order on both screens.
    showPermissions
      ? supabase
          .from('permission_baselines')
          .select('id, name, capabilities, builtin_role, created_at, updated_at')
          .order('name')
      : Promise.resolve({ data: [] }),
    // The Discord link, behind the force-link capability rather than behind
    // players.read, for the reason given where that flag is resolved. SKIPPED
    // and not merely undrawn, exactly like the detail queries above: a row that
    // reaches this component reaches the RSC payload whether or not anything
    // renders it, and which Discord account a member holds is not something to
    // ship to a browser that may not ask for it.
    canForceLink
      ? supabase
          .from('player_discord_links')
          .select('discord_user_id, linked_at, last_synced_at')
          .eq('player_id', id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  if (!player) notFound();

  // A guest (00292), and who asked an admin to make them a member, if anyone.
  const guest = player as { is_guest?: boolean; email?: string | null; guest_member_requested_by?: string | null; guest_member_requested_at?: string | null };
  const isLiveGuest = !!guest.is_guest && !guest.email?.endsWith('@deleted.invalid');
  const guestRequester = isLiveGuest && guest.guest_member_requested_by
    ? ((await supabase.from('players').select('full_name').eq('id', guest.guest_member_requested_by).maybeSingle())
        .data?.full_name as string | undefined) ?? 'An officer'
    : null;

  // THIS SEASON'S DUES, for the door: Paid, Waived, Exempt or Unpaid. Only a
  // holder of the capability that records a payment is shown any of it, and
  // only with the fees switch on; for anyone else nothing is read. Always the
  // RUNNING season, whatever the picker below is showing.
  const duesState: SeasonDuesState | null =
    viewerSet.has('fees.clubfees.markpaid.write') && (await readFeatureFlags(supabase)).fees
      ? await (async () => {
          const { data: running } = await supabase.from('seasons').select('id').eq('active_flag', true).maybeSingle();
          if (!running) return null;
          const { data: dues } = await supabase
            .from('club_fees')
            .select('paid_at, method')
            .eq('player_id', id)
            .eq('season_id', running.id)
            .eq('fee_type', 'dues')
            .maybeSingle();
          return seasonDuesState(dues, { isExec: Boolean(player.is_exec), feeExempt: Boolean(player.fee_exempt) });
        })()
      : null;

  // THE GROUP THIS MEMBER ENTERS TOURNAMENTS AS THIS SEASON (00260): Internal
  // means the club fee is paid, so it can differ from Type above. Shown only to
  // a holder of the capability that already sees dues state, since "club fee
  // unpaid" is exactly that; unlike the dues badge it does not wait on the fees
  // switch, because the entry gate does not either. Null on a failed read.
  const entryGroup: string | null =
    canRead && viewerSet.has('fees.clubfees.markpaid.write')
      ? await (async () => {
          const season = await resolveEntrySeasonId(supabase, null);
          if (season.error) return null;
          const paid = await loadPaidDues(supabase, season.seasonId, [player.id]);
          if (!paid) return null;
          const exempt = isFeeExempt(player);
          const group = entryMembership({
            stored: (player as { membership_type?: string | null }).membership_type,
            exempt,
            paid: paid.has(player.id),
            hasSeason: season.seasonId !== null,
          });
          if (group === 'internal' && exempt) return 'Internal (exempt)';
          if (group === 'internal' && paid.has(player.id)) return 'Internal (club fee paid)';
          if (group === 'external' && season.seasonId !== null) return 'External (club fee unpaid)';
          return formatMembershipType(group);
        })()
      : null;

  // ratings holds ONE cumulative Elo with no season dimension, so it is only
  // the right answer for the season currently running. For a past season the
  // archived snapshot is what that season actually ended on; showing today's
  // live rating under a 2024 heading would be plainly wrong.
  let r = rating;
  if (!isActiveSeason && seasonId) {
    const { data: archived } = await supabase
      .from('season_final_ratings')
      .select('singles_elo, doubles_elo')
      .eq('player_id', id)
      .eq('season_id', seasonId)
      .maybeSingle();
    // No snapshot means the player did not finish that season — null rather
    // than falling back to the live rating, which would silently misattribute
    // their current standing to a season they were not in.
    //
    // THE SPREAD IS ELO AND NOTHING ELSE, AND THAT USED TO BE THE BUG. This was
    // `{...rating, ...archived}`, and because `season_final_ratings` holds only
    // `singles_elo` and `doubles_elo`, every other column fell through from the
    // LIVE row: a 2024 Elo was drawn beside today's cumulative W-L, today's
    // streak and today's point differential, under a heading that calls them
    // the season's headline numbers. The two elo values are still taken from
    // the archive here, because a closing Elo is the one figure that cannot be
    // recomputed. Everything else now comes from `seasonRecord` below.
    r = archived ? ({ ...rating, ...archived } as typeof rating) : null;
  }

  // Counted from the season's own match rows, never read off `ratings`.
  //
  // `ratings` is cumulative across every season and is REBASED at a rollover,
  // so its win column has never been an answer to "how did they do in Fall
  // 2026". `matches.season_id` makes the real answer derivable, and
  // summarizeSeason is the same tally /my-stats?season= has always used — the
  // two screens can no longer disagree about a member's term.
  //
  // Computed for the ACTIVE season too, not just past ones. A live term's
  // record is just as derivable, and taking it from the same source in both
  // branches is what stops this page drifting back apart.
  // The `match` embed is typed as an ARRAY by the generated types even though a
  // to-one relation returns an object, so it is unwrapped rather than trusted —
  // the same defence past-season.tsx and the opponent map already use. Reading
  // `.match_type` straight off it would be `undefined` at runtime with no type
  // error, and summarizeSeason would count every row as unsettled and report a
  // clean 0-0 for a season the member actually played.
  const seasonRecord = summarizeSeason(
    ((seasonTallyRows ?? []) as unknown as Array<{
      win_flag: boolean | null;
      points_scored: number | null;
      points_allowed: number | null;
      match:
        | { match_type: string | null; result_status: string | null; played_at: string | null }
        | { match_type: string | null; result_status: string | null; played_at: string | null }[]
        | null;
    }>).map((row): SeasonMatchRow => {
      const m = Array.isArray(row.match) ? (row.match[0] ?? null) : row.match;
      return {
        win_flag: row.win_flag,
        points_scored: row.points_scored,
        points_allowed: row.points_allowed,
        match_type: m?.match_type ?? null,
        result_status: m?.result_status ?? null,
        played_at: m?.played_at ?? null,
      };
    })
  );

  // Empty for a member with neither, which is every member until they pick a
  // handle and a pending signup who has not been given a code yet.
  //
  // The code is labelled rather than printed bare. `@kiera · K3F9TQ2` reads as
  // two names for the same person; `@kiera · MEMBER K3F9TQ2` says what the
  // second one is, which matters more now that it is not a number and cannot be
  // recognised as one.
  const memberCode = formatMemberCode(player.member_code);
  const identity = [
    player.handle ? `@${player.handle}` : null,
    memberCode ? `MEMBER ${memberCode}` : null,
  ].filter(Boolean).join(' · ');

  // Selected via `select('*')` but absent from the shared Player type, exactly
  // as the edit form reads it.
  const membershipType = (player as { membership_type?: string }).membership_type ?? 'internal';
  const membershipLabel = MEMBERSHIP_TYPES.find((m) => m.value === membershipType)?.label ?? membershipType;

  const events = [...(walkoverEvents ?? []), ...(tournamentNoShows ?? [])];

  // The verdicts for the walkovers listed above, from the private table 00118
  // moved them to. Gated on the AUTHOR union (walkovers.confirm.write ∪
  // walkovers.reject.write) rather than on `players.read`, which is what gates
  // the rest of this panel: reading a member's reliability history and reading
  // the exec commentary attached to it are different permissions, and only the
  // second is what this change is about.
  //
  // NO FALLBACK TO THE LEGACY COLUMN HERE, unlike /walkovers and the tournament
  // event page — the select above no longer asks for it, and re-adding it just
  // to fall back would put the column back in the RSC payload for every viewer
  // of this page, which is what the narrowed select exists to stop. Before 00118
  // is applied this panel simply shows no notes.
  const maySeeWalkoverNotes = canReadPrivateNotes(level, permissions, WALKOVER_NOTES);
  const walkoverNotes = maySeeWalkoverNotes
    ? await fetchPrivateNotes(supabase, WALKOVER_NOTES, (walkoverEvents ?? []).map((w) => w.id))
    : new Map<string, string>();

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link href="/players" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to Players
      </Link>

      {/* Identity header, in the console's editorial style: mono eyebrow,
          display-font name, mono identity line. Hand-rolled rather than
          <PageHeader> because that component has no leading slot and the avatar
          belongs beside the name, not above it. The classes are the shared ones
          from globals.css, so the typography is the same either way.

          NOTHING HERE IS NEW: name, email, handle, number and the level badges
          are exactly what this header showed before. The member row is the one
          query that runs without players.read, so anything added here would be
          added for a notes-only trainer too — the extended detail lives in the
          Membership panel below, behind the read. */}
      <div className="page-header no-period !mb-0">
        <div className="flex min-w-0 items-start gap-4">
          <AvatarChip name={player.full_name} size="lg" id={player.id} />
          <div className="min-w-0">
            <div className="page-eyebrow">
              <span className="bar" />
              Member
            </div>
            <h1 className="page-title">{player.full_name}</h1>
            <div className="page-sub">
              {player.email}
              {/* Both read-only, and read-only for different reasons: the handle
                  belongs to the member (nobody sets anyone else's), and the
                  number belongs to the club (nobody sets one at all). Neither is
                  in adminPlayerUpdateSchema, so the Edit dialog cannot offer
                  them even by accident. */}
              {identity && (
                <span className="mt-1 block font-mono text-xs text-[var(--text-muted)]">{identity}</span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant={player.status === 'competitive' ? 'success' : player.status === 'suspended' ? 'danger' : 'default'}>
                {PLAYER_STATUS_LABELS[player.status as keyof typeof PLAYER_STATUS_LABELS]}
              </Badge>
              <Badge variant="neutral">
                <Shield className="w-3 h-3 inline mr-1" />
                {player.role}
              </Badge>
              {player.is_exec && <Badge variant="info">Exec</Badge>}
              {player.is_trainer && <Badge variant="info">Trainer</Badge>}
              {/* Badge takes no title, so the span carries the date. */}
              {player.media_consent && (
                <span title={player.media_consent_changed_at ? `Since ${clubDate(player.media_consent_changed_at)}` : undefined}>
                  <Badge variant="success">Photo consent</Badge>
                </span>
              )}
              {duesState && (
                <Badge
                  variant={duesState === 'paid' ? 'success' : duesState === 'unpaid' ? 'warning' : 'neutral'}
                >
                  {duesState === 'paid'
                    ? 'Dues paid'
                    : duesState === 'waived'
                      ? 'Dues waived'
                      : duesState === 'exempt'
                        ? 'Dues exempt'
                        : 'Dues unpaid'}
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Season switcher. Everything below is scoped to this season EXCEPT
            varsity notes and reliability — those are a player's standing record
            and follow them across seasons. Nothing it scopes was fetched without
            players.read, so a picker over an empty page is not offered. */}
        {canRead && (
          <div className="flex flex-col items-start gap-2 md:items-end">
            <SeasonPicker seasons={seasonList} selectedId={seasonId} />
            {!isActiveSeason && (
              <p className="text-xs text-[var(--text-muted)]">
                Past season — ratings are that season&apos;s final archived values.
              </p>
            )}
          </div>
        )}
      </div>

      {/* The roster read, withheld. Said once, above the panels that survive it,
          rather than letting the reliability card say "No reliability data" and
          Recent Matches say "No matches" — both of which are false and neither
          of which a reader could tell apart from a quiet member. */}
      {!canRead && (
        <Panel>
          <EmptyState
            title="This member’s record is not shown to you"
            description={
              canManage
                ? 'You can edit them, but their ratings, reliability and match history are not yours to see.'
                : 'Their ratings, reliability and match history are not yours to see.'
            }
          />
        </Panel>
      )}

      {/* Pending self-service account deletion. `.danger-zone` is the console's
          existing red-hairline call-out; it replaces a hand-mixed
          --color-danger/10 wash, which was the one raw colour value on this
          page that no token stood behind. */}
      {player.deletion_requested_at && (
        <div className="danger-zone flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" />
            <div>
              <p className="danger-title">Deletion requested</p>
              <p className="text-sm text-[var(--text-secondary)]">
                Requested {day(player.deletion_requested_at)} — permanently anonymized on{' '}
                {day(new Date(new Date(player.deletion_requested_at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString())}.
              </p>
            </div>
          </div>
          {isAdmin && <CancelDeletionButton playerId={player.id} />}
        </div>
      )}

      {/* The season's headline numbers, as the console's hairline stat strip
          rather than four bordered tiles. `.stat-strip` is grid-auto-flow:column
          and reflows to two columns on a phone, so it needs no breakpoint
          classes of its own. */}
      {r && (
        <div className="stat-strip">
          <div>
            <p className="stat-label">Singles Elo</p>
            {/* The one figure that is NOT derived. For a past season this is the
                archived close; for the live one it is today's rating. */}
            <p className="stat-value">{r.singles_elo}</p>
            <p className="mt-1.5 font-mono text-[11px] text-[var(--text-muted)]">
              {/* Provisional is a state of the LIVE ladder, so it is only said
                  about the season that is actually running. Printing today's
                  flag under a finished term was part of the same mistake as the
                  W-L beside it. */}
              {isActiveSeason ? `${r.singles_provisional ? 'Provisional' : 'Established'} · ` : ''}
              {seasonRecord.singles.wins}W-{seasonRecord.singles.losses}L ({getWinRate(seasonRecord.singles.wins, seasonRecord.singles.losses)})
            </p>
          </div>
          <div>
            <p className="stat-label">Doubles Elo</p>
            <p className="stat-value">{r.doubles_elo}</p>
            <p className="mt-1.5 font-mono text-[11px] text-[var(--text-muted)]">
              {isActiveSeason ? `${r.doubles_provisional ? 'Provisional' : 'Established'} · ` : ''}
              {seasonRecord.doubles.wins}W-{seasonRecord.doubles.losses}L ({getWinRate(seasonRecord.doubles.wins, seasonRecord.doubles.losses)})
            </p>
          </div>
          <div>
            {/* Best run in the term, not `current_*_streak`. A current streak is
                a fact about now and cannot be stated about a finished season;
                `best_*_streak` on `ratings` is worse still, because 00082 never
                maintains it. Both disciplines, because the streak is counted
                over the member's season in the order it was played. */}
            <p className="stat-label">Best win streak</p>
            <p className="stat-value">{getStreakDisplay(seasonRecord.bestWinStreak)}</p>
            <p className="mt-1.5 font-mono text-[11px] text-[var(--text-muted)]">
              {seasonRecord.played} match{seasonRecord.played === 1 ? '' : 'es'} this season
            </p>
          </div>
          <div>
            <p className="stat-label">Point diff</p>
            {/* summarizeSeason already subtracted; the helper is used only for
                its sign formatting, hence the 0. */}
            <p className="stat-value">{getPointDifferential(seasonRecord.pointDiff, 0)}</p>
            <p className="mt-1.5 font-mono text-[11px] text-[var(--text-muted)]">
              {seasonRecord.wins}W-{seasonRecord.losses}L overall
            </p>
          </div>
        </div>
      )}

      {/* One column per panel that survives this viewer's capabilities: the edit
          form on players.update.write, reliability on players.read, the notes on
          either the read or the note write. Three for an exec, two for a
          trainer — the same as before, now derived rather than assumed. */}
      <div className={`grid grid-cols-1 gap-6 ${
        panelCount >= 3 ? 'lg:grid-cols-3' : panelCount === 2 ? 'lg:grid-cols-2' : ''
      }`}>
        {/* Edit Form. Dropped entirely for a trainer: updatePlayer asks for
            players.update.write, so every control in it — status, membership,
            the reason box, Save — would reject them. */}
        {canManage && (
        <EditableSectionProvider>
        <Panel
          title="Member"
          icon={<SquarePen className="h-4 w-4 text-[var(--text-muted)]" />}
          trailing={<EditableSectionToggle />}
        >
          <EditableSectionContent
            read={<PlayerRecordSummary player={player} rating={r} isAdmin={isAdmin} />}
            form={<PlayerEditForm player={player} rating={r} isAdmin={isAdmin} canApprove={canApprove} />}
          />
          {isAdmin && (
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <PanelLabel>Legal</PanelLabel>
              <p className="mb-3 text-xs text-[var(--text-muted)]">
                Forces only this player to re-sign the liability waiver on their next visit.
              </p>
              <RequireWaiverResignatureButton playerId={player.id} />
            </div>
          )}
        </Panel>
        </EditableSectionProvider>
        )}

        {/* Reliability. Roster data — the counters are this member's record —
            so it goes with players.read. */}
        {canRead && (
        <Panel
          title="Reliability"
          icon={<Shield className="h-4 w-4 text-[var(--text-muted)]" />}
          /* Read-only panel below stays visible to execs; only the editor
             trigger is admin-only — adjustReliability rewrites the
             no-show/penalty counters and was not part of the brief. */
          trailing={isAdmin ? (
            <ReliabilityEditor
              playerId={id}
              noShows={reliability?.no_shows ?? 0}
              lateCancellations={reliability?.late_cancellations ?? 0}
              earlyWithdrawals={reliability?.early_withdrawals ?? 0}
              walkoverFlag={reliability?.walkover_flag ?? false}
            />
          ) : undefined}
        >
          {reliability ? (
            <>
              <div className="divide-y divide-[var(--border)]">
                {[
                  { label: 'Challenges issued', value: reliability.challenges_issued },
                  { label: 'Matches completed', value: reliability.matches_completed },
                  { label: 'No-shows', value: reliability.no_shows, danger: reliability.no_shows > 0 },
                  { label: 'Late cancellations', value: reliability.late_cancellations },
                  { label: 'Early withdrawals', value: reliability.early_withdrawals },
                  { label: 'Dispute involvement', value: reliability.dispute_involvement_count },
                ].map(({ label, value, danger }) => (
                  <PanelRow key={label} label={label} value={value} tone={danger ? 'danger' : undefined} />
                ))}
              </div>
              {/* A SIBLING of the counter stack, not a row inside it. Tailwind's
                  `divide-y` is a `> :not([hidden]) ~ :not([hidden])` rule, which
                  outranks this box's own border-color class and would repaint its
                  top edge grey — a red call-out with one grey side. It is also
                  the truer structure: this is the conclusion the counters lead
                  to, not another counter. */}
              {reliability.walkover_flag && (
                <div className="mt-4 flex items-center gap-2 border border-[var(--red-border)] bg-[var(--red-wash)] p-3">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-danger)]" />
                  <span className="text-sm font-medium text-[var(--color-danger)]">Flagged for no-shows</span>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">No reliability data</p>
          )}

          {/* Walkovers and tournament no-shows kept INSIDE this panel rather
              than promoted to a table of their own: they are the events behind
              the counters directly above, and separating them from the numbers
              they explain is what made the old layout hard to read. */}
          {events.length > 0 && (
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <PanelLabel>Events this season</PanelLabel>
              <div className="divide-y divide-[var(--border)]">
                {walkoverEvents?.map((w) => {
                  const challengeRaw = w.challenge as unknown;
                  const challenge = (Array.isArray(challengeRaw) ? challengeRaw[0] : challengeRaw) as { type: string } | null;
                  const reporterRaw = w.reporter as unknown;
                  const reporter = (Array.isArray(reporterRaw) ? reporterRaw[0] : reporterRaw) as { full_name: string } | null;
                  // <24h notice = "late" — same cutoff the walkover flow uses to
                  // increment late_cancellations vs early_withdrawals.
                  const label = w.walkover_type === 'no_show'
                    ? 'No-show'
                    : (w.notice_hours ?? 0) < 24 ? 'Late withdrawal' : 'Withdrawal';
                  return (
                    <div key={w.id} className="py-3">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm text-[var(--text-primary)]">
                          {label}
                          {w.notice_hours !== null && ` (${w.notice_hours}h notice)`}
                          {challenge && ` · ${challenge.type}`}
                        </span>
                        <Badge variant={w.status === 'pending' ? 'warning' : w.status === 'confirmed' ? 'success' : 'danger'}>
                          {w.status}
                        </Badge>
                      </div>
                      <p className="mt-1 font-mono text-[11px] text-[var(--text-muted)]">
                        {day(w.reported_at)}
                        {reporter && ` · reported by ${reporter.full_name}`}
                      </p>
                      {walkoverNotes.get(w.id) && (
                        <p className="mt-1 text-xs text-[var(--text-secondary)]">{walkoverNotes.get(w.id)}</p>
                      )}
                    </div>
                  );
                })}
                {tournamentNoShows?.map((tp) => {
                  const eventRaw = tp.event as unknown;
                  const event = (Array.isArray(eventRaw) ? eventRaw[0] : eventRaw) as { event_type: string; tournament: { name: string } | { name: string }[] | null } | null;
                  const tournamentRaw = event?.tournament as unknown;
                  const tournament = (Array.isArray(tournamentRaw) ? tournamentRaw[0] : tournamentRaw) as { name: string } | null;
                  const eventLabel = event ? (TOURNAMENT_EVENT_TYPE_LABELS[event.event_type as keyof typeof TOURNAMENT_EVENT_TYPE_LABELS] ?? event.event_type) : '';
                  return (
                    <div key={tp.id} className="flex items-start justify-between gap-2 py-3">
                      <span className="text-sm text-[var(--text-primary)]">
                        Tournament no-show{tournament && ` — ${tournament.name}`}{eventLabel && ` · ${eventLabel}`}
                      </span>
                      <Badge variant="danger">no_show</Badge>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Panel>
        )}

        {/* Varsity Notes. The coaching log, not the roster: a holder of the note
            write keeps it with no players.read at all, which is the state a
            trainer would be in if the read were ever taken off their level. */}
        {showNotes && (
        <Panel title="Varsity notes" icon={<FileText className="h-4 w-4 text-[var(--text-muted)]" />}>
          <VarsityNotes playerId={player.id} notes={varsityNotes ?? []} />
        </Panel>
        )}
      </div>

      {/* Recent Matches, ABOVE Membership: the season's play is what an officer
          opens this page for, and two standing facts should not push it below
          the fold. Through ResponsiveTable so the console works from the door
          on a phone — the desktop <table> is untouched below md, and the
          TableCard stack replaces it above. */}
      {canRead && (
      <Panel title="Recent matches" icon={<Trophy className="h-4 w-4 text-[var(--text-muted)]" />} padded={false}>
        <RecentMatches
          seasonNote="Nothing has been recorded for this member in the season shown above."
          head={
            <tr className="border-b border-[var(--border)]">
              <th className="px-5 py-3 text-left text-xs font-medium uppercase text-[var(--text-muted)]">Result</th>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase text-[var(--text-muted)]">Score</th>
              <th className="px-5 py-3 text-left text-xs font-medium uppercase text-[var(--text-muted)]">Format</th>
              <th className="px-5 py-3 text-right text-xs font-medium uppercase text-[var(--text-muted)]">Rating</th>
              <th className="px-5 py-3 text-right text-xs font-medium uppercase text-[var(--text-muted)]">Played</th>
            </tr>
          }
          // flatMap, not map: a participation row whose match failed to embed
          // is dropped outright rather than becoming a null the filter would
          // then have to count and skip.
          rows={(recentMatches ?? []).flatMap((mp) => {
            const m = mp.match as Record<string, unknown> | null;
            if (!m) return [];
            const score = (m.score_summary as string) || '—';
            const formatLabel = describeMatchShape({
              match_format: m.format as string,
              games_per_match: m.games_per_match as number | null,
              points_per_game: m.points_per_game as number | null,
            });
            const played = day(m.played_at as string | null);
            return [
              {
                id: mp.id,
                // The same strings the row draws, so anything visible is
                // findable and nothing invisible is.
                keys: matchSearchKeys({
                  win: Boolean(mp.win_flag),
                  score,
                  format: formatLabel,
                  playedAt: played,
                }),
                value: {
                  row: (
                    <tr className="transition-colors hover:bg-[var(--bg-elevated)]">
                      <td className="px-5 py-3">
                        <Badge variant={mp.win_flag ? 'success' : 'danger'}>{mp.win_flag ? 'W' : 'L'}</Badge>
                      </td>
                      <td className="px-5 py-3 font-mono text-sm text-[var(--text-secondary)]">
                        <Atomic separator=",">{score}</Atomic>
                      </td>
                      <td className="px-5 py-3 text-sm text-[var(--text-secondary)]">{formatLabel}</td>
                      <td className="px-5 py-3 text-right">
                        <RatingDelta delta={mp.rating_delta as number | null} />
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-xs text-[var(--text-muted)]">
                        {played}
                      </td>
                    </tr>
                  ),
                  card: (
                    <TableCard
                      title={mp.win_flag ? 'Win' : 'Loss'}
                      // Atomic keeps "21-18, 21-15" from breaking after a
                      // hyphen — the exact wrap this component was built to stop.
                      value={<Atomic separator=",">{score}</Atomic>}
                      badges={
                        <>
                          <Badge variant={mp.win_flag ? 'success' : 'danger'}>{mp.win_flag ? 'W' : 'L'}</Badge>
                          <Badge variant="neutral">{formatLabel}</Badge>
                        </>
                      }
                      fields={[
                        { label: 'Rating', value: <RatingDelta delta={mp.rating_delta as number | null} /> },
                        { label: 'Played', value: played },
                      ]}
                    />
                  ),
                },
              },
            ];
          })}
        />
      </Panel>
      )}

      {/* The standing membership facts, as opposed to the season's numbers
          above. Behind players.read with everything else that describes this
          member: the header carries only what the page already showed without
          the read.

          DELIBERATELY ONLY THE TWO FACTS THAT ARE NEW. Handle and member code
          belong to the header, which draws them without players.read because the
          member row is the one query that runs regardless — repeating them here
          would show a reader the same value twice and, worse, show it gated in
          one place and ungated in the other. */}
      {canRead && (
        <Panel title="Membership" icon={<Shield className="h-4 w-4 text-[var(--text-muted)]" />}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            {[
              { label: 'Type', value: membershipLabel },
              { label: 'Joined', value: day(player.joined_at) },
              ...(entryGroup ? [{ label: 'Entry group (this season)', value: entryGroup }] : []),
            ].map((f) => (
              <div key={f.label} className="min-w-0">
                <dt className="dialog-group-label !mb-1">{f.label}</dt>
                <dd className="font-mono text-sm text-[var(--text-primary)]">{f.value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      )}

      {/* DISCORD, AND DELIBERATELY OUTSIDE THE THREE-COLUMN GRID ABOVE.
          `panelCount` counts exactly three panels and the grid's column
          arithmetic is derived from it, so a fourth panel up there would change
          the layout for every viewer, including the ones who cannot see this.

          The member-run /link flow is unchanged and is still the ordinary way
          this row appears. What this panel adds is the officer's path for the
          member who will not or cannot walk it. */}
      {isLiveGuest && canManage && (
        <Panel title="Guest" icon={<UserCheck className="h-4 w-4 text-[var(--text-muted)]" />}>
          <GuestMembership
            playerId={player.id}
            playerName={player.full_name}
            isAdmin={isAdmin}
            requestedBy={guestRequester}
            requestedAt={guest.guest_member_requested_at ?? null}
          />
        </Panel>
      )}

      {/* Not for a guest (00292): nothing links one, and they become a member,
          and link, by signing in or /signup with the Form's email. */}
      {canForceLink && !(player as { is_guest?: boolean }).is_guest && (
        <Panel title="Discord" icon={<Link2 className="h-4 w-4 text-[var(--text-muted)]" />}>
          <div className="divide-y divide-[var(--border)]">
            <PanelRow
              label="Discord account"
              value={discordLink?.discord_user_id ?? 'Not linked'}
            />
            {discordLink && <PanelRow label="Linked" value={day(discordLink.linked_at)} />}
          </div>
          <DiscordLinkPanel playerId={player.id} playerName={player.full_name} linked={Boolean(discordLink)} />
        </Panel>
      )}

      {/* CONSOLE PERMISSIONS — the same editor /permissions hosts, in its
          one-person mode, on the page about the one person. It is LAST rather
          than up in the three-column grid because a collapsed sixteen-area
          capability tree plus the access box is an order of magnitude taller than
          anything above it: at the top of the page it would bury Recent matches
          and Membership entirely, and those are what an officer opens this page
          for.

          /permissions is unchanged and still the place the club's baselines are
          managed — that question is about what the jobs ARE, not who holds one,
          and it has no home on one member's record. */}
      {showPermissions && (
        <Panel title="Console permissions" padded={false}>
          <PermissionEditor
            // A FRESH INSTANCE PER MEMBER. /players/A → /players/B is the same
            // route, so React would otherwise reuse this instance and carry
            // `access`, the typed reason and the pending queue across to somebody
            // else's record. The alternative is an effect that resyncs state from
            // props, which is the defect class ../console-access-actions.tsx
            // already documents (its openDialog comment, and 5e8d25b).
            key={player.id}
            solo
            // The row is already in hand from the select('*') above — permission
            // triple and level flags included — so the panel costs no extra query.
            holders={[personRowFrom(player)]}
            // `others` is the roster of people with NO console access, offered so
            // that a level can be handed to one of them. On one person's own page
            // the target is holders[0] and there is nobody else to reach.
            others={[]}
            viewerId={viewer.id}
            viewerIsAdmin={isAdmin}
            viewerCanGrantConsole={isAdmin || canConsoleAccess}
            viewerCanComposeCapabilities={canComposePermissions}
            viewerCapabilities={[...viewerSet]}
            baselines={customBaselinesFrom(baselineRows ?? [])}
          />
        </Panel>
      )}
    </div>
  );
}

/**
 * The Elo movement one match caused. Null is a real state — a friendly, or a
 * result recorded before the engine rated it — and reads as a dash rather than
 * as a zero, which would claim the rating held steady.
 */
function RatingDelta({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined) {
    return <span className="font-mono text-sm text-[var(--text-muted)]">—</span>;
  }
  const up = delta >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 font-mono text-sm ${
        up ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
      }`}
    >
      {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {up ? '+' : ''}{delta}
    </span>
  );
}
