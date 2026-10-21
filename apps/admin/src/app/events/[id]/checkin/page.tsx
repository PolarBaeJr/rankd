export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isUuid } from '@badminton/shared';
import { Card, PageHeader, type PlayerOption } from '@badminton/ui';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import type { CheckInRow } from '@/components/checkin-list';
import { ClubEventCheckIn, type PastGuest, type WaitingRow } from '../../checkin-card';

// THE CLUB EVENT'S DOOR, on its own page so whoever is at the door has nothing
// else on screen. Members and guests in one list (00293), and the last-minute
// changes (00294): no-shows, walk-ins and the waitlist. The event page shows
// only the count and a link here.

type Name = { full_name: string | null } | { full_name: string | null }[] | null;
const nameOf = (player: Name) => (Array.isArray(player) ? player[0] : player)?.full_name ?? null;

type MemberRow = {
  player_id: string;
  checked_in_at: string | null;
  no_show_at?: string | null;
  walk_in?: boolean;
  players: Name;
};
type GuestRow = {
  id: string;
  full_name: string;
  checked_in_at: string | null;
  no_show_at?: string | null;
  walk_in?: boolean;
};

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

  // 00294's columns first. A failed PostgREST read arrives as an empty list,
  // which at the door would say nobody signed up, so a failure retries with
  // 00293's columns only (the door's extras then say the migration is
  // missing), and a failure of that throws.
  const read = (memberColumns: string, guestColumns: string) =>
    Promise.all([
      adminClient.from('club_event_signups').select(memberColumns).eq('event_id', id),
      adminClient.from('club_event_external_signups').select(guestColumns).eq('event_id', id),
    ]);
  let doorReady = true;
  let [members, guests] = await read(
    'player_id, checked_in_at, no_show_at, walk_in, players(full_name)',
    'id, full_name, checked_in_at, no_show_at, walk_in',
  );
  if (members.error || guests.error) {
    doorReady = false;
    [members, guests] = await read('player_id, checked_in_at, players(full_name)', 'id, full_name, checked_in_at');
  }
  if (members.error) throw new Error(`Could not read the sign-ups: ${members.error.message}`);
  if (guests.error) throw new Error(`Could not read the guest sign-ups: ${guests.error.message}`);

  const memberRows = (members.data ?? []) as unknown as MemberRow[];
  const guestRows = (guests.data ?? []) as unknown as GuestRow[];
  const rows: CheckInRow[] = [
    ...memberRows.map((row) => ({
      key: `member:${row.player_id}`,
      name: nameOf(row.players) ?? 'A member',
      detail: row.walk_in ? 'Walk-in' : undefined,
      here: !!row.checked_in_at,
      noShow: !!row.no_show_at,
    })),
    ...guestRows.map((row) => ({
      key: `guest:${row.id}`,
      name: row.full_name,
      detail: row.walk_in ? 'Walk-in guest · waiver not signed' : 'Non-member (Google Form)',
      here: !!row.checked_in_at,
      noShow: !!row.no_show_at,
    })),
  ];

  // The door's extras are for those who can write, and only once 00294 is in.
  let waiting: WaitingRow[] = [];
  let members_: PlayerOption[] = [];
  let pastGuests: PastGuest[] = [];
  // The door RPCs refuse a draft, so a draft gets check-in only.
  const doorOpen = doorReady && event.status === 'published';
  if (canWrite && doorOpen) {
    const signedUp = new Set(memberRows.map((row) => row.player_id));
    const [{ data: waitData, error: waitError }, { data: playerData }, { data: pastData }] = await Promise.all([
      adminClient
        .from('club_event_waitlist' as never)
        .select('id, player_id, joined_at, offered_at, players!club_event_waitlist_player_id_fkey(full_name)')
        .eq('event_id', id)
        .eq('status', 'waiting')
        .order('joined_at')
        .order('id'),
      // Everybody who could walk in: members and the guest records (00292),
      // so a guest who came before is picked, not typed again.
      adminClient
        .from('players')
        .select('id, full_name, is_guest')
        .eq('is_banned', false)
        .is('deletion_requested_at', null)
        .not('status', 'in', '(pending_approval,suspended)')
        .order('full_name'),
      // Guests at earlier events who have no record of their own: picked by
      // name, with the email they gave if any.
      adminClient
        .from('club_event_external_signups')
        .select('full_name, email, created_at')
        .neq('event_id', id)
        .order('created_at', { ascending: false })
        .limit(300),
    ]);
    if (waitError) throw new Error(`Could not read the waitlist: ${waitError.message}`);
    waiting = ((waitData ?? []) as unknown as {
      id: string;
      player_id: string;
      joined_at: string;
      offered_at: string | null;
      players: Name;
    }[]).map((row) => ({
      id: row.id,
      name: nameOf(row.players) ?? 'A member',
      joinedAt: row.joined_at,
      offered: !!row.offered_at,
    }));
    members_ = ((playerData ?? []) as { id: string; full_name: string | null; is_guest: boolean | null }[])
      .filter((player) => !signedUp.has(player.id) && player.full_name)
      .map((player) => ({ id: player.id, name: player.full_name as string, meta: player.is_guest ? 'Guest' : null }));
    const seen = new Set<string>();
    pastGuests = [];
    for (const row of (pastData ?? []) as { full_name: string; email: string | null }[]) {
      const identity = (row.email ?? row.full_name).trim().toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      pastGuests.push({ name: row.full_name, email: row.email });
    }
  }

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
        <ClubEventCheckIn
          eventId={id}
          rows={rows}
          canWrite={canWrite}
          doorReady={doorOpen}
          waiting={waiting}
          members={members_}
          pastGuests={pastGuests}
        />
      )}
    </div>
  );
}
