'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, useConfirm } from '@badminton/ui';
import {
  allowedTournamentCourts,
  describeStageScoring,
  eventIsPlaying,
  formatResultsFrom,
  matchSides,
  parseFormatConfig,
  slotRefLabel,
  stageCourtLabels,
  stageGroupLabel,
  stagedMatchHeading,
  stagesView,
  type FormatConfig,
  type GroupsStage,
  type StageView,
  type StageViewGroup,
  type TournamentCourt,
  type TournamentEventStatus,
} from '@badminton/shared';
import { Layers, Plus, RefreshCw } from 'lucide-react';
import { addStageRound, drawStage, placeLateEntrant, redrawStage } from '@/lib/tournament-actions';
import {
  lateEntrantConfirmMessage,
  lateEntryWindow,
  stageDrawControl,
  stageExtendControl,
  uncategorisedWarning,
  unplacedLateEntries,
} from '@/lib/stage-controls';
import { autoCallFailureText, deskRows } from '@/lib/live-desk';
import { useToast } from '@/components/toast-provider';
import { ScoreEntryDialog } from './ScoreEntryDialog';
import { CourtCard, type CourtDeskRow } from './CourtCard';
import { getName } from './entry-name';
import type {
  TournamentEventRow,
  TournamentMatchRow,
  ParticipantWithPlayer,
  PairWithPlayers,
  GameScore,
} from '@/lib/tournament-types';

interface Props {
  event: TournamentEventRow;
  matches: TournamentMatchRow[];
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
  canGenerate: boolean;
  /** The tournament's courts (00273), null before that migration, and the ids of the courts in use. */
  courts: TournamentCourt[] | null;
  busyCourtIds: string[];
  canManageCourts: boolean;
  canEnterResult: boolean;
}

const KIND_LABELS = { groups: 'Groups', knockout: 'Knockout', matches: 'Named matches' } as const;

/**
 * A STAGED EVENT, STAGE BY STAGE (00272). Each stage shows what it is played
 * to, its groups with their tables or its matches with the slots they wait on,
 * and the one button that draws it. The tables come from the same builder the
 * draw and the finaliser read (formatResultsFrom), so what is highlighted here
 * as going through is what the next draw will take.
 *
 * WHILE A STAGE IS PLAYED IT IS RUN FROM HERE, so the desk never switches tab:
 * a groups stage is one column per group (or pool) with its courts, its table
 * and its matches; a knockout has its courts above its matches.
 */
export function StagesTab({
  event, matches, participants, pairs, isDoubles, canGenerate, courts, busyCourtIds, canManageCourts, canEnterResult,
}: Props) {
  const [scoreMatchId, setScoreMatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const status = event.status as TournamentEventStatus;
  // The server's rule (enterMatchResultImpl), not the legacy tabs' wider one:
  // a drawn stage sits at bracket_generated until Start, and a Score button
  // there only led to "Start the event before entering results."
  const isLive = eventIsPlaying(status);

  const cfg = useMemo(() => parseFormatConfig(event.format_config), [event.format_config]);
  const entries = useMemo<Array<ParticipantWithPlayer | PairWithPlayers>>(
    () => (isDoubles ? pairs : participants),
    [isDoubles, pairs, participants],
  );
  const { nameMap, seedMap } = useMemo(() => {
    const nameMap: Record<string, string> = {};
    const seedMap: Record<string, number> = {};
    for (const e of entries) {
      nameMap[e.id] = getName(e, isDoubles);
      if (e.seed_number) seedMap[e.id] = e.seed_number;
    }
    return { nameMap, seedMap };
  }, [entries, isDoubles]);
  const placeableEntries = useMemo(
    () => entries
      .filter((e) => e.status !== 'withdrawn' && e.status !== 'disqualified')
      .map((e) => ({ id: e.id, name: nameMap[e.id] ?? 'Unknown' })),
    [entries, nameMap],
  );

  const { views, lateEntries } = useMemo(() => {
    if (!cfg) return { views: [], lateEntries: [] };
    const results = formatResultsFrom(
      cfg,
      entries.map((e) => ({ id: e.id, seed: e.seed_number ?? null, status: e.status })),
      matches.map((m) => ({
        stage: m.stage,
        status: m.status,
        pool_number: m.pool_number,
        group_number: m.group_number,
        round_number: m.round_number,
        match_label: m.match_label,
        is_third_place: m.is_third_place,
        scores: m.scores,
        ...matchSides(m, isDoubles),
      })),
    );
    // Entries in no group of the first stage, while 00308's window is open:
    // they arrived after the draw and are placed one at a time.
    const first = cfg.stages[0];
    const open = canGenerate && first?.kind === 'groups'
      && lateEntryWindow(event, matches.map((m) => m.stage));
    return {
      views: stagesView(cfg, results),
      lateEntries: open && first.kind === 'groups' ? unplacedLateEntries(first, results, entries) : [],
    };
  }, [cfg, entries, matches, isDoubles, canGenerate, event]);

  const rows = useMemo<CourtDeskRow[]>(() => {
    const sideOf = (entryId: string | null) =>
      entryId && nameMap[entryId] !== undefined ? { entryId, label: nameMap[entryId]! } : { entryId: null, label: 'TBD' };
    return deskRows(matches, sideOf, isDoubles);
  }, [matches, nameMap, isDoubles]);
  const courtsInUse = useMemo(() => new Set(busyCourtIds), [busyCourtIds]);
  const activeCourts = useMemo(() => (courts ?? []).filter((c) => c.active), [courts]);

  const categoryWarning = useMemo(() => (isDoubles ? uncategorisedWarning(pairs) : null), [isDoubles, pairs]);

  const scoreMatch = scoreMatchId ? matches.find((m) => m.id === scoreMatchId) ?? null : null;

  if (!cfg) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center text-sm text-[var(--text-muted)]">
        This event&rsquo;s stages are not set out correctly. Fix them in Event Settings.
      </div>
    );
  }

  async function press(view: StageView, action: 'draw' | 'redraw') {
    if (action === 'redraw') {
      const ok = await confirm({
        title: `Redraw ${view.stage.name}?`,
        message: `Every match in ${view.stage.name} is deleted and drawn again. Match numbers, courts and who plays whom can all change.`,
        confirmLabel: 'Redraw stage',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(view.stage.key);
    const res = action === 'draw' ? await drawStage(event.id, view.stage.key) : await redrawStage(event.id, view.stage.key);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(action === 'draw' ? `${view.stage.name} drawn` : `${view.stage.name} redrawn`, 'success');
    const failure = autoCallFailureText(res.data?.autoCall);
    if (failure) toast(failure, 'error');
    router.refresh();
  }

  async function placeLate(view: StageView, entryId: string, message: string) {
    const ok = await confirm({
      title: `Place ${nameMap[entryId] ?? 'this entry'} in a group?`,
      message,
      confirmLabel: 'Place in a group',
    });
    if (!ok) return;
    setBusy(`${view.stage.key}:late:${entryId}`);
    const res = await placeLateEntrant(event.id, view.stage.key, entryId);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(`${nameMap[entryId] ?? 'Entry'} placed, with ${res.data.matches} match${res.data.matches === 1 ? '' : 'es'} added`, 'success');
    router.refresh();
  }

  async function addRound(view: StageView) {
    const ok = await confirm({
      title: `Add a round to ${view.stage.name}?`,
      message: 'Every group plays one more round. In a group with an odd number of teams, the team with the most games sits out.',
      confirmLabel: 'Add a round',
    });
    if (!ok) return;
    setBusy(`${view.stage.key}:round`);
    const res = await addStageRound(event.id, view.stage.key);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    const { matches: added, repeats } = res.data;
    toast(
      repeats > 0
        ? `${added} match${added === 1 ? '' : 'es'} added to ${view.stage.name}, ${repeats} of them ${repeats === 1 ? 'a rematch' : 'rematches'}`
        : `${added} match${added === 1 ? '' : 'es'} added to ${view.stage.name}`,
      'success',
    );
    router.refresh();
  }

  const courtCard = (court: TournamentCourt, groupName: string | null = null) => (
    <CourtCard
      key={court.id}
      court={court}
      groupName={groupName}
      rows={rows}
      courts={courts ?? []}
      cfg={cfg}
      isLive={isLive}
      canEnterResult={canEnterResult}
      canManageCourts={canManageCourts}
      busyElsewhere={courtsInUse.has(court.id) && !rows.some((r) => r.state === 'live' && r.match.court_id === court.id)}
      onMore={setScoreMatchId}
    />
  );

  const matchRow = (view: StageView, m: TournamentMatchRow) => (
    <StageMatchRow
      key={m.id}
      match={m}
      view={view}
      heading={stagedMatchHeading(cfg, m)}
      nameMap={nameMap}
      isDoubles={isDoubles}
      isLive={isLive}
      onOpen={() => setScoreMatchId(m.id)}
    />
  );

  return (
    <>
      <div className="space-y-6">
        {views.map((view) => {
          const own = matches.filter((m) => m.stage === view.number);
          const control = stageDrawControl(
            { number: view.number, name: view.stage.name, drawn: view.drawn, ready: view.ready, waitingOn: view.waitingOn },
            {
              status,
              drawLocked: event.draw_locked === true,
              canGenerate,
              laterDrawn: matches.some((m) => m.stage != null && m.stage > view.number),
              rows: own,
            },
          );
          const extend = stageExtendControl(
            { kind: view.stage.kind, drawn: view.drawn },
            {
              status,
              drawLocked: event.draw_locked === true,
              canGenerate,
              laterDrawn: matches.some((m) => m.stage != null && m.stage > view.number),
            },
          );
          const hintId = `stage-${view.number}-draw-hint`;
          const extendHintId = `stage-${view.number}-extend-hint`;
          return (
            <section
              key={view.stage.key}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 space-y-4"
              aria-label={`Stage ${view.number}: ${view.stage.name}`}
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                    <Layers className="w-4 h-4 text-[var(--color-accent)]" aria-hidden />
                    Stage {view.number}: {view.stage.name}
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="default">{KIND_LABELS[view.stage.kind]}</Badge>
                    <Badge variant="default">{describeStageScoring(view.stage.scoring)}</Badge>
                    <Badge variant="default">{view.stage.rated && event.rated !== false ? 'Rated' : 'Unrated'}</Badge>
                    <Badge variant="default">
                      {view.complete ? 'Complete' : view.drawn ? 'Drawn' : view.ready ? 'Ready to draw' : 'Not drawn'}
                    </Badge>
                  </div>
                </div>
                {status !== 'completed' && (
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex flex-wrap justify-end gap-2">
                      {extend && (
                        <Button
                          variant="ghost"
                          loading={busy === `${view.stage.key}:round`}
                          disabled={extend.blockedReason !== null || (busy !== null && busy !== `${view.stage.key}:round`)}
                          aria-describedby={extend.blockedReason ? (extend.blockedReason === control.blockedReason ? hintId : extendHintId) : undefined}
                          onClick={() => addRound(view)}
                          className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                        >
                          <Plus className="w-4 h-4 mr-1" />
                          Add a round
                        </Button>
                      )}
                      <Button
                        variant={control.action === 'draw' ? 'primary' : 'ghost'}
                        loading={busy === view.stage.key}
                        disabled={control.blockedReason !== null || (busy !== null && busy !== view.stage.key)}
                        aria-describedby={control.blockedReason ? hintId : undefined}
                        onClick={() => press(view, control.action)}
                        className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                      >
                        {control.action === 'redraw' && <RefreshCw className="w-4 h-4 mr-1" />}
                        {control.action === 'draw' ? `Draw ${view.stage.name}` : 'Redraw'}
                      </Button>
                    </div>
                    {extend?.blockedReason && extend.blockedReason !== control.blockedReason && (
                      <p id={extendHintId} className="text-xs text-[var(--text-muted)] max-w-[15rem] text-right">
                        {extend.blockedReason}
                      </p>
                    )}
                    {control.blockedReason && (
                      <p id={hintId} className="text-xs text-[var(--text-muted)] max-w-[15rem] text-right">
                        {control.blockedReason}
                      </p>
                    )}
                    {control.action === 'draw' && view.stage.scoring.handicap && categoryWarning && (
                      <p role="status" className="text-xs text-[var(--color-warning)] max-w-[15rem] text-right">
                        {categoryWarning}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {view.number === 1 && view.stage.kind === 'groups' && lateEntries.length > 0 && (
                <div
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-2"
                  role="region"
                  aria-label="Entries not in a group yet"
                >
                  <p className="text-sm font-semibold text-[var(--text-primary)]">Not in a group yet</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    Entered after the draw. Placing one adds only their matches; nothing already drawn moves.
                  </p>
                  <ul className="space-y-1.5">
                    {lateEntries.map(({ id, plan }) => {
                      const groupLabel = stageGroupLabel(view.stage as GroupsStage, plan.pool, plan.group);
                      const message = lateEntrantConfirmMessage(plan, groupLabel, plan.opponents.map((o) => nameMap[o] ?? 'Unknown'));
                      const key = `${view.stage.key}:late:${id}`;
                      return (
                        <li key={id} className="flex items-center justify-between gap-3">
                          <span className="text-sm text-[var(--text-primary)] truncate">{nameMap[id] ?? 'Unknown'}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busy === key}
                            disabled={busy !== null && busy !== key}
                            onClick={() => placeLate(view, id, message)}
                            className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                          >
                            Place in a group
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {!view.drawn && view.stage.entrants.from === 'slots' && (
                <p className="text-xs text-[var(--text-muted)]">
                  Takes: {view.stage.entrants.slots.map((s, i) => slotRefLabel(s, cfg, i)).join(', ')}
                </p>
              )}

              {view.stage.kind === 'groups' && view.drawn ? (
                <GroupColumns
                  view={view}
                  stage={view.stage}
                  cfg={cfg}
                  own={own}
                  courts={courts}
                  activeCourts={activeCourts}
                  isDoubles={isDoubles}
                  nameMap={nameMap}
                  courtCard={courtCard}
                  matchRow={(m) => matchRow(view, m)}
                />
              ) : (
                view.pools.map((pool) => (
                  <div key={pool.pool} className="space-y-2">
                    {pool.label && (
                      <h4 className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">{pool.label}</h4>
                    )}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      {pool.groups.map((g) => (
                        <GroupTable key={`${g.pool}-${g.group}`} group={g} isDoubles={isDoubles} nameMap={nameMap} />
                      ))}
                    </div>
                  </div>
                ))
              )}

              {view.stage.kind === 'matches' && !view.drawn && view.fixtures.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {view.fixtures.map((f) => (
                    <div key={f.label} className="p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
                        {f.name}{f.winnerPlace != null ? ` · for place ${f.winnerPlace}` : ''}
                      </p>
                      <p className="text-sm text-[var(--text-primary)]">
                        {f.a.entry ? nameMap[f.a.entry] ?? f.a.slot : f.a.slot}
                        <span className="text-xs text-[var(--text-muted)]"> vs </span>
                        {f.b.entry ? nameMap[f.b.entry] ?? f.b.slot : f.b.slot}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {view.stage.kind === 'knockout' && view.drawn && !view.complete && (() => {
                const listed = courts ? allowedTournamentCourts(courts, view.stage.courts ?? null) ?? activeCourts : [];
                const shown = listed.filter((c) => c.active && (
                  !courtsInUse.has(c.id)
                  || rows.some((r) => r.state === 'live' && r.match.court_id === c.id && r.match.stage === view.number)
                ));
                return shown.length > 0 && <div className={COURT_GRID} style={COURT_GRID_STYLE}>{shown.map((c) => courtCard(c))}</div>;
              })()}

              {own.length > 0 && !(view.stage.kind === 'groups' && view.drawn) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {bySlot(own).map((m) => matchRow(view, m))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {scoreMatch && (
        <ScoreEntryDialog
          match={scoreMatch}
          event={event}
          nameMap={nameMap}
          seedMap={seedMap}
          isDoubles={isDoubles}
          entries={placeableEntries}
          onClose={() => setScoreMatchId(null)}
        />
      )}
    </>
  );
}

// Columns side by side while they fit, one under the other on a phone.
const COURT_GRID = 'grid gap-4';
const COURT_GRID_STYLE = { gridTemplateColumns: 'repeat(auto-fit, minmax(min(20rem, 100%), 1fr))' };

const bySlot = (ms: TournamentMatchRow[]) =>
  [...ms].sort((x, y) => (x.slot ?? x.round_number) - (y.slot ?? y.round_number) || (x.match_number ?? 0) - (y.match_number ?? 0));

const isDecided = (m: TournamentMatchRow) => m.status === 'completed' || m.status === 'walkover';

/**
 * A DRAWN GROUPS STAGE, ONE COLUMN PER GROUP (one per pool when there are
 * several pools), each with its courts while the stage is played, then its
 * table, then its matches folded away. A pool's own courts sit in its column;
 * shared courts sit in one row above all the columns.
 */
function GroupColumns({
  view, stage, cfg, own, courts, activeCourts, isDoubles, nameMap, courtCard, matchRow,
}: {
  view: StageView;
  stage: GroupsStage;
  cfg: FormatConfig;
  own: TournamentMatchRow[];
  courts: TournamentCourt[] | null;
  activeCourts: TournamentCourt[];
  isDoubles: boolean;
  nameMap: Record<string, string>;
  courtCard: (court: TournamentCourt, groupName?: string | null) => React.ReactNode;
  matchRow: (m: TournamentMatchRow) => React.ReactNode;
}) {
  const columns: Array<{ key: string; title: string; pool: number; group: number | null; groups: StageViewGroup[] }> =
    stage.pools > 1
      ? view.pools.map((p) => ({ key: `p${p.pool}`, title: p.label || (p.groups[0]?.label ?? ''), pool: p.pool, group: null, groups: p.groups }))
      : (view.pools[0]?.groups ?? []).map((g) => ({ key: `g${g.group}`, title: g.label, pool: g.pool, group: g.group, groups: [g] }));
  const playing = !view.complete && !!courts && activeCourts.length > 0;
  const perColumn = playing && stage.courts?.mode === 'per_pool' && stage.pools > 1;
  const shared = playing && !perColumn
    ? (allowedTournamentCourts(courts!, stageCourtLabels(cfg, { stage: view.number, pool_number: 1 })) ?? activeCourts)
    : [];

  return (
    <div className="space-y-4">
      {shared.length > 0 && <div className={COURT_GRID} style={COURT_GRID_STYLE}>{shared.map((c) => courtCard(c))}</div>}
      <div className={COURT_GRID} style={COURT_GRID_STYLE}>
        {columns.map((col) => {
          const colCourts = perColumn && stage.courts?.mode === 'per_pool'
            ? allowedTournamentCourts(courts!, stage.courts.pools[col.pool - 1] ?? null) ?? []
            : [];
          const colMatches = own.filter((m) => m.pool_number === col.pool && (col.group == null || m.group_number === col.group));
          const played = colMatches.filter(isDecided);
          const toPlay = colMatches.filter((m) => !isDecided(m));
          return (
            <div key={col.key} className="min-w-0 space-y-3" role="region" aria-label={col.title || `Pool ${col.pool}`}>
              {col.groups.length > 1 && col.title && (
                <h4 className="text-sm font-bold text-[var(--text-primary)]">{col.title}</h4>
              )}
              {colCourts.map((c) => courtCard(c, col.title || null))}
              {col.groups.map((g) => (
                <GroupTable key={`${g.pool}-${g.group}`} group={g} isDoubles={isDoubles} nameMap={nameMap} />
              ))}
              {colMatches.length > 0 && (
                <details className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]">
                  <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-medium text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none rounded-lg">
                    Matches: {toPlay.length} to play, {played.length} played
                  </summary>
                  <div className="p-2 space-y-2">
                    {[...bySlot(toPlay), ...bySlot(played)].map(matchRow)}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GroupTable({ group: g, isDoubles, nameMap }: { group: StageViewGroup; isDoubles: boolean; nameMap: Record<string, string> }) {
  return (
    <div
      className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden"
      role="region"
      aria-label={`${g.label} standings`}
    >
      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-sm font-semibold text-[var(--text-primary)]">{g.label}</span>
        {g.complete && <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Played out</span>}
      </div>
      <table className="w-full" aria-label={`${g.label} standings table`}>
        <thead>
          <tr className="border-b border-[var(--border)]">
            <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-1.5 w-8">#</th>
            <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase px-3 py-1.5">{isDoubles ? 'Pair' : 'Player'}</th>
            <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-2 py-1.5 w-10">W</th>
            <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-2 py-1.5 w-10">L</th>
            <th className="text-center text-xs font-medium text-[var(--text-muted)] uppercase px-2 py-1.5 w-12">+/-</th>
          </tr>
        </thead>
        <tbody>
          {g.rows.map((r) => {
            const diff = r.pointsFor - r.pointsAgainst;
            return (
              <tr
                key={r.id}
                className="border-b last:border-b-0 border-[var(--border)]"
                style={r.qualified
                  ? { backgroundColor: 'color-mix(in oklab, var(--color-success) 10%, transparent)' }
                  : undefined}
              >
                <td className={`px-3 py-1.5 text-sm font-mono ${r.advancingPlace ? 'text-[var(--color-accent)] font-semibold' : 'text-[var(--text-muted)]'}`}>{r.place}</td>
                <td className="px-3 py-1.5 text-sm font-medium text-[var(--text-primary)]">
                  {nameMap[r.id] ?? 'Unknown'}
                  {r.qualified && <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-success)]">Through</span>}
                </td>
                <td className="px-2 py-1.5 text-sm text-center font-mono text-[var(--color-success)]">{r.wins}</td>
                <td className="px-2 py-1.5 text-sm text-center font-mono text-[var(--color-danger)]">{r.losses}</td>
                <td className={`px-2 py-1.5 text-sm text-center font-mono ${diff > 0 ? 'text-[var(--color-success)]' : diff < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'}`}>
                  {diff > 0 ? '+' : ''}{diff}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StageMatchRow({
  match: m,
  view,
  heading,
  nameMap,
  isDoubles,
  isLive,
  onOpen,
}: {
  match: TournamentMatchRow;
  view: StageView;
  heading: string | null;
  nameMap: Record<string, string>;
  isDoubles: boolean;
  isLive: boolean;
  onOpen: () => void;
}) {
  const { a: aId, b: bId, winner: winnerId } = matchSides(m, isDoubles);
  const isCompleted = m.status === 'completed' || m.status === 'walkover';
  const isVoided = m.status === 'voided';
  const canScore = isLive && aId && bId && !isCompleted && !isVoided;
  const canRestore = isLive && isVoided;
  const canChangeResult = isCompleted && !m.is_bye;
  const fixture = m.match_label ? view.fixtures.find((f) => f.label === m.match_label) : undefined;
  const side = (id: string | null, slot: string | undefined, start: number) => (
    <span className={`text-sm truncate ${isCompleted && winnerId === id ? 'text-[var(--color-success)] font-semibold' : 'text-[var(--text-primary)]'}`}>
      {id ? nameMap[id] ?? 'Unknown' : slot ?? 'TBD'}
      {start > 0 && <span className="ml-1 text-[10px] text-[var(--text-muted)]">(starts at {start})</span>}
      {isCompleted && winnerId === id && <span className="sr-only"> (Winner)</span>}
    </span>
  );
  return (
    <div className="flex items-center justify-between p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
          {m.match_number != null ? `M${m.match_number} · ` : ''}{heading}
        </p>
        <div className="flex items-center gap-2 min-w-0">
          {side(aId, fixture?.a.slot, m.handicap_a)}
          <span className="text-xs text-[var(--text-muted)]">vs</span>
          {side(bId, fixture?.b.slot, m.handicap_b)}
        </div>
      </div>
      {isCompleted && Array.isArray(m.scores) && (
        <span className="text-sm font-mono text-[var(--text-muted)] ml-2">
          {(m.scores as GameScore[]).map((g) => `${g.a}-${g.b}`).join(', ')}
        </span>
      )}
      {canScore && (
        <button
          onClick={onOpen}
          aria-label={`Enter score for match ${m.match_number ?? ''}`}
          className="text-xs text-[var(--color-accent)] font-medium ml-2 hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none rounded"
        >
          Score
        </button>
      )}
      {canRestore && (
        <button
          onClick={onOpen}
          aria-label={`Restore voided match ${m.match_number ?? ''}`}
          className="text-xs text-[var(--color-warning)] font-medium ml-2 hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-warning)] focus-visible:outline-none rounded"
        >
          Restore
        </button>
      )}
      {canChangeResult && (
        <button
          onClick={onOpen}
          aria-label={`Change the recorded result for match ${m.match_number ?? ''}`}
          className="text-xs text-[var(--text-muted)] font-medium ml-2 hover:underline hover:text-[var(--color-warning)] focus-visible:ring-2 focus-visible:ring-[var(--color-warning)] focus-visible:outline-none rounded"
        >
          Change
        </button>
      )}
    </div>
  );
}
