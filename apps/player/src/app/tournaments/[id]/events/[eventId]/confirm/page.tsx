import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ATTENDANCE_POLICY_TEXT, TOURNAMENT_EVENT_TYPE_LABELS, formatClubEventTime } from '@badminton/shared';
import { getViewer } from '@/lib/supabase-server';
import { getReleaseFlags } from '@/lib/release-flags';
import { loadMyPendingConfirmations } from '@/lib/event-confirmations';
import { ConfirmEntryButton } from './ConfirmEntryButton';

// "CONFIRM YOUR PLACE" (00325), the page the email links to. It never confirms
// on a GET: mail scanners open links, and a scanner keeping somebody's place
// for them is the failure this whole check exists to stop. Only the member's
// own pending row is read, so anybody else's link, or a settled one, shows
// "Nothing to confirm" and says nothing about whose it was.

export default async function ConfirmEntryPage({ params }: { params: Promise<{ id: string; eventId: string }> }) {
  const { id: tournamentId, eventId } = await params;
  const { player } = await getViewer();
  if (!player) redirect('/login');

  const eventHref = `/tournaments/${tournamentId}/events/${eventId}`;
  const releaseFlags = await getReleaseFlags();
  if (!releaseFlags.entry_confirmation) redirect(eventHref);

  const pending = (await loadMyPendingConfirmations(player.id, eventId)).find((p) => p.tournamentId === tournamentId);
  if (!pending) {
    return (
      <div className="px-4 sm:px-0 py-6 space-y-3 max-w-prose">
        <h1 className="display-md">Nothing to confirm</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Your place is already confirmed, or this event is not asking you to confirm.
        </p>
        <Link href={eventHref} className="fees-link text-sm">Back to the event</Link>
      </div>
    );
  }
  if (pending.deadlineAt && new Date(pending.deadlineAt).getTime() <= Date.now()) {
    return (
      <div className="px-4 sm:px-0 py-6 space-y-3 max-w-prose">
        <h1 className="display-md">The deadline has passed</h1>
        <p className="text-sm text-[var(--text-secondary)]">Ask the organizers at the desk.</p>
        <Link href={eventHref} className="fees-link text-sm">Back to the event</Link>
      </div>
    );
  }
  const eventLabel = (TOURNAMENT_EVENT_TYPE_LABELS as Record<string, string>)[pending.eventType] ?? pending.eventType;
  return (
    <div className="px-4 sm:px-0 py-6 space-y-4 max-w-prose">
      <p className="eyebrow">{pending.tournamentName}</p>
      <h1 className="display-md">Confirm your place in {eventLabel}</h1>
      <p className="text-sm text-[var(--text-secondary)]">
        {pending.deadlineAt
          ? <>Confirm by <strong>{formatClubEventTime(pending.deadlineAt)}</strong> or your place goes to the waitlist.</>
          : 'Confirm before the deadline or your place goes to the waitlist.'}
        {' '}If you cannot come, withdraw so a reserve gets your place.
      </p>
      <p className="text-sm text-[var(--text-secondary)]">
        <strong>Attendance policy.</strong> {ATTENDANCE_POLICY_TEXT}
      </p>
      <ConfirmEntryButton eventId={eventId} eventHref={eventHref} canWithdraw />
    </div>
  );
}
