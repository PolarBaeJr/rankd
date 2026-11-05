// Tally and rank a stage. Scores count as recorded, head starts included
// (owner decision 4), and a walkover counts as the stage's forfeit score.

import type { StageScoring, StageTiebreak } from './schema';

/** One match as the staged functions read it. */
export interface StageMatchResult {
  stage: string;
  pool: number | null;
  group: number | null;
  round: number | null;
  /** The match label in a 'matches' stage; null elsewhere. */
  label: string | null;
  thirdPlace?: boolean;
  a: string | null;
  b: string | null;
  /** A tournament match status: pending, ready, live, completed, walkover, disputed, voided. */
  status: string;
  winner: string | null;
  games: ReadonlyArray<{ a: number; b: number }> | null;
}

export interface StageGroupResult {
  stage: string;
  pool: number;
  group: number;
  members: string[];
}

/** Everything the pure staged functions need to know about an event's play. */
export interface FormatResults {
  /** The event's entries in seed order; seed may be null. */
  field: ReadonlyArray<{ id: string; seed: number | null }>;
  groups: readonly StageGroupResult[];
  matches: readonly StageMatchResult[];
  /** Withdrawn or disqualified: counted in others' records, never ranked or placed. */
  out?: readonly string[];
  /**
   * Marked as a no-show after the draw: still ranked and placed, but below
   * everyone who came, so a record of no matches never takes a place from one
   * with a loss.
   */
  absent?: readonly string[];
}

export interface StageStandingRow {
  id: string;
  seed: number | null;
  played: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  gamesFor: number;
  gamesAgainst: number;
}

/** A result that counts in a table. */
export function isTalliedStatus(status: string): boolean {
  return status === 'completed' || status === 'walkover';
}

/** Nothing more will happen to this match. A voided match is settled but not tallied. */
export function isSettledStatus(status: string): boolean {
  return isTalliedStatus(status) || status === 'voided';
}

/** The score a walkover is recorded as: the stage's forfeit, or target-0. */
export function forfeitScore(scoring: Pick<StageScoring, 'forfeit' | 'target'>): { winner: number; loser: number } {
  return scoring.forfeit ?? { winner: scoring.target, loser: 0 };
}

/**
 * Tally the given matches for the given entries.
 *
 * A walkover counts as one game at the forfeit score, whatever was typed. The
 * forfeit is taken as configured (15-0), WITHOUT the loser's head start: it is
 * a recorded result, not a game that was played.
 */
export function tallyStage(
  ids: readonly string[],
  matches: readonly StageMatchResult[],
  forfeitFor: (m: StageMatchResult) => { winner: number; loser: number },
  seeds: ReadonlyMap<string, number | null> = new Map(),
): Map<string, StageStandingRow> {
  const rows = new Map<string, StageStandingRow>();
  for (const id of ids) {
    rows.set(id, {
      id, seed: seeds.get(id) ?? null,
      played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, gamesFor: 0, gamesAgainst: 0,
    });
  }
  const credit = (row: StageStandingRow | undefined, pf: number, pa: number) => {
    if (!row) return;
    row.pointsFor += pf;
    row.pointsAgainst += pa;
    if (pf > pa) row.gamesFor++;
    else if (pa > pf) row.gamesAgainst++;
  };

  for (const m of matches) {
    if (!isTalliedStatus(m.status) || !m.a || !m.b) continue;
    const a = rows.get(m.a);
    const b = rows.get(m.b);
    if (!a && !b) continue;
    if (a) a.played++;
    if (b) b.played++;
    if (m.winner === m.a) {
      if (a) a.wins++;
      if (b) b.losses++;
    } else if (m.winner === m.b) {
      if (b) b.wins++;
      if (a) a.losses++;
    }

    if (m.status === 'walkover') {
      if (m.winner !== m.a && m.winner !== m.b) continue;
      const f = forfeitFor(m);
      const aWon = m.winner === m.a;
      credit(a, aWon ? f.winner : f.loser, aWon ? f.loser : f.winner);
      credit(b, aWon ? f.loser : f.winner, aWon ? f.winner : f.loser);
      continue;
    }
    for (const g of m.games ?? []) {
      credit(a, g.a, g.b);
      credit(b, g.b, g.a);
    }
  }
  return rows;
}

function metric(row: StageStandingRow, key: Exclude<StageTiebreak, 'h2h'>, normalise: boolean): number {
  const per = (v: number) => (normalise ? v / Math.max(1, row.played) : v);
  switch (key) {
    case 'wins': return per(row.wins);
    case 'point_diff': return per(row.pointsFor - row.pointsAgainst);
    case 'points_for': return per(row.pointsFor);
    case 'points_against_low': return -per(row.pointsAgainst);
    case 'game_diff': return per(row.gamesFor - row.gamesAgainst);
    // Lower seed number ranks higher; unseeded last.
    case 'seed': return row.seed == null ? -Infinity : -row.seed;
  }
}

export interface RankOptions {
  /**
   * Divide every count by matches played. For comparing across groups, where
   * one group may have played more matches than another.
   */
  normalise?: boolean;
  /** Final fallback order by id, when every tiebreak is level. Default: seed, then id. */
  fallback?: readonly string[];
}

/**
 * Order rows best first by the tiebreaks in turn.
 *
 * 'h2h' is a mini-league: among the rows still level at that point, wins in
 * the matches between THEM only. Groups it splits are then ordered by the
 * remaining tiebreaks; the mini-league is not recomputed for the smaller set.
 */
export function rankStandings<T extends StageStandingRow>(
  rows: readonly T[],
  tiebreaks: readonly StageTiebreak[],
  matches: readonly StageMatchResult[],
  opts: RankOptions = {},
): T[] {
  const normalise = opts.normalise ?? false;
  const fallbackIndex = new Map((opts.fallback ?? []).map((id, i) => [id, i]));
  const fallback = (x: T, y: T) => {
    const fx = fallbackIndex.get(x.id);
    const fy = fallbackIndex.get(y.id);
    if (fx != null || fy != null) return (fx ?? Infinity) - (fy ?? Infinity);
    const sx = x.seed ?? Infinity;
    const sy = y.seed ?? Infinity;
    if (sx !== sy) return sx - sy;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  };

  const rank = (set: T[], keys: readonly StageTiebreak[]): T[] => {
    if (set.length <= 1) return set;
    if (keys.length === 0) return [...set].sort(fallback);
    const [key, ...rest] = keys;
    let value: (r: T) => number;
    if (key === 'h2h') {
      const ids = new Set(set.map((r) => r.id));
      const h2h = new Map<string, number>();
      for (const m of matches) {
        if (!isTalliedStatus(m.status) || !m.a || !m.b || !m.winner) continue;
        if (ids.has(m.a) && ids.has(m.b) && ids.has(m.winner)) h2h.set(m.winner, (h2h.get(m.winner) ?? 0) + 1);
      }
      value = (r) => h2h.get(r.id) ?? 0;
    } else {
      value = (r) => metric(r, key!, normalise);
    }
    const buckets = new Map<number, T[]>();
    for (const r of set) {
      const v = value(r);
      const b = buckets.get(v);
      if (b) b.push(r);
      else buckets.set(v, [r]);
    }
    return [...buckets.entries()]
      .sort(([x], [y]) => y - x)
      .flatMap(([, b]) => rank(b, rest));
  };

  return rank([...rows], tiebreaks);
}
