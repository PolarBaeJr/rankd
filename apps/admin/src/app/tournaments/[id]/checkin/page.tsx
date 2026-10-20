export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TOURNAMENT_EVENT_TYPE_LABELS, isDoublesEvent, isUuid, type TournamentEventType } from '@badminton/shared';
import { Card, PageHeader } from '@badminton/ui';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import type { CheckInRow } from '@/components/checkin-list';
import { TournamentCheckInBoard } from './checkin-board';

// ONE DOOR LIST FOR THE WHOLE TOURNAMENT. Each event already has a Check-In
// tab; this puts every entry from every event on one screen, so whoever is at
// the door does not have to know which event a person entered.
//
// One row per entry, not per person: a pair is checked in as a pair (the
// action marks both), and someone in two events has a row for each, labelled
// with the event.

type Name = { full_name: string | null } | { full_name: string | null }[] | null;
const nameOf = (player: Name) => (Array.isArray(player) ? player[0] : player)?.full_name ?? 'A player';

// The event page's rules (CheckInTab): check-in while registration or check-in
// is open, undo only while check-in is open.
function closedReason(status: string, here: boolean): string | undefined {
  if (here) return status === 'checkin' ? undefined : 'Check-in is closed for this event';
  return status === 'registration' || status === 'checkin' ? undefined : 'Check-in is closed for this event';
}

export default async function TournamentCheckInPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireCapability('tournaments.page');
  if (!isUuid(id)) notFound();
  const level = accessLevelFor(viewer);
  const canWrite = permits(level, permissionsOf(level, viewer), 'tournaments.draw.checkin.mark.write');

  const adminClient = createAdminClient();
  const [{ data: tournament }, { data: eventData }] = await Promise.all([
    adminClient.from('tournaments').select('id, name').eq('id', id).maybeSingle(),
    adminClient.from('tournament_events').select('id, event_type, status').eq('tournament_id', id),
  ]);
  if (!tournament) notFound();
  const events = (eventData ?? []) as { id: string; event_type: TournamentEventType; status: string }[];
  const eventById = new Map(events.map((event) => [event.id, event]));
  const singlesIds = events.filter((event) => !isDoublesEvent(event.event_type)).map((event) => event.id);
  const doublesIds = events.filter((event) => isDoublesEvent(event.event_type)).map((event) => event.id);

  const [{ data: singlesData, error: singlesError }, { data: pairsData, error: pairsError }] = await Promise.all([
    singlesIds.length
      ? adminClient
          .from('tournament_participants')
          .select('id, event_id, status, player:players!player_id(full_name)')
          .in('event_id', singlesIds)
          .in('status', ['registered', 'checked_in'])
      : Promise.resolve({ data: [], error: null }),
    doublesIds.length
      ? adminClient
          .from('tournament_pairs')
          .select(
            'id, event_id, status, player1:players!tournament_pairs_player1_id_fkey(full_name), player2:players!tournament_pairs_player2_id_fkey(full_name)',
          )
          .in('event_id', doublesIds)
          .in('status', ['registered', 'checked_in'])
      : Promise.resolve({ data: [], error: null }),
  ]);
  // A failed read must not show as "nobody entered" at the door.
  if (singlesError || pairsError) {
    throw new Error('The entries could not be read. Refresh to try again.');
  }

  const label = (eventId: string) => {
    const event = eventById.get(eventId);
    return event ? TOURNAMENT_EVENT_TYPE_LABELS[event.event_type] : 'Event';
  };
  const rows: CheckInRow[] = [
    ...((singlesData ?? []) as unknown as { id: string; event_id: string; status: string; player: Name }[]).map(
      (row) => {
        const here = row.status === 'checked_in';
        return {
          key: `single:${row.id}`,
          name: nameOf(row.player),
          detail: label(row.event_id),
          here,
          blockedReason: closedReason(eventById.get(row.event_id)?.status ?? '', here),
        };
      },
    ),
    ...(
      (pairsData ?? []) as unknown as { id: string; event_id: string; status: string; player1: Name; player2: Name }[]
    ).map((row) => {
      const here = row.status === 'checked_in';
      return {
        key: `pair:${row.id}`,
        name: `${nameOf(row.player1)} / ${nameOf(row.player2)}`,
        detail: label(row.event_id),
        here,
        blockedReason: closedReason(eventById.get(row.event_id)?.status ?? '', here),
      };
    }),
  ];

  return (
    <div>
      <PageHeader
        eyebrow="CHECK-IN"
        title={tournament.name as string}
        sub={
          <Link href={`/tournaments/${id}`} className="hover:underline">
            Back to the tournament
          </Link>
        }
      />
      <Card className="p-0 pt-5">
        <TournamentCheckInBoard rows={rows} canWrite={canWrite} />
      </Card>
    </div>
  );
}
