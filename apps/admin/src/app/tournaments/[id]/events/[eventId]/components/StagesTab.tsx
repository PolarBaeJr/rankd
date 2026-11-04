'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Dialog, Input, Select, useConfirm } from '@badminton/ui';
import {
  allowedTournamentCourts,
  courtLabel,
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
import {
  addStageRound,
  drawStage,
  placeLateEntrant,
  redrawStage,
  voidCourtHelperMatch,
  voidOpenMatchesForEntry,
  voidUnplayedMatches,
  type BulkVoidResult,
} from '@/lib/tournament-actions';
import { singlesNeedingPartner } from '@/lib/on-the-spot';
import {
  bulkVoidSummary,
  drawField,
  drawLeftOutMessage,
  lateEntrantConfirmMessage,
  lateEntrantGroupOptions,
  lateEntryWindow,
  openMatchesOfEntry,
  splitGroupMatches,
  stageDrawControl,
  stageExtendControl,
  uncategorisedWarning,
  unplacedLateEntries,
  unplayedMatchesIn,
} from '@/lib/stage-controls';
import { absentEntryIds, autoCallFailureText, deskRows } from '@/lib/live-desk';
import type { ActionResult } from '@/lib/action-result';
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
  /** Holds the void key; otherwise Void shows only on a court in helperCourtIds. */
  canVoid?: boolean;
  /** Holds the no-show key: with canVoid, Did not come on a group's table. */
  canMarkNoShow?: boolean;
  helperCourtIds?: string[];
  /** Opens Add on the spot, while the desk may add. */
  onAddOnTheSpot?: () => void;
  /** An entry just added on the spot: its placement opens once it is listed. */
  pendingLateEntryId?: string | null;
  onPendingLateHandled?: () => void;
}

/** What the void dialog is about to do: one entry's open matches, or a stage's or a group's. */
type VoidAsk =
  | { kind: 'entry'; entryId: string; title: string; count: number; live: number }
  | { kind: 'scope'; stage: number; pool: number | null; group: number | null; title: string; count: number; live: number; skipped: number };

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
  canVoid = false, canMarkNoShow = false, helperCourtIds = [],
  onAddOnTheSpot, pendingLateEntryId = null, onPendingLateHandled,
}: Props) {
  const [scoreMatchId, setScoreMatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();
  const [roundsFor, setRoundsFor] = useState<string | null>(null);
  const [roundCount, setRoundCount] = useState('1');
  const [lateFor, setLateFor] = useState<{ view: StageView; entryId: string } | null>(null);
  const [lateGroup, setLateGroup] = useState('');
  const [lateCourt, setLateCourt] = useState('');
  const [voidAsk, setVoidAsk] = useState<VoidAsk | null>(null);
  const [voidReason, setVoidReason] = useState('');
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

  const { views, lateEntries, results, lateOpen } = useMemo(() => {
    if (!cfg) return { views: [], lateEntries: [], results: null, lateOpen: false };
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
      results,
      lateOpen: !!open,
    };
  }, [cfg, entries, matches, isDoubles, canGenerate, event]);
  // A doubles event's late singles, added on the spot: a group takes a team.
  const needPartner = useMemo(
    () => (isDoubles && lateOpen ? singlesNeedingPartner(participants, pairs) : []),
    [isDoubles, lateOpen, participants, pairs],
  );
  // Once check-in is in use, the ones still only registered (drawField).
  const notCheckedIn = useMemo(() => new Set(drawField(entries).leftOut.map((e) => e.id)), [entries]);
  const sidedMatches = useMemo(
    () => matches.map((m) => { const { a, b } = matchSides(m, isDoubles); return { ...m, a, b }; }),
    [matches, isDoubles],
  );
  const canBulkVoid = isLive && canVoid;
  const roundsView = roundsFor ? views.find((v) => v.stage.key === roundsFor) ?? null : null;
  const roundCountValid = /^\d+$/.test(roundCount.trim()) && Number(roundCount) >= 1 && Number(roundCount) <= 10;

  const rows = useMemo<CourtDeskRow[]>(() => {
    // The same absentees the server's auto-call skips, so Next up agrees with it.
    const absent = absentEntryIds(entries);
    const sideOf = (entryId: string | null) =>
      entryId && nameMap[entryId] !== undefined
        ? { entryId, label: nameMap[entryId]!, absent: absent.has(entryId) }
        : { entryId: null, label: 'TBD' };
    return deskRows(matches, sideOf, isDoubles);
  }, [matches, nameMap, isDoubles, entries]);
  const courtsInUse = useMemo(() => new Set(busyCourtIds), [busyCourtIds]);
  const activeCourts = useMemo(() => (courts ?? []).filter((c) => c.active), [courts]);

  const categoryWarning = useMemo(() => (isDoubles ? uncategorisedWarning(pairs) : null), [isDoubles, pairs]);

  const scoreMatch = scoreMatchId ? matches.find((m) => m.id === scoreMatchId) ?? null : null;

  // Straight on from Add on the spot to placing them, once the refresh lists them.
  useEffect(() => {
    if (!pendingLateEntryId) return;
    const late = lateEntries.find((l) => l.id === pendingLateEntryId);
    const first = views.find((v) => v.number === 1);
    if (!late || !first) return;
    openLate(first, late.id, late.plan.pool, late.plan.group);
    onPendingLateHandled?.();
  }, [pendingLateEntryId, lateEntries, views, onPendingLateHandled]);

  if (!cfg) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center text-sm text-[var(--text-muted)]">
        This event&rsquo;s stages are not set out correctly. Fix them in Event Settings.
      </div>
    );
  }

  async function press(view: StageView, action: 'draw' | 'redraw') {
    // A redraw of stage 1 takes the field by the same rule, so it says who it drops too.
    const leftOut = view.number === 1 && view.stage.entrants.from === 'field'
      ? drawLeftOutMessage([...notCheckedIn].map((id) => nameMap[id] ?? 'Unknown'))
      : null;
    if (action === 'draw' && leftOut) {
      const ok = await confirm({
        title: `Draw ${view.stage.name} without them?`,
        message: leftOut,
        confirmLabel: 'Draw who is here',
      });
      if (!ok) return;
    }
    if (action === 'redraw') {
      const ok = await confirm({
        title: `Redraw ${view.stage.name}?`,
        message: `Every match in ${view.stage.name} is deleted and drawn again. Match numbers, courts and who plays whom can all change.${leftOut ? ` ${leftOut}` : ''}`,
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

  function openLate(view: StageView, entryId: string, pool: number, group: number) {
    setLateFor({ view, entryId });
    setLateGroup(`${pool}:${group}`);
    setLateCourt('');
  }

  async function placeLate(view: StageView, entryId: string, pool: number, group: number) {
    setLateFor(null);
    setBusy(`${view.stage.key}:late:${entryId}`);
    const res = await placeLateEntrant(event.id, view.stage.key, entryId, { pool, group, courtId: lateCourt || null });
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    toast(`${nameMap[entryId] ?? 'Entry'} placed, with ${res.data.matches} match${res.data.matches === 1 ? '' : 'es'} added`, 'success');
    router.refresh();
  }

  function askVoidEntry(entryId: string) {
    const { open, live } = openMatchesOfEntry(sidedMatches, entryId);
    setVoidReason('');
    setVoidAsk({ kind: 'entry', entryId, title: `${nameMap[entryId] ?? 'This entry'} did not come?`, count: open.length, live });
  }

  function askVoidScope(stage: number, pool: number | null, group: number | null, label: string) {
    const { open, live, skipped } = unplayedMatchesIn(sidedMatches, { stage, pool, group });
    setVoidReason('');
    setVoidAsk({ kind: 'scope', stage, pool, group, title: `Void the unplayed matches of ${label}?`, count: open.length, live, skipped });
  }

  async function runVoid(ask: VoidAsk) {
    const reason = voidReason.trim();
    if (!reason) return;
    setVoidAsk(null);
    setBusy('void');
    const res: ActionResult<BulkVoidResult> = ask.kind === 'entry'
      ? await voidOpenMatchesForEntry(event.id, ask.entryId, reason)
      : await voidUnplayedMatches(event.id, ask.stage, ask.pool, ask.group, reason);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); return; }
    const { text, ok } = bulkVoidSummary(res.data);
    toast(ask.kind === 'entry' ? `Marked as a no-show. ${text}` : text, ok ? 'success' : 'error');
    router.refresh();
  }

  // Rounds go in one at a time, each planned after the last, so no round repeats
  // a pairing the one before it already used.
  async function addRounds(view: StageView, count: number) {
    setRoundsFor(null);
    setBusy(`${view.stage.key}:round`);
    let added = 0;
    let repeats = 0;
    let done = 0;
    let failure: string | null = null;
    for (; done < count; done++) {
      const res = await addStageRound(event.id, view.stage.key);
      if (!res.ok) { failure = res.error; break; }
      added += res.data.matches;
      repeats += res.data.repeats;
    }
    setBusy(null);
    if (done > 0) {
      const rounds = done === 1 ? 'a round' : `${done} rounds`;
      toast(
        repeats > 0
          ? `${rounds} added to ${view.stage.name}: ${added} match${added === 1 ? '' : 'es'}, ${repeats} of them ${repeats === 1 ? 'a rematch' : 'rematches'}`
          : `${rounds} added to ${view.stage.name}: ${added} match${added === 1 ? '' : 'es'}`,
        'success',
      );
    }
    if (failure) toast(done > 0 ? `Stopped after ${done}: ${failure}` : failure, 'error');
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
      voidMatch={canVoid || helperCourtIds.includes(court.id) ? voidCourtHelperMatch : undefined}
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
                      {onAddOnTheSpot && view.number === 1 && view.drawn && (
                        <Button
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={onAddOnTheSpot}
                          className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                        >
                          <Plus className="w-4 h-4 mr-1" aria-hidden />
                          Add on the spot
                        </Button>
                      )}
                      {canBulkVoid && view.drawn && !view.complete && unplayedMatchesIn(sidedMatches, { stage: view.number }).open.length > 0 && (
                        <Button
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => askVoidScope(view.number, null, null, view.stage.name)}
                          className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                        >
                          Void unplayed
                        </Button>
                      )}
                      {extend && (
                        <Button
                          variant="ghost"
                          loading={busy === `${view.stage.key}:round`}
                          disabled={extend.blockedReason !== null || (busy !== null && busy !== `${view.stage.key}:round`)}
                          aria-describedby={extend.blockedReason ? (extend.blockedReason === control.blockedReason ? hintId : extendHintId) : undefined}
                          onClick={() => { setRoundsFor(view.stage.key); setRoundCount('1'); }}
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

              {view.number === 1 && view.stage.kind === 'groups' && needPartner.length > 0 && (
                <div
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-2"
                  role="region"
                  aria-label="Players without a partner"
                >
                  <p className="text-sm font-semibold text-[var(--text-primary)]">Without a partner</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    Pair them on the Participants tab; the team then appears below to place in a group.
                  </p>
                  <ul className="space-y-1.5">
                    {needPartner.map((p) => (
                      <li key={p.id} className="text-sm text-[var(--text-primary)] truncate">
                        {getName(p, false)}
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-warning)]">Needs a partner</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {view.number === 1 && view.stage.kind === 'groups' && lateEntries.length > 0 && (
                <div
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-2"
                  role="region"
                  aria-label="Entries not in a group yet"
                >
                  <p className="text-sm font-semibold text-[var(--text-primary)]">Not in a group yet</p>
                  <p className="text-xs text-[var(--text-muted)]">
                    Entered or checked in after the draw. Placing one adds only their matches; nothing already drawn moves.
                  </p>
                  <ul className="space-y-1.5">
                    {lateEntries.map(({ id, plan }) => {
                      const key = `${view.stage.key}:late:${id}`;
                      return (
                        <li key={id} className="flex items-center justify-between gap-3">
                          <span className="text-sm text-[var(--text-primary)] truncate">
                            {nameMap[id] ?? 'Unknown'}
                            {notCheckedIn.has(id) && (
                              <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--color-warning)]">Not checked in</span>
                            )}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busy === key}
                            disabled={busy !== null && busy !== key}
                            onClick={() => openLate(view, id, plan.pool, plan.group)}
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
                  onVoidGroup={canBulkVoid && busy === null
                    ? (pool, group, label) => askVoidScope(view.number, pool, group, label)
                    : undefined}
                  onAbsent={canBulkVoid && canMarkNoShow && busy === null ? askVoidEntry : undefined}
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

      {roundsView && (
        <Dialog open onClose={() => setRoundsFor(null)} title={`Add rounds to ${roundsView.stage.name}`}>
          <form
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (roundCountValid) void addRounds(roundsView, Number(roundCount)); }}
          >
            <p className="text-sm text-[var(--text-muted)]">
              Every group plays this many more rounds. In a group with an odd number of teams, the team with the most games sits out.
            </p>
            <Input
              label="How many rounds"
              type="number"
              min={1}
              max={10}
              value={roundCount}
              onChange={(e) => setRoundCount(e.target.value)}
              autoFocus
            />
            <div className="flex justify-between gap-2">
              <Button type="button" variant="ghost" onClick={() => setRoundsFor(null)}>Cancel</Button>
              <Button type="submit" disabled={!roundCountValid}>
                {roundCountValid && Number(roundCount) > 1 ? `Add ${roundCount} rounds` : 'Add a round'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      {lateFor && results && lateFor.view.stage.kind === 'groups' && (() => {
        const { view, entryId } = lateFor;
        const stage = view.stage as GroupsStage;
        const options = lateEntrantGroupOptions(stage, results, entries, entryId);
        const plan = options.find((o) => `${o.pool}:${o.group}` === lateGroup) ?? options[0];
        const name = nameMap[entryId] ?? 'this entry';
        const groupLabel = plan ? stageGroupLabel(stage, plan.pool, plan.group) : '';
        const courtChoices = plan && courts
          ? (allowedTournamentCourts(courts, stageCourtLabels(cfg, { stage: view.number, pool_number: plan.pool })) ?? activeCourts)
            .filter((c) => c.active)
          : [];
        return (
          <Dialog open onClose={() => setLateFor(null)} title={`Place ${name} in a group`}>
            <form
              className="space-y-4"
              onSubmit={(e) => { e.preventDefault(); if (plan) void placeLate(view, entryId, plan.pool, plan.group); }}
            >
              {notCheckedIn.has(entryId) && (
                <p className="text-sm text-[var(--color-warning)]" role="status">
                  {name} has not checked in, so no court will call their matches until they do.
                </p>
              )}
              {options.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">There is no group to put them in. Reload the page.</p>
              ) : (
                <>
                  <Select
                    label="Group"
                    value={plan ? `${plan.pool}:${plan.group}` : ''}
                    options={options.map((o, i) => ({
                      value: `${o.pool}:${o.group}`,
                      label: stageGroupLabel(stage, o.pool, o.group),
                      badge: i === 0 ? 'Suggested' : undefined,
                    }))}
                    onValueChange={(v) => { setLateGroup(v); setLateCourt(''); }}
                  />
                  {courtChoices.length > 0 && (
                    <Select
                      label="Court"
                      value={lateCourt}
                      options={[
                        { value: '', label: 'Wherever the stage puts them' },
                        ...courtChoices.map((c) => ({ value: c.id, label: courtLabel(c.label) ?? c.label })),
                      ]}
                      onValueChange={setLateCourt}
                    />
                  )}
                  {plan && (
                    <p className="text-sm text-[var(--text-muted)]">
                      {lateEntrantConfirmMessage(plan, groupLabel, plan.opponents.map((o) => nameMap[o] ?? 'Unknown'))}
                    </p>
                  )}
                </>
              )}
              <div className="flex justify-between gap-2">
                <Button type="button" variant="ghost" onClick={() => setLateFor(null)}>Cancel</Button>
                <Button type="submit" disabled={!plan}>Place in {groupLabel || 'a group'}</Button>
              </div>
            </form>
          </Dialog>
        );
      })()}

      {voidAsk && (
        <Dialog open onClose={() => setVoidAsk(null)} title={voidAsk.title}>
          <form
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); void runVoid(voidAsk); }}
          >
            <p className="text-sm text-[var(--text-muted)]">
              {voidAsk.kind === 'entry'
                ? `They are marked as a no-show and ${voidAsk.count === 1 ? 'their 1 unplayed match is' : `their ${voidAsk.count} unplayed matches are`} voided. A voided match counts for neither side.`
                : `${voidAsk.count === 1 ? '1 unplayed match is' : `${voidAsk.count} unplayed matches are`} voided. A voided match counts for neither side.`}
              {voidAsk.live > 0 && ` ${voidAsk.live === 1 ? '1 match is' : `${voidAsk.live} matches are`} on court now and left alone: void ${voidAsk.live === 1 ? 'it' : 'them'} from the court.`}
              {voidAsk.kind === 'scope' && voidAsk.skipped > 0 && ` ${voidAsk.skipped === 1 ? '1 match is' : `${voidAsk.skipped} matches are`} still waiting on a side and left alone.`}
            </p>
            <Input
              label="Reason"
              value={voidReason}
              maxLength={500}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder={voidAsk.kind === 'entry' ? 'For example: did not come' : 'For example: out of time'}
              autoFocus
            />
            <div className="flex justify-between gap-2">
              <Button type="button" variant="ghost" onClick={() => setVoidAsk(null)}>Cancel</Button>
              <Button type="submit" variant="danger" disabled={!voidReason.trim()}>
                {voidAsk.kind === 'entry' ? 'Mark no-show and void' : `Void ${voidAsk.count} match${voidAsk.count === 1 ? '' : 'es'}`}
              </Button>
            </div>
          </form>
        </Dialog>
      )}

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

/**
 * A DRAWN GROUPS STAGE, ONE COLUMN PER GROUP (one per pool when there are
 * several pools), each with its courts while the stage is played, then its
 * table, then its matches folded away. A pool's own courts sit in its column;
 * shared courts sit in one row above all the columns.
 */
function GroupColumns({
  view, stage, cfg, own, courts, activeCourts, isDoubles, nameMap, courtCard, matchRow, onVoidGroup, onAbsent,
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
  /** Void unplayed on each group's table, while the desk may void. */
  onVoidGroup?: (pool: number, group: number, label: string) => void;
  /** Did not come on each row with a match still to play. */
  onAbsent?: (entryId: string) => void;
}) {
  const sided = own.map((m) => ({ ...m, ...matchSides(m, isDoubles) }));
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
      <div className={`${COURT_GRID} items-start`} style={COURT_GRID_STYLE}>
        {columns.map((col) => {
          const colCourts = perColumn && stage.courts?.mode === 'per_pool'
            ? allowedTournamentCourts(courts!, stage.courts.pools[col.pool - 1] ?? null) ?? []
            : [];
          const colMatches = own.filter((m) => m.pool_number === col.pool && (col.group == null || m.group_number === col.group));
          const { toPlay, played, voided, summary } = splitGroupMatches(colMatches);
          return (
            <div key={col.key} className="min-w-0 space-y-3" role="region" aria-label={col.title || `Pool ${col.pool}`}>
              {col.groups.length > 1 && col.title && (
                <h4 className="text-sm font-bold text-[var(--text-primary)]">{col.title}</h4>
              )}
              {colCourts.map((c) => courtCard(c, col.title || null))}
              {col.groups.map((g) => {
                const groupMatches = sided.filter((m) => m.pool_number === g.pool && m.group_number === g.group);
                const unplayed = unplayedMatchesIn(groupMatches, { stage: view.number }).open.length;
                return (
                  <GroupTable
                    key={`${g.pool}-${g.group}`}
                    group={g}
                    isDoubles={isDoubles}
                    nameMap={nameMap}
                    onVoidUnplayed={onVoidGroup && unplayed > 0 ? () => onVoidGroup(g.pool, g.group, g.label) : undefined}
                    onAbsent={onAbsent}
                    hasOpen={(id) => openMatchesOfEntry(groupMatches, id).open.length > 0}
                  />
                );
              })}
              {colMatches.length > 0 && (
                <details className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]">
                  <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-medium text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none rounded-lg">
                    Matches: {summary}
                  </summary>
                  {/* Capped only while columns sit side by side, so one open
                      list does not stretch its row; a phone has one column. */}
                  <div className="p-2 space-y-2 sm:max-h-80 sm:overflow-y-auto overscroll-contain">
                    {[...bySlot(toPlay), ...bySlot(played), ...bySlot(voided)].map(matchRow)}
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

function GroupTable({
  group: g, isDoubles, nameMap, onVoidUnplayed, onAbsent, hasOpen,
}: {
  group: StageViewGroup;
  isDoubles: boolean;
  nameMap: Record<string, string>;
  onVoidUnplayed?: () => void;
  onAbsent?: (entryId: string) => void;
  hasOpen?: (entryId: string) => boolean;
}) {
  return (
    <div
      className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] overflow-hidden"
      role="region"
      aria-label={`${g.label} standings`}
    >
      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-sm font-semibold text-[var(--text-primary)]">{g.label}</span>
        {g.complete && <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Played out</span>}
        {onVoidUnplayed && (
          <button
            type="button"
            onClick={onVoidUnplayed}
            className="text-xs text-[var(--text-muted)] font-medium hover:underline hover:text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none rounded"
          >
            Void unplayed
          </button>
        )}
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
                  {onAbsent && hasOpen?.(r.id) && (
                    <button
                      type="button"
                      onClick={() => onAbsent(r.id)}
                      aria-label={`${nameMap[r.id] ?? 'This entry'} did not come`}
                      className="ml-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)] hover:underline hover:text-[var(--color-danger)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none rounded"
                    >
                      Did not come
                    </button>
                  )}
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
    <div className={`flex items-center justify-between p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] ${isVoided ? 'opacity-60' : ''}`}>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
          {m.match_number != null ? `M${m.match_number} · ` : ''}{heading}
          {isVoided && <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Voided</span>}
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
