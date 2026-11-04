// How far through its matches an event is, by the server's own rules, so the
// Finalize button and the knockout draw are greyed exactly when the server
// would refuse them.

import { isRealIncompleteMatch, type CompletableMatch } from '@badminton/shared';

const hasSide = (m: CompletableMatch, doubles: boolean) =>
  doubles ? Boolean(m.pair_a_id || m.pair_b_id) : Boolean(m.participant_a_id || m.participant_b_id);

/**
 * The whole event, by finalizeEvent's rule (isRealIncompleteMatch): a voided
 * match is decided, and an unused bracket slot is never waited on. `decided`
 * is `total - undecided`, so the two read "done" at the same moment.
 */
export function eventMatchProgress(
  matches: readonly CompletableMatch[],
  doubles: boolean,
): { total: number; undecided: number; decided: number } {
  const undecided = matches.filter((m) => isRealIncompleteMatch(m, doubles)).length;
  return { total: matches.length, undecided, decided: matches.length - undecided };
}

/**
 * The round-robin half, by the knockout draw's rule (brackets.ts): completed,
 * walkover, voided or a bye is played out, and an empty slot is not waited on.
 */
export function poolMatchesUndecided(matches: readonly CompletableMatch[], doubles: boolean): number {
  return matches.filter((m) => {
    if (['completed', 'walkover', 'voided'].includes(m.status ?? '') || m.is_bye) return false;
    return hasSide(m, doubles);
  }).length;
}
