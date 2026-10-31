// WHICH COURTS A STAGED MATCH MAY GO ON. A groups stage gives each pool its
// courts (or one shared list), a knockout may give one list; the desk keeps a
// match on them for the whole stage, not only when it is drawn.

import { courtKey, courtLabel, courtsInOrder, resolveCourtLabels, type TournamentCourt } from '../match-court';
import type { FormatConfig } from './schema';

/**
 * The court labels a staged match's stage allows, or null for any court.
 * `stage` is 1-based, as stored on the row.
 */
export function stageCourtLabels(
  cfg: FormatConfig | null | undefined,
  match: { stage?: number | null; pool_number?: number | null },
): string[] | null {
  if (!cfg || match.stage == null) return null;
  const stage = cfg.stages[match.stage - 1];
  if (!stage) return null;
  if (stage.kind === 'groups') {
    if (!stage.courts) return null;
    if (stage.courts.mode === 'shared') return stage.courts.courts;
    return stage.courts.pools[(match.pool_number ?? 1) - 1] ?? null;
  }
  if (stage.kind === 'knockout') return stage.courts ?? null;
  return null;
}

/**
 * The tournament's courts a stage's labels name, in court order, matched by
 * courtKey so "1" is "Court 1". null when there is no restriction, or when no
 * label names an active court (renamed or switched off), so the desk is never
 * left with nowhere to put a match.
 */
export function allowedTournamentCourts<C extends TournamentCourt>(
  courts: readonly C[],
  labels: readonly string[] | null,
): C[] | null {
  if (!labels) return null;
  const { byLabel } = resolveCourtLabels(courts, labels);
  const ids = new Set([...byLabel.values()].map((c) => c.id));
  if (ids.size === 0) return null;
  return courtsInOrder(courts).filter((c) => ids.has(c.id));
}

/** Is a free-text court one of the labels. */
export function courtInLabels(court: string, labels: readonly string[]): boolean {
  const key = courtKey(court);
  return labels.some((l) => courtKey(l) === key);
}

/** "Court 1", or "Courts 1, 2". */
export function allowedCourtsSentence(labels: readonly string[]): string {
  const named = labels.map((l) => courtLabel(l) ?? l.trim());
  if (named.length === 1) return named[0]!;
  return `Courts ${named.map((n) => n.replace(/^Court /, '')).join(', ')}`;
}
