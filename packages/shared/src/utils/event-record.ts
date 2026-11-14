// ============================================================
// ONE ENTRY'S RECORD IN ONE EVENT
// ============================================================
//
// Counted in two places that must agree: the console's after-score summary
// (getMatchOutcomeSummary in admin tournament-actions/results.ts) and the
// member's own "your event so far" on the player event page. Two copies of
// "what counts as a match played" would drift the first time a status was
// added, and a member reading 3-1 while the desk reads 3-2 is the kind of
// disagreement nobody can settle from either screen.
//
// Nothing in here touches React, the DOM or the database.

/**
 * One match, already resolved to entry ids: a tournament_participants id on a
 * singles event, a tournament_pairs id on a doubles one. The caller spends the
 * `doubles` branch once, when it flattens the rows.
 */
export interface EventRecordMatch {
  id: string;
  status: string;
  is_bye: boolean;
  scores: Array<{ a: number; b: number }> | null;
  round_number: number;
  bracket_position: number;
  phase?: string | null;
  round_name?: string | null;
  aId: string | null;
  bId: string | null;
  winnerId: string | null;
}

export interface EventRecordLast {
  matchId: string;
  opponentId: string | null;
  won: boolean;
  /** Each game from the entry's own side: `mine` is its points, `theirs` the opponent's. */
  scores: Array<{ mine: number; theirs: number }>;
  roundName: string;
}

export interface EventRecord {
  played: number;
  won: number;
  lost: number;
  gamesWon: number;
  gamesLost: number;
  /** Rally points, summed across games. NOT tournament points, which are written at finalise. */
  pointsFor: number;
  pointsAgainst: number;
  last: EventRecordLast | null;
}

const phaseRank = (m: EventRecordMatch) => (m.phase === 'bracket' ? 1 : 0);

/**
 * The entry's record in the matches given.
 *
 * WHAT COUNTS: completed and walkover, never a bye. A bye is written `completed`
 * with the entrant already in the winner column, but nobody played it; a voided
 * match no longer happened. This is the rule the console's after-score summary
 * has always counted by, and `isPlayedMatch` makes the same call on byes.
 *
 * A WALKOVER WITH NO SCORES counts as a win or a loss and adds nothing to games
 * or points: there were no rallies to count.
 *
 * THE LAST MATCH is the latest in play order: the knockout after the pool
 * (round_number restarts at 1 in the bracket of a pool_to_bracket event, so
 * the round alone would put a pool round 3 after a quarter-final), then round,
 * then bracket position.
 */
export function eventRecordFor(matches: EventRecordMatch[], entryId: string): EventRecord {
  return eventRecordBySide(matches, (m) => (m.aId === entryId ? 'a' : m.bId === entryId ? 'b' : null));
}

/**
 * The same record, with the side each match counts for decided by the caller:
 * 'a', 'b', or null for a match that is not theirs. Won is the winner being the
 * entry on that side.
 */
export function eventRecordBySide<M extends EventRecordMatch>(
  matches: M[],
  sideOf: (match: M) => 'a' | 'b' | null,
): EventRecord {
  const record: EventRecord = {
    played: 0, won: 0, lost: 0, gamesWon: 0, gamesLost: 0, pointsFor: 0, pointsAgainst: 0, last: null,
  };
  let lastMatch: M | null = null;
  let lastSide: 'a' | 'b' = 'a';

  for (const m of matches) {
    if (m.is_bye) continue;
    if (m.status !== 'completed' && m.status !== 'walkover') continue;
    const side = sideOf(m);
    if (!side) continue;
    const mineId = side === 'a' ? m.aId : m.bId;

    record.played++;
    if (mineId != null && m.winnerId === mineId) record.won++;
    else record.lost++;

    for (const g of m.scores ?? []) {
      const mine = side === 'a' ? g.a : g.b;
      const theirs = side === 'a' ? g.b : g.a;
      if (typeof mine !== 'number' || typeof theirs !== 'number') continue;
      record.pointsFor += mine;
      record.pointsAgainst += theirs;
      if (mine > theirs) record.gamesWon++;
      else if (theirs > mine) record.gamesLost++;
    }

    if (
      !lastMatch
      || phaseRank(m) > phaseRank(lastMatch)
      || (phaseRank(m) === phaseRank(lastMatch) && (
        m.round_number > lastMatch.round_number
        || (m.round_number === lastMatch.round_number && m.bracket_position > lastMatch.bracket_position)
      ))
    ) {
      lastMatch = m;
      lastSide = side;
    }
  }

  if (lastMatch) {
    const side = lastSide;
    const mineId = side === 'a' ? lastMatch.aId : lastMatch.bId;
    record.last = {
      matchId: lastMatch.id,
      opponentId: side === 'a' ? lastMatch.bId : lastMatch.aId,
      won: mineId != null && lastMatch.winnerId === mineId,
      scores: (lastMatch.scores ?? []).map((g) => ({
        mine: side === 'a' ? g.a : g.b,
        theirs: side === 'a' ? g.b : g.a,
      })),
      roundName: lastMatch.round_name || `Round ${lastMatch.round_number}`,
    };
  }
  return record;
}

// ============================================================
// WHOSE MATCH IT IS, AFTER A SUBSTITUTION (00327 tournament_matches.lineup)
// ============================================================
//
// A match names entries, and a substitution rewrites an entry's people in
// place. So before it, every decided match of the entry gets a lineup: who
// actually played that side. A member's own matches and record are read by
// PERSON, not by entry:
//   * a side whose lineup names the member is theirs, even if the entry is
//     somebody else's now (the outgoing member keeps their history);
//   * a side with a lineup that does NOT name the member is not theirs, even
//     if the entry is theirs now (the incoming member is not credited with
//     what the outgoing one played);
//   * a side with no lineup is played by its entry's current members.

export interface MatchLineup {
  a?: string[];
  b?: string[];
}

/** The lineup column as read, or null when there is none or it is malformed. */
export function parseLineup(raw: unknown): MatchLineup | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: MatchLineup = {};
  for (const key of ['a', 'b'] as const) {
    const side = (raw as Record<string, unknown>)[key];
    if (Array.isArray(side)) out[key] = side.filter((id): id is string => typeof id === 'string');
  }
  return out.a || out.b ? out : null;
}

export interface MatchViewer {
  playerId: string;
  /** The entry the member is on now in this event, if any. */
  entryId: string | null;
}

/** Which side of the match the member played, or null for a match that is not theirs. */
export function viewerSideOf(
  match: { aId: string | null; bId: string | null; lineup?: unknown },
  viewer: MatchViewer,
): 'a' | 'b' | null {
  const lineup = parseLineup(match.lineup);
  for (const side of ['a', 'b'] as const) {
    const named = lineup?.[side];
    if (named) {
      if (named.includes(viewer.playerId)) return side;
      continue;
    }
    const entry = side === 'a' ? match.aId : match.bId;
    if (viewer.entryId != null && entry === viewer.entryId) return side;
  }
  return null;
}

/** The member's own record in an event, by who played rather than whose entry it is. */
export function viewerEventRecord<M extends EventRecordMatch & { lineup?: unknown }>(
  matches: M[],
  viewer: MatchViewer,
): EventRecord {
  return eventRecordBySide(matches, (m) => viewerSideOf(m, viewer));
}

/**
 * THE RATING LINE, reconciled so its three figures always agree.
 *
 * The delta is derived from the two ratings beside it, not read from elo_change,
 * whenever both exist. They usually agree (applyPlacementBonuses credits
 * elo_change and elo_after together), but the placement bonus is CLAMPED into
 * elo_after and not into elo_change, so at the rating ceiling the stored change
 * can exceed the movement it describes. "1114 -> 1190 (+108)" is exactly the row
 * 00083 and the elo_after fix exist to have stopped appearing.
 *
 * With no elo_after at all (an entry that has been credited but never rated)
 * there is no arrow to draw, so the stored change is returned on its own with
 * `before`/`after` null. Null when there is nothing to say.
 */
export function eventRatingLine(
  before: number | null,
  after: number | null,
  change: number | null,
): { before: number | null; after: number | null; delta: number } | null {
  const hasBoth = before != null && after != null;
  const delta = hasBoth ? after - before : change;
  if (delta == null) return null;
  return { before: hasBoth ? before : null, after: hasBoth ? after : null, delta };
}
