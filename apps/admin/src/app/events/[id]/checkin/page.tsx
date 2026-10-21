export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isUuid } from '@badminton/shared';
import { Card, PageHeader } from '@badminton/ui';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import type { CheckInRow } from '@/components/checkin-list';
import { ClubEventCheckIn } from '../../checkin-card';

// THE CLUB EVENT'S DOOR LIST, on its own page so whoever is at the door has
// nothing else on screen. Members and the Google Form's non-members (00284) in
// one list; the event page shows only the count and a link here.

type Name = { full_name: string | null } | { full_name: string | null }[] | null;

export default async function ClubEventCheckInPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireCapability('events.page');
  if (!isUuid(id)) notFound();
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(level, viewer);
  // The names are read only with the sign-ups read, as on the event page.
  if (!permits(level, permissions, 'events.signups.read')) notFound();
  const canWrite = permits(level, permissions, 'events.signups.checkin.write');

  const adminClient = createAdminClient();
  const { data: event } = await adminClient
    .from('club_events')
    .select('id, title, status, tournament_event_id')
    .eq('id', id)
    .maybeSingle();
  if (!event) notFound();

  // A club event run as a tournament (00292) checks people in on the tournament.
  if (event.tournament_event_id) {
    const { data: linked } = await adminClient
      .from('tournament_events')
      .select('tournament_id')
      .eq('id', event.tournament_event_id)
      .maybeSingle();
    if (linked) redirect(`/tournaments/${linked.tournament_id}/checkin`);
  }

  // A failed read arrives as an empty list, which at the door would say nobody
  // signed up, so either failure throws instead.
  const [{ data: members, error: memberError }, { data: guests, error: guestError }] = await Promise.all([
    adminClient.from('club_event_signups').select('player_id, checked_in_at, players(full_name)').eq('event_id', id),
    adminClient.from('club_event_external_signups').select('id, full_name, checked_in_at').eq('event_id', id),
  ]);
  if (memberError) throw new Error(`Could not read the sign-ups: ${memberError.message}`);
  if (guestError) throw new Error(`Could not read the Form sign-ups: ${guestError.message}`);

  const rows: CheckInRow[] = [
    ...((members ?? []) as unknown as { player_id: string; checked_in_at: string | null; players: Name }[]).map(
      (row) => ({
        key: `member:${row.player_id}`,
        name: (Array.isArray(row.players) ? row.players[0] : row.players)?.full_name ?? 'A member',
        here: !!row.checked_in_at,
      }),
    ),
    ...((guests ?? []) as { id: string; full_name: string; checked_in_at: string | null }[]).map((row) => ({
      key: `guest:${row.id}`,
      name: row.full_name,
      detail: 'Non-member (Google Form)',
      here: !!row.checked_in_at,
    })),
  ];

  return (
    <div>
      <PageHeader
        eyebrow="CHECK-IN"
        title={event.title as string}
        sub={
          <Link href={`/events/${id}`} className="hover:underline">
            Back to the event
          </Link>
        }
      />
      {event.status === 'cancelled' ? (
        <Card>
          <p className="text-sm text-[var(--text-muted)]">This event was cancelled.</p>
        </Card>
      ) : (
        <Card className="p-0 pt-5">
          <ClubEventCheckIn eventId={id} rows={rows} canWrite={canWrite} />
        </Card>
      )}
    </div>
  );
}
