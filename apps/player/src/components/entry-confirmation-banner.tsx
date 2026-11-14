import Link from 'next/link';
import { TOURNAMENT_EVENT_TYPE_LABELS, formatClubEventTime } from '@badminton/shared';
import { loadMyPendingConfirmations } from '@/lib/event-confirmations';

// "Confirm your place", on /feed beside the payment banner, for every event
// still waiting on this member (00325). The caller checks the switch and the
// tournaments feature; the loader never throws, so a failed read shows nothing.
export async function EntryConfirmationBanner({ playerId }: { playerId: string }) {
  const pending = await loadMyPendingConfirmations(playerId);
  const open = pending.filter((p) => !p.deadlineAt || new Date(p.deadlineAt).getTime() > Date.now());
  if (open.length === 0) return null;
  return (
    <div className="card-base" role="status" style={{ marginBottom: 20, borderLeft: '3px solid var(--gold)' }}>
      {open.map((p) => {
        const label = (TOURNAMENT_EVENT_TYPE_LABELS as Record<string, string>)[p.eventType] ?? p.eventType;
        return (
          <p key={p.eventId} style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>
            Confirm your place in {label} at {p.tournamentName}
            {p.deadlineAt ? ` by ${formatClubEventTime(p.deadlineAt)}` : ''}.{' '}
            <Link href={`/tournaments/${p.tournamentId}/events/${p.eventId}/confirm`} className="fees-link">
              Confirm
            </Link>
          </p>
        );
      })}
    </div>
  );
}
