// How a decided match reads on a bracket, a table, a result list and a notice
// (00329). A match played reads as its scores; one decided off court has none
// to show; a retirement shows the games as far as they got and who stopped.
// Pure, so the console and the members' app say it the same way.

export type MatchResultKind = 'off_court' | 'retired';

export interface LabelledMatch {
  /** The row's jsonb as read: a list of games, or null. */
  scores: unknown;
  result_kind?: string | null;
  retired_side?: string | null;
}

export const OFF_COURT_LABEL = 'Decided off court';

export function scoresText(scores: unknown): string {
  if (!Array.isArray(scores)) return '';
  return (scores as Array<{ a: number; b: number }>).map((g) => `${g.a}-${g.b}`).join(', ');
}

/** The line a decided match reads as, or the plain scores for one played. */
export function matchResultLabel(match: LabelledMatch): string {
  if (match.result_kind === 'off_court') return OFF_COURT_LABEL;
  if (match.result_kind === 'retired') {
    const who = match.retired_side === 'a' ? 'A' : match.retired_side === 'b' ? 'B' : null;
    const games = scoresText(match.scores);
    const note = who ? `${who} retired` : 'retired';
    return games ? `${games} (${note})` : `Retired (${note})`;
  }
  return scoresText(match.scores);
}

export const MAX_RETIREMENT_GAMES = 7;

/**
 * The partial score a retirement is recorded with: 0 to 7 games, each side a
 * whole number from 0 to 99. Nothing else: the last game may be unfinished and
 * the side that retired may be ahead, so no game rule or winner check applies.
 * Returns the desk's words, or null when it is fine.
 */
export function retirementScoresRefusal(scores: unknown): string | null {
  if (!Array.isArray(scores) || scores.length > MAX_RETIREMENT_GAMES) {
    return `Enter at most ${MAX_RETIREMENT_GAMES} games.`;
  }
  for (const game of scores) {
    const g = game as { a?: unknown; b?: unknown } | null;
    const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 99;
    if (!g || !whole(g.a) || !whole(g.b)) return 'Each game score is a whole number from 0 to 99.';
  }
  return null;
}
