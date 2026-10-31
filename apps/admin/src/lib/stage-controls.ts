// What the Draw / Redraw and Add a round buttons on a stage say, why they are
// greyed, and whether a late entry can still be taken and placed. The server
// (drawStageImpl, publish_stage_draw, addStageRound, staged_late_entry_open)
// decides; this only tells the exec before the click rather than after.

import {
  parseFormatConfig,
  planLateEntrant,
  summariseRedrawBlockers,
  type FormatResults,
  type GroupsStage,
  type LateEntrantPlan,
  type TournamentEventStatus,
} from '@badminton/shared';

export interface StageDrawState {
  /** 1-based. */
  number: number;
  name: string;
  drawn: boolean;
  ready: boolean;
  waitingOn: string[];
}

export interface StageDrawControl {
  action: 'draw' | 'redraw';
  /** null when the button can be pressed. */
  blockedReason: string | null;
}

type BlockerRow = Parameters<typeof summariseRedrawBlockers>[0][number];

export function stageDrawControl(
  stage: StageDrawState,
  ctx: {
    status: TournamentEventStatus;
    drawLocked: boolean;
    canGenerate: boolean;
    /** A stage after this one has matches. */
    laterDrawn: boolean;
    /** This stage's own match rows. */
    rows: readonly BlockerRow[];
  },
): StageDrawControl {
  const action = stage.drawn ? 'redraw' : 'draw';
  const blocked = (blockedReason: string): StageDrawControl => ({ action, blockedReason });
  if (!ctx.canGenerate) return blocked('You do not have permission to draw this event.');
  if (ctx.status === 'completed') return blocked('This event has been finalised.');
  if (ctx.drawLocked) return blocked('The draw is locked. Unlock it first.');
  if (ctx.status === 'registration') return blocked('Open check-in first.');
  if (stage.drawn) {
    if (ctx.laterDrawn) return blocked('A later stage has been drawn from this one.');
    const b = summariseRedrawBlockers([...ctx.rows]);
    if (b.played > 0) return blocked(`${b.played} match${b.played === 1 ? ' has' : 'es have'} a result. Void or undo ${b.played === 1 ? 'it' : 'them'} first.`);
    if (b.rated > 0) return blocked(`${b.rated} match${b.rated === 1 ? ' still carries' : 'es still carry'} an applied rating.`);
    if (b.inProgress > 0) return blocked(`${b.inProgress} match${b.inProgress === 1 ? ' is' : 'es are'} on court right now.`);
    return { action, blockedReason: null };
  }
  if (stage.number > 1 && ctx.status !== 'live') return blocked('Start the event before drawing a later stage.');
  if (!stage.ready) {
    return blocked(stage.waitingOn.length > 0
      ? `Waiting on ${stage.waitingOn.join(' and ')} to finish.`
      : 'An earlier stage has to be drawn and played first.');
  }
  return { action, blockedReason: null };
}

/**
 * The Add a round button on a drawn groups stage, and why it is greyed. null
 * when the stage has no such button: not a groups stage, or not drawn yet. The
 * server (addStageRound) checks the same things again.
 */
export function stageExtendControl(
  stage: { kind: 'groups' | 'knockout' | 'matches'; drawn: boolean },
  ctx: {
    status: TournamentEventStatus;
    drawLocked: boolean;
    canGenerate: boolean;
    laterDrawn: boolean;
  },
): { blockedReason: string | null } | null {
  if (stage.kind !== 'groups' || !stage.drawn || ctx.status === 'completed') return null;
  const blocked = (blockedReason: string) => ({ blockedReason });
  if (!ctx.canGenerate) return blocked('You do not have permission to change this draw.');
  if (ctx.drawLocked) return blocked('The draw is locked. Unlock it first.');
  if (ctx.status !== 'bracket_generated' && ctx.status !== 'live') return blocked('Draw the stage before adding to it.');
  if (ctx.laterDrawn) return blocked('A later stage has been drawn from this one.');
  return { blockedReason: null };
}

/**
 * Can the event still take a late entry: staged_late_entry_open (00308) asked
 * of what the page or action already read. A staged event at bracket_generated
 * or live, not draw locked, whose first stage is groups drawn from the field,
 * with that stage drawn and nothing after it. The database asks again under
 * the field lock; this only decides whether the console offers it.
 */
export function lateEntryWindow(
  event: { format: string | null; status: string; draw_locked: boolean | null; format_config: unknown },
  matchStages: ReadonlyArray<number | null | undefined>,
): boolean {
  if (event.format !== 'staged' || event.draw_locked === true) return false;
  if (event.status !== 'bracket_generated' && event.status !== 'live') return false;
  const first = parseFormatConfig(event.format_config)?.stages[0];
  if (first?.kind !== 'groups' || first.entrants.from !== 'field') return false;
  return matchStages.some((s) => s === 1) && !matchStages.some((s) => s != null && s > 1);
}

/**
 * The entries still in the event that are in no group of the first stage, each
 * with where planLateEntrant would put it. Entries that are not registered or
 * checked in are left out: the server places only those.
 */
export function unplacedLateEntries(
  stage: GroupsStage,
  results: FormatResults,
  entries: ReadonlyArray<{ id: string; status: string }>,
): Array<{ id: string; plan: LateEntrantPlan }> {
  const active = new Set(entries.filter((e) => e.status === 'registered' || e.status === 'checked_in').map((e) => e.id));
  const out: Array<{ id: string; plan: LateEntrantPlan }> = [];
  for (const e of entries) {
    if (!active.has(e.id)) continue;
    const plan = planLateEntrant(stage, results, active, e.id);
    if (plan) out.push({ id: e.id, plan });
  }
  return out;
}

/** What the confirm says before a late entrant is placed. */
export function lateEntrantConfirmMessage(
  plan: Pick<LateEntrantPlan, 'level' | 'anyOddGroup'>,
  groupLabel: string,
  opponentNames: readonly string[],
): string {
  const names = opponentNames.length <= 1
    ? opponentNames.join('')
    : `${opponentNames.slice(0, -1).join(', ')} and ${opponentNames[opponentNames.length - 1]}`;
  const joins = `Joins ${groupLabel} and plays ${names}.`;
  if (plan.level) return `${joins} Everyone ends level.`;
  if (!plan.anyOddGroup) return `${joins} No group has an odd number of teams, so ${groupLabel} will be uneven.`;
  return `${joins} No group can take them and end level, so ${groupLabel} will be uneven.`;
}

/**
 * The warning beside Draw on a stage that plays with head starts: teams still
 * in the event with no category start every game on 0. It warns, it does not
 * block: an organiser may mean it.
 */
export function uncategorisedWarning(
  pairs: ReadonlyArray<{ status: string; team_category?: string | null }>,
): string | null {
  const n = pairs.filter((p) => p.status !== 'withdrawn' && p.status !== 'disqualified' && p.team_category == null).length;
  if (n === 0) return null;
  return n === 1
    ? '1 team has no category, so it gets no head start. Set it in Participants.'
    : `${n} teams have no category, so they get no head start. Set it in Participants.`;
}
