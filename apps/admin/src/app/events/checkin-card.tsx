'use client';

import { CheckInList, type CheckInRow } from '@/components/checkin-list';
import { setClubEventCheckIn } from '@/lib/actions/club-events';

// The club event's door list (00293): members and the Google Form's
// non-members in one list. A row's key is `member:<player id>` or
// `guest:<external sign-up id>`, which is what the action needs back.
export function ClubEventCheckIn({
  eventId,
  rows,
  canWrite,
}: {
  eventId: string;
  rows: CheckInRow[];
  canWrite: boolean;
}) {
  async function onToggle(row: CheckInRow, here: boolean) {
    const [kind, id] = row.key.split(':') as ['member' | 'guest', string];
    const result = await setClubEventCheckIn(eventId, { kind, id }, here);
    return result.ok ? null : result.error;
  }
  return <CheckInList rows={rows} canWrite={canWrite} onToggle={onToggle} />;
}
