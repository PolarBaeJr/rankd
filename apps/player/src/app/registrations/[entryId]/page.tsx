import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PageHeader, Badge } from '@badminton/ui';
import { formatClubEventTime, isDoublesEvent, isUuid } from '@badminton/shared';
import { createServiceRoleClient, getViewer } from '@/lib/supabase-server';
import { ConfirmImportForm } from './confirm-form';

// CONFIRM A GOOGLE FORM ENTRY (00283).
//
// Somebody filled in the club's form with this member's email. Nothing was
// entered: the entry waits here until the member confirms it, through their
// own self-entry path, or says it was not them. The page reads with the
// service client, so ownership is checked here by hand: an entry id that is
// not the signed-in member's is a 404, exactly like one that does not exist.

const STATUS_LABEL: Record<string, string> = {
  awaiting_member: 'Waiting for you',
  awaiting_partner: 'Waiting for your partner',
  entered: 'Entered',
  needs_review: 'With the club',
  refused: 'Not entered',
  undone: 'Withdrawn by the club',
  superseded: 'Replaced by a later response',
};

function eventLabel(eventType: string): string {
  const words = eventType.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default async function ConfirmRegistrationPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const { entryId } = await params;
  if (!isUuid(entryId)) notFound();
  const { player } = await getViewer();
  if (!player) redirect('/login');

  const service = createServiceRoleClient();
  const { data: entry, error } = await service
    .from('registration_import_entries')
    .select('id, status, reason, entrant_id, tournament_event_id, club_event_id, requested_partner_id, partner_name')
    .eq('id', entryId)
    .eq('entrant_id', player.id)
    .maybeSingle();
  if (error) throw new Error('Could not load this entry');
  if (!entry) notFound();

  let title = '';
  let detail = '';
  let backHref = '/notifications';
  let waiverText: string | null = null;
  let doubles = false;
  let partnerName: string | null = null;

  if (entry.tournament_event_id) {
    const { data: event } = await service
      .from('tournament_events')
      .select('id, event_type, tournament_id, tournament:tournaments(name, waiver_text, start_date)')
      .eq('id', entry.tournament_event_id)
      .maybeSingle();
    if (!event) notFound();
    const tournament = (Array.isArray(event.tournament) ? event.tournament[0] : event.tournament) as
      | { name: string; waiver_text: string | null; start_date: string | null }
      | null;
    title = tournament?.name ?? 'Tournament';
    detail = eventLabel(event.event_type);
    backHref = `/tournaments/${event.tournament_id}`;
    waiverText = tournament?.waiver_text?.trim() || null;
    doubles = isDoublesEvent(event.event_type);
    if (entry.requested_partner_id) {
      const { data: partner } = await service
        .from('players')
        .select('full_name')
        .eq('id', entry.requested_partner_id)
        .maybeSingle();
      partnerName = partner?.full_name ?? null;
    }
    partnerName = partnerName ?? entry.partner_name ?? null;
  } else if (entry.club_event_id) {
    const { data: club } = await service
      .from('club_events')
      .select('id, title, starts_at')
      .eq('id', entry.club_event_id)
      .maybeSingle();
    if (!club) notFound();
    title = club.title;
    detail = formatClubEventTime(club.starts_at);
    backHref = `/events/${club.id}`;
  } else {
    // The event was deleted after the response came in.
    notFound();
  }

  const waiting = entry.status === 'awaiting_member';

  return (
    <div>
      <PageHeader title="Confirm your entry" sub={<Link href={backHref}>{title}</Link>} />
      <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Badge variant={entry.status === 'entered' ? 'success' : waiting ? 'warning' : 'neutral'}>
            {STATUS_LABEL[entry.status] ?? entry.status}
          </Badge>
        </div>
        <div>
          <strong>{title}</strong>
          <div className="muted">{detail}</div>
          {partnerName && <div className="muted">Partner named on the form: {partnerName}</div>}
        </div>
        {waiting ? (
          <>
            <p style={{ margin: 0, lineHeight: 1.55 }}>
              A response to the club&apos;s sign-up form used your email address. You are not entered
              yet. If it was you, confirm below and you are entered the same way as signing up in the
              app, fee included. If it was not you, say so and the club is told.
            </p>
            <ConfirmImportForm
              entryId={entry.id}
              kind={entry.tournament_event_id ? 'tournament' : 'club_event'}
              waiverText={waiverText}
              doubles={doubles}
              partnerName={partnerName}
              doneHref={backHref}
            />
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {entry.status === 'awaiting_partner'
              ? 'You are entered. When your partner confirms their own response, you are paired.'
              : 'There is nothing for you to do here.'}
          </p>
        )}
      </div>
    </div>
  );
}
