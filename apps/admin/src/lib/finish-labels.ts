// The word beside a final position on the Results tab, taken from the knockout
// rounds the event actually played. A staged event whose knockout was a Top 4
// has no quarter-final, so its 5th place is "5th", not "Quarter-finalist".

export interface FinishLabelMatch {
  status: string;
  round_number: number;
  stage?: number | null;
  phase?: string | null;
  group_number?: number | null;
  is_third_place?: boolean | null;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

/**
 * The rows of the knockout that decided the event. Staged: the latest stage
 * with a non-voided row outside any group. pool_to_bracket: its bracket half.
 * single_elimination: every row. A round robin has none.
 */
function decidingKnockout(matches: readonly FinishLabelMatch[], format: string | null | undefined): FinishLabelMatch[] {
  if (format === 'staged') {
    const outsideGroups = matches.filter((m) => m.stage != null && m.group_number == null);
    const stage = outsideGroups
      .filter((m) => m.status !== 'voided')
      .reduce<number | null>((top, m) => (top == null || m.stage! > top ? m.stage! : top), null);
    return stage == null ? [] : outsideGroups.filter((m) => m.stage === stage);
  }
  if (format === 'pool_to_bracket') return matches.filter((m) => m.phase === 'bracket');
  if (format === 'single_elimination') return [...matches];
  return [];
}

/** How many knockout rounds the event played: distinct rounds, third place and voids aside. */
export function knockoutRounds(matches: readonly FinishLabelMatch[], format: string | null | undefined): number {
  const rounds = new Set(
    decidingKnockout(matches, format)
      .filter((m) => !m.is_third_place && m.status !== 'voided')
      .map((m) => m.round_number),
  );
  return rounds.size;
}

/**
 * 1 is always Champion. Every other label needs its round to exist: Finalist
 * a final, Semi-finalist a semi-final, and so on. Without a played third-place
 * play-off, 3rd and 4th are both "Semi-finalist", because nothing on court
 * separated them; with one, whoever won it finished 3rd.
 */
export function finishLabel(position: number | null | undefined, rounds: number, playoffPlayed: boolean): string {
  if (!position) return '';
  if (position === 1) return 'Champion';
  if (position === 2 && rounds >= 1) return 'Finalist';
  if (playoffPlayed && position === 3) return '3rd place';
  if (playoffPlayed && position === 4) return '4th place';
  if (position <= 4 && rounds >= 2) return 'Semi-finalist';
  if (position >= 5 && position <= 8 && rounds >= 3) return 'Quarter-finalist';
  if (position >= 9 && position <= 16 && rounds >= 4) return 'Round of 16';
  return ordinal(position);
}
