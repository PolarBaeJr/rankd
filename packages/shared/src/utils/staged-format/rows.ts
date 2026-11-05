// Stored rows to the shape the staged functions read. One builder for the
// draw, the finaliser and both apps' screens, so they rank the same play.

import { isOutOfEvent } from '../tournament-withdrawal';
import type { FormatConfig } from './schema';
import type { FormatResults, StageGroupResult, StageMatchResult } from './standings';

/** An entry as the staged functions need it. */
export interface StagedEntryRow {
  id: string;
  seed: number | null;
  status: string;
}

/** A staged match with its sides already read off the pair or participant columns. */
export interface StagedMatchRow {
  stage: number | null;
  status: string;
  pool_number: number | null;
  group_number: number | null;
  round_number: number;
  match_label: string | null;
  is_third_place: boolean | null;
  a: string | null;
  b: string | null;
  winner: string | null;
  scores: unknown;
}

/** The columns a raw tournament_matches row carries for its sides. */
export interface MatchSideColumns {
  participant_a_id?: string | null;
  participant_b_id?: string | null;
  pair_a_id?: string | null;
  pair_b_id?: string | null;
  winner_participant_id?: string | null;
  winner_pair_id?: string | null;
}

/** A row's sides and winner, from the pair columns in doubles and the participant ones in singles. */
export function matchSides(m: MatchSideColumns, doubles: boolean): { a: string | null; b: string | null; winner: string | null } {
  return doubles
    ? { a: m.pair_a_id ?? null, b: m.pair_b_id ?? null, winner: m.winner_pair_id ?? null }
    : { a: m.participant_a_id ?? null, b: m.participant_b_id ?? null, winner: m.winner_participant_id ?? null };
}

/**
 * The event's play as the staged functions read it. Rows without a stage are
 * ignored. A group's members are everyone who appears in its matches; the
 * field is in seed order, unseeded last; withdrawn and disqualified entries
 * are `out`, and no-shows `absent`.
 */
export function formatResultsFrom(
  cfg: FormatConfig,
  entries: readonly StagedEntryRow[],
  matches: readonly StagedMatchRow[],
): FormatResults {
  const staged = matches.filter((m): m is StagedMatchRow & { stage: number } => m.stage != null);
  const keyOf = (stage: number) => cfg.stages[stage - 1]?.key ?? `stage${stage}`;
  const groups = new Map<string, StageGroupResult>();
  for (const m of staged) {
    if (m.pool_number == null || m.group_number == null) continue;
    const k = `${m.stage}:${m.pool_number}:${m.group_number}`;
    const g = groups.get(k) ?? { stage: keyOf(m.stage), pool: m.pool_number, group: m.group_number, members: [] };
    for (const id of [m.a, m.b]) if (id && !g.members.includes(id)) g.members.push(id);
    groups.set(k, g);
  }
  const results: StageMatchResult[] = staged.map((m) => ({
    stage: keyOf(m.stage),
    pool: m.pool_number,
    group: m.group_number,
    round: m.round_number,
    label: m.match_label,
    thirdPlace: m.is_third_place === true,
    a: m.a,
    b: m.b,
    status: m.status,
    winner: m.winner,
    games: Array.isArray(m.scores) ? (m.scores as Array<{ a: number; b: number }>) : null,
  }));
  const seeded = [...entries].sort((x, y) => (x.seed ?? Infinity) - (y.seed ?? Infinity) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {
    field: seeded.map((e) => ({ id: e.id, seed: e.seed })),
    groups: [...groups.values()],
    matches: results,
    out: entries.filter((e) => isOutOfEvent(e.status)).map((e) => e.id),
    absent: entries.filter((e) => e.status === 'no_show').map((e) => e.id),
  };
}
