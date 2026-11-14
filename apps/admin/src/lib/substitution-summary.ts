// THE SUB DIALOG'S SUMMARY (00327). Pure: what the person coming in takes
// over, in the desk's words, so the desk sees the size of the change before
// making it. Decided matches stay with whoever played them and are not counted.

import { groupLabel } from '@badminton/shared';
import { isOpenMatch } from './stage-controls';

export function substitutionSummary(
  matches: ReadonlyArray<{ status: string; is_bye?: boolean | null; group_number: number | null; a: string | null; b: string | null }>,
  entryId: string,
): string {
  const theirs = matches.filter((m) => m.a === entryId || m.b === entryId);
  const open = theirs.filter(isOpenMatch);
  const played = theirs.filter((m) => m.status === 'completed' || m.status === 'walkover' || m.status === 'disputed').length;
  const groups = [...new Set(open.map((m) => m.group_number).filter((g): g is number => g != null))].sort((x, y) => x - y);
  const where = groups.length > 0 ? ` in ${groups.map((g) => `Group ${groupLabel(g)}`).join(', ')}` : '';
  const takes = open.length === 0
    ? 'No unplayed matches yet: they take the place in the draw.'
    : `Takes over ${open.length} unplayed match${open.length === 1 ? '' : 'es'}${where}.`;
  return played > 0
    ? `${takes} ${played} played match${played === 1 ? '' : 'es'} stay${played === 1 ? 's' : ''} with whoever played ${played === 1 ? 'it' : 'them'}.`
    : takes;
}
