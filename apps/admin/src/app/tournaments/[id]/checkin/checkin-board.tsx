'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { CheckInList, type CheckInRow } from '@/components/checkin-list';
import { checkInPair, checkInParticipant, undoCheckIn } from '@/lib/tournament-actions/participants';

// The tournament's door list: every entry in every event. A row's key is
// `single:<participant id>` or `pair:<pair id>`. The writes are the event
// page's own actions, so the 00201 fence, the suspension check and the waiver
// block all apply here exactly as they do there.
export function TournamentCheckInBoard({ rows, canWrite }: { rows: CheckInRow[]; canWrite: boolean }) {
  const router = useRouter();

  // Members also check themselves in with the QR code, so the list re-reads
  // every 20 seconds while it is open.
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 20_000);
    return () => clearInterval(timer);
  }, [router]);

  async function onToggle(row: CheckInRow, here: boolean) {
    const [kind, id] = row.key.split(':') as ['single' | 'pair', string];
    const result = here
      ? kind === 'pair'
        ? await checkInPair(id)
        : await checkInParticipant(id)
      : await undoCheckIn(id, kind === 'pair');
    return result.ok ? null : result.error;
  }

  return (
    <CheckInList
      rows={rows}
      canWrite={canWrite}
      onToggle={onToggle}
      emptyText="Nobody has entered this tournament yet."
    />
  );
}
