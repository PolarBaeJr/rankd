import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { Card, Badge, PageHeader } from '@badminton/ui';
import { TournamentCheckinQr } from './checkin-qr';
import { formatDate, eventStatusLabel, TOURNAMENT_EVENT_TYPE_LABELS, TOURNAMENT_EVENT_STATUS_LABELS, TOURNAMENT_EVENT_STATUS_COLORS, TOURNAMENT_EVENT_FORMAT_LABELS, describeMatchShape, describeStagedFormat, parseFormatConfig, loadTournamentEntryCounts, selectInChunks, readFeatureFlags, isDoublesEvent } from '@badminton/shared';
import type { TournamentEventFormat, TournamentEventType } from '@badminton/shared';
import { notFound } from 'next/navigation';
import { ArrowLeft, Users, Calendar, Zap, Crown, Plus, Swords, DollarSign, MapPin } from 'lucide-react';
import Link from 'next/link';
import { CreateEventButton } from './create-event';
import { TournamentStatusControls } from './tournament-status-controls';
import { LiveTournament } from '../live-tournament';
import { CourtsEditor } from './courts-editor';
import { COURTS_MIGRATION_MISSING, readTournamentCourts, readUsedCourtLabels } from '@/lib/tournament-courts';
import { loadRegistrationImports } from '@/lib/registration-imports';
import { readerStatus } from '@/lib/google-forms';
import { FormImportCard } from '@/components/registration-import/FormImportCard';

export default async function TournamentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = createAdminClient();

  // tournaments.manage.read opens the page. The Fees link is a separate
  // capability in its own group — execs run tournaments but not entry money —
  // so ask for the read the linked PAGE requires rather than for a level.
  const viewer = await requireCapability('tournaments.page');
  const canSeeFees = permits(accessLevelFor(viewer), permissionsOf(accessLevelFor(viewer), viewer), 'tournaments.fees.read');
  // Who is at the per-member event cap. Its own capability, and its own fetch —
  // the entry-count read below is skipped entirely when this is false, so the
  // gate withholds the query rather than only hiding its output.
  const canSeeEntryCounts = permits(accessLevelFor(viewer), permissionsOf(accessLevelFor(viewer), viewer), 'tournaments.draw.entrycounts.read');
  // The courts editor's writes all ask this key; without it the list is read-only.
  const canEditCourts = permits(accessLevelFor(viewer), permissionsOf(accessLevelFor(viewer), viewer), 'tournaments.manage.update.write');
  // Google Form registrations (00283). Binding a form is editing the tournament;
  // undoing an imported entry is removing it, which the server asks per entry.
  const canUndoImports =
    permits(accessLevelFor(viewer), permissionsOf(accessLevelFor(viewer), viewer), 'tournaments.draw.participants.remove.write') ||
    permits(accessLevelFor(viewer), permissionsOf(accessLevelFor(viewer), viewer), 'tournaments.draw.pairs.remove.write');
  // The list names non-members by their typed email and shows their waiver, so
  // it is FETCHED only for a viewer who edits the tournament or reads waivers.
  const canSeeImports =
    canEditCourts ||
    permits(accessLevelFor(viewer), permissionsOf(accessLevelFor(viewer), viewer), 'tournaments.draw.waivers.read');

  const { data: tournament } = await supabase.from('tournaments').select('*').eq('id', id).single();
  if (!tournament) notFound();

  // Fetch events with participant counts
  const { data: events } = await supabase
    .from('tournament_events')
    .select('*')
    .eq('tournament_id', id)
    .order('created_at');

  // The tournament's courts (00273), null before that migration, and the courts
  // already typed on its matches for the editor's one-tap import.
  const [courts, usedCourtLabels, featureFlags] = await Promise.all([
    readTournamentCourts(supabase, id),
    readUsedCourtLabels(supabase, id).catch(() => [] as string[]),
    readFeatureFlags(supabase),
  ]);
  const formImports = canSeeImports
    ? await loadRegistrationImports(supabase, 'tournament', id, {
        guestWaiversOn: featureFlags.guest_waivers === true,
      })
    : null;

  // Get participant counts per event (batch queries instead of N+1)
  const eventCounts: Record<string, number> = {};
  if (events && events.length > 0) {
    const eventIds = events.map(ev => ev.id);
    const [{ data: participantRows }, { data: pairRows }] = await Promise.all([
      supabase.from('tournament_participants')
        .select('event_id')
        .in('event_id', eventIds)
        .not('status', 'eq', 'withdrawn'),
      supabase.from('tournament_pairs')
        .select('event_id')
        .in('event_id', eventIds)
        .not('status', 'eq', 'withdrawn'),
    ]);
    for (const ev of events) {
      const isDoubles = ['mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles'].includes(ev.event_type);
      if (isDoubles) {
        eventCounts[ev.id] = pairRows?.filter(r => r.event_id === ev.id).length ?? 0;
      } else {
        eventCounts[ev.id] = participantRows?.filter(r => r.event_id === ev.id).length ?? 0;
      }
    }
  }

  // HOW MANY EVENTS EACH ENTRANT HAS TAKEN, and who is at the cap (00098).
  //
  // Behind its own capability, and the read is inside the `if` rather than the
  // render — a gate that fetches and then hides has not withheld anything.
  //
  // Counted by the SAME function the four entry paths enforce with, so the
  // number on this screen cannot disagree with the number that refuses an add.
  // That is also why this does not reuse the `participantRows`/`pairRows` above:
  // those are filtered `status != 'withdrawn'` only, which is the rule
  // max_participants has always used, and folding the cap into them would put a
  // number on screen that the actions do not enforce.
  const entryCap = (tournament as { max_events_per_player?: number | null }).max_events_per_player ?? null;
  let entrantCounts: { id: string; name: string; count: number }[] = [];
  if (canSeeEntryCounts) {
    const counts = await loadTournamentEntryCounts(supabase, id);
    if (counts.size > 0) {
      // Chunked — one id per entrant in the tournament, `.in()` is a
      // query-string filter, and the request line caps at 8 KB.
      const { data: named } = await selectInChunks<{ id: string; full_name: string }>(
        [...counts.keys()],
        (ids) => supabase.from('players').select('id, full_name').in('id', ids) as never,
      );
      entrantCounts = [...counts.entries()]
        .map(([playerId, count]) => ({
          id: playerId,
          name: named?.find((p) => p.id === playerId)?.full_name ?? 'Unknown',
          count,
        }))
        // Busiest first: the reason an exec opens this is to find who is at or
        // near the limit, and that is the top of the list rather than a scan.
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }
  }
  const atCap = entryCap === null ? [] : entrantCounts.filter((e) => e.count >= entryCap);

  // Player feedback for this tournament (attributed — the exec team moderates).
  const { data: feedback } = await supabase
    .from('feedback_reports')
    .select('id, rating, comment:body, created_at, player:players(full_name)')
    .eq('kind', 'tournament_feedback')
    .eq('tournament_id', id)
    .order('created_at', { ascending: false });
  type FeedbackRow = { id: string; rating: number | null; comment: string | null; created_at: string; player: { full_name: string } | { full_name: string }[] | null };
  const feedbackRows = (feedback ?? []) as FeedbackRow[];

  return (
    <div className="space-y-6">
      {/* The event cards below carry a status chip and an entry count each, and
          a tournament is run by more than one exec: the one on this page is
          usually NOT the one generating draws and closing check-in two courts
          away. Mounted at page level, outside every Card and every
          ResponsiveTable — that component renders its rows twice, a table and a
          stack of cards with one CSS-hidden, so a subscriber placed inside one
          would open two channels for one screen.

          `draw` STAYS FALSE. This page never reads tournament_matches; the
          brackets are one level down. Watching matches here would wake the
          overview for every score in every event it is only summarising. */}
      <LiveTournament
        channel={`admin-tournament-${id}`}
        tournamentId={id}
        eventIds={(events ?? []).map((ev) => ev.id as string)}
      />
      {/* Back link */}
      <Link href="/tournaments" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none rounded">
        <ArrowLeft className="w-4 h-4" />
        Back to Tournaments
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <PageHeader
            className="no-period !mb-0"
            title={tournament.name}
            sub={
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{formatDate(tournament.start_date)}</span>
                <span>&middot;</span>
                <span>&middot;</span>
                <span className="flex items-center gap-1"><Zap className="w-3 h-3" />{tournament.event_multiplier}x default</span>
              </span>
            }
          />
          <div className="flex gap-2 mt-3 items-center">
            {/* One code for the whole tournament — a scan checks the player
                into every event they are entered in. */}
            <TournamentCheckinQr tournamentId={tournament.id} tournamentName={tournament.name} />
            <Badge variant={tournament.status === 'active' ? 'success' : tournament.status === 'completed' ? 'neutral' : 'warning'}>
              <span className="sr-only">Tournament status: </span>{tournament.status}
            </Badge>
            {tournament.suspended_at && <Badge variant="danger">suspended</Badge>}
            {tournament.placement_bonus_enabled && <Badge variant="default">Placement Bonuses</Badge>}
          </div>
          {tournament.suspended_at && tournament.suspension_reason && (
            <p className="text-sm text-[var(--text-muted)] mt-2">{tournament.suspension_reason}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {canSeeFees && (
            <Link href={`/tournaments/${id}/fees`} className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--color-accent)] transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none rounded">
              <DollarSign className="w-4 h-4" />
              Fees
            </Link>
          )}
          <TournamentStatusControls
            tournamentId={id}
            status={tournament.status}
            suspendedAt={tournament.suspended_at}
            suspensionReason={tournament.suspension_reason}
          />
        </div>
      </div>

      {/* Events Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Swords className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Events ({events?.length ?? 0})</h2>
          </div>
          {(tournament.status === 'draft' || tournament.status === 'active') && (
            <CreateEventButton
              tournamentId={id}
              defaultEloMultiplier={tournament.event_multiplier}
              defaultPlacementBonus={tournament.placement_bonus_enabled !== false}
              siblings={(events ?? []).map((ev) => ({
                id: ev.id,
                event_type: ev.event_type,
                format: ev.format,
                group_count: (ev as { group_count?: number | null }).group_count ?? null,
                // Carried so a new event opens on the last one's match shape.
                match_format: ev.match_format,
                games_per_match: (ev as { games_per_match?: number | null }).games_per_match ?? null,
                points_per_game: (ev as { points_per_game?: number | null }).points_per_game ?? null,
              }))}
            />
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {events?.map((ev) => {
            const statusColor = TOURNAMENT_EVENT_STATUS_COLORS[ev.status as keyof typeof TOURNAMENT_EVENT_STATUS_COLORS] ?? '#6B7280';
            return (
              <Link key={ev.id} href={`/tournaments/${id}/events/${ev.id}`} className="block group focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none rounded-xl">
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 hover:border-[color-mix(in_oklab,var(--color-accent)_30%,transparent)] transition-all">
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="text-base font-semibold text-[var(--text-primary)] group-hover:text-[var(--color-accent)] transition-colors">
                      {TOURNAMENT_EVENT_TYPE_LABELS[ev.event_type as keyof typeof TOURNAMENT_EVENT_TYPE_LABELS] ?? ev.event_type}
                    </h3>
                    <span
                      className="text-xs font-medium px-2 py-0.5 rounded-full"
                      role="status"
                      style={{ color: statusColor, backgroundColor: `${statusColor}15` }}
                    >
                      <span className="sr-only">Event status: </span>{eventStatusLabel(ev.format as string, ev.status as keyof typeof TOURNAMENT_EVENT_STATUS_LABELS) ?? ev.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-[var(--text-muted)]">
                    {/* The LABEL, not the enum. `.replace('_',' ')` replaces
                        only the FIRST underscore, so pool_to_bracket rendered
                        as "Pool To_bracket" — and even fixed it would say
                        "Pool To Bracket" rather than the name the rest of the
                        console uses. */}
                    <span>{TOURNAMENT_EVENT_FORMAT_LABELS[ev.format as TournamentEventFormat] ?? ev.format}</span>
                    <span>&middot;</span>
                    <span className="flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" />
                      {eventCounts[ev.id] ?? 0}{ev.max_participants ? `/${ev.max_participants}` : ''}
                    </span>
                    <span>&middot;</span>
                    <span>{ev.format === 'staged' ? describeStagedFormat(parseFormatConfig(ev.format_config)) : describeMatchShape(ev)}</span>
                    {ev.external_event && (<><span>&middot;</span><span>External, unrated</span></>)}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {(!events || events.length === 0) && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center">
            <Swords className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)] opacity-50" />
            <p className="text-sm text-[var(--text-muted)]">
              No events yet. {tournament.status === 'draft' ? 'Add events to this tournament to get started.' : ''}
            </p>
          </div>
        )}
      </div>

      {/* Courts (00273): what the desk picks from, and what a stage's court names must be. */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-[var(--text-muted)]" />
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Courts {courts && courts.length > 0 && <span className="text-[var(--text-muted)] font-normal">({courts.length})</span>}
          </h2>
        </div>
        <CourtsEditor
          tournamentId={id}
          courts={courts}
          usedLabels={usedCourtLabels}
          canEdit={canEditCourts}
          migrationMissing={COURTS_MIGRATION_MISSING}
        />
      </div>

      {/* Google Form registrations (00283): the bound forms and what they entered. */}
      {formImports && (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-[var(--text-muted)]" />
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Google Form{' '}
            {formImports.entries.length > 0 && (
              <span className="text-[var(--text-muted)] font-normal">({formImports.entries.length} imported)</span>
            )}
          </h2>
        </div>
        <FormImportCard
          targetKind="tournament"
          targetId={id}
          bindings={formImports.bindings}
          consumers={canEditCourts ? formImports.consumers : []}
          entries={formImports.entries}
          canBind={canEditCourts}
          canUndo={canUndoImports}
          migrationMissing="Form registrations need migration 00283."
          reader={readerStatus()}
          events={(events ?? []).map((ev) => ({
            id: ev.id as string,
            label: `${TOURNAMENT_EVENT_TYPE_LABELS[ev.event_type as keyof typeof TOURNAMENT_EVENT_TYPE_LABELS] ?? ev.event_type}${ev.external_event ? ' (external)' : ''}`,
            doubles: isDoublesEvent(ev.event_type as TournamentEventType),
          }))}
        />
      </div>
      )}

      {/* Entries per member — the cap, and who has reached it. Rendered only
          for a viewer holding tournaments.draw.entrycounts.read, and only once
          somebody has actually entered something. */}
      {canSeeEntryCounts && entrantCounts.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Users className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              Entries per member <span className="text-[var(--text-muted)] font-normal">({entrantCounts.length})</span>
            </h2>
            {entryCap === null ? (
              <Badge variant="neutral">No limit</Badge>
            ) : (
              <Badge variant="info">Limit {entryCap} per member</Badge>
            )}
            {atCap.length > 0 && (
              <Badge variant="warning">{atCap.length} at the limit</Badge>
            )}
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <p className="text-xs text-[var(--text-muted)] mb-3">
              Singles entries and doubles pairs counted together. Withdrawn and
              disqualified entries are not counted, so leaving an event frees a place up.
            </p>
            <ul className="divide-y divide-[var(--border)]">
              {entrantCounts.map((e) => {
                const isAtCap = entryCap !== null && e.count >= entryCap;
                return (
                  <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="text-sm text-[var(--text-primary)]">{e.name}</span>
                    <span className="flex items-center gap-2">
                      {isAtCap && <Badge variant="warning">At the limit</Badge>}
                      <span className="font-mono text-sm text-[var(--text-secondary)]">
                        {e.count}{entryCap !== null ? `/${entryCap}` : ''}
                        <span className="sr-only"> {e.count === 1 ? 'event' : 'events'} entered</span>
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {/* Player feedback — attributed, for the exec team to review. */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Feedback {feedbackRows.length > 0 && <span className="text-[var(--text-muted)] font-normal">({feedbackRows.length})</span>}
        </h2>
        {feedbackRows.length === 0 ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6 text-center">
            <p className="text-sm text-[var(--text-muted)]">No feedback submitted yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {feedbackRows.map((f) => {
              const player = Array.isArray(f.player) ? f.player[0] : f.player;
              return (
                <div key={f.id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-[var(--text-primary)]">{player?.full_name ?? 'Unknown'}</span>
                    {f.rating != null && (
                      <span className="font-mono text-sm text-[var(--color-accent)]">{'★'.repeat(f.rating)}<span className="text-[var(--text-muted)]">{'★'.repeat(5 - f.rating)}</span></span>
                    )}
                  </div>
                  {f.comment && <p className="text-sm text-[var(--text-secondary)] mt-2 whitespace-pre-wrap">{f.comment}</p>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
