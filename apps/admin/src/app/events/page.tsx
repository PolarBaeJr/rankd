export const dynamic = 'force-dynamic';
import Link from 'next/link';
import {
  CLUB_EVENT_KIND_LABELS,
  PAST_CLUB_EVENTS_SHOWN,
  formatClubEventTime,
  selectAllInChunks,
  type ClubEventKind,
} from '@badminton/shared';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { RowLink } from '@/components/row-link';
import { Badge, Card, EmptyState, PageHeader, ResponsiveTable, TableCard } from '@badminton/ui';

// CLUB EVENTS THAT ARE NOT TOURNAMENTS (00244). Admin-only by level today: no
// baseline holds events.page, so the route gate and this re-check agree.

type EventRow = {
  id: string;
  title: string;
  kind: ClubEventKind;
  starts_at: string;
  status: string;
  capacity: number | null;
};

const EVENT_COLUMNS = 'id, title, kind, starts_at, status, capacity';

export default async function ClubEventsPage() {
  const viewer = await requireCapability('events.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const canCreate = permits(level, permissions, 'events.manage.create.write');

  const adminClient = createAdminClient();
  const nowIso = new Date().toISOString();

  const [{ data: upcomingRows }, { data: pastRows }] = await Promise.all([
    adminClient
      .from('club_events')
      .select(EVENT_COLUMNS)
      .gte('starts_at', nowIso)
      .order('starts_at', { ascending: true }),
    adminClient
      .from('club_events')
      .select(EVENT_COLUMNS)
      .lt('starts_at', nowIso)
      .order('starts_at', { ascending: false })
      .limit(PAST_CLUB_EVENTS_SHOWN),
  ]);
  const upcoming = (upcomingRows ?? []) as EventRow[];
  const past = (pastRows ?? []) as EventRow[];

  const ids = [...upcoming, ...past].map((e) => e.id);
  const { data: signupRows } = await selectAllInChunks<{ event_id: string }>(ids, (batch, from, to) =>
    adminClient
      .from('club_event_signups')
      .select('event_id')
      .in('event_id', batch)
      .order('event_id')
      .order('player_id')
      .range(from, to),
  );
  const taken = new Map<string, number>();
  for (const row of signupRows ?? []) taken.set(row.event_id, (taken.get(row.event_id) ?? 0) + 1);
  // The places as the sign-up RPC counts them (form guests in, no-shows out,
  // 00294), so this list agrees with the event page. The row count stands if
  // the RPC is unavailable.
  await Promise.all(
    ids.map(async (id) => {
      const { data, error } = await adminClient.rpc('club_event_taken' as never, { p_event_id: id } as never);
      if (!error && typeof data === 'number') taken.set(id, data);
    }),
  );

  return (
    <div>
      <PageHeader
        eyebrow="EVENTS"
        title="Club events"
        sub="Socials, workshops, clinics, outings and the AGM"
        actions={
          canCreate ? (
            <Link
              href="/events/new"
              className="inline-flex min-h-[40px] items-center justify-center whitespace-nowrap border border-transparent bg-[var(--red)] px-4 text-[11px] font-bold uppercase tracking-[0.16em] text-white transition-colors hover:bg-[var(--red-ink)]"
            >
              New event
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-5">
        <div data-tour="events-upcoming">
          <EventTable title="Upcoming" rows={upcoming} taken={taken} empty="Nothing is coming up." />
        </div>
        <EventTable title="Past" rows={past} taken={taken} empty="No club events have happened yet." />
      </div>
    </div>
  );
}

function EventTable({
  title,
  rows,
  taken,
  empty,
}: {
  title: string;
  rows: EventRow[];
  taken: Map<string, number>;
  empty: string;
}) {
  return (
    <Card className="p-0">
      <h2
        className="px-5 pb-4 pt-5 text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]"
        style={{ fontFamily: 'var(--display)' }}
      >
        {title}
      </h2>
      {rows.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyState title={empty} />
        </div>
      ) : (
        <ResponsiveTable
          cards={rows.map((row) => (
            <TableCard
              key={row.id}
              title={<Link href={`/events/${row.id}`}>{row.title}</Link>}
              badges={<StatusBadge status={row.status} />}
              fields={[
                { label: 'Kind', value: CLUB_EVENT_KIND_LABELS[row.kind] ?? row.kind },
                { label: 'Starts', value: formatClubEventTime(row.starts_at) },
                { label: 'Places', value: <Places row={row} taken={taken.get(row.id) ?? 0} /> },
              ]}
            />
          ))}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--line)]">
                <Th>Event</Th>
                <Th>Kind</Th>
                <Th>Starts</Th>
                <Th>Status</Th>
                <Th className="text-right">Places</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RowLink
                  key={row.id}
                  href={`/events/${row.id}`}
                  className="cursor-pointer border-b border-[var(--line)] transition-colors last:border-0 hover:bg-[var(--line)]"
                >
                  <td className="px-5 py-3.5 text-sm text-[var(--ink)]">
                    <Link href={`/events/${row.id}`} className="hover:underline">
                      {row.title}
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-[var(--ink-2)]">
                    {CLUB_EVENT_KIND_LABELS[row.kind] ?? row.kind}
                  </td>
                  <td className="px-5 py-3.5 font-mono text-xs text-[var(--ink-2)]">
                    {formatClubEventTime(row.starts_at)}
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-5 py-3.5 text-right font-mono text-xs text-[var(--ink-2)]">
                    <Places row={row} taken={taken.get(row.id) ?? 0} />
                  </td>
                </RowLink>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </Card>
  );
}

// Shrinking capacity below the sign-ups is allowed and removes nobody, so the
// overflow is said out loud rather than left as a number bigger than the cap.
function Places({ row, taken }: { row: EventRow; taken: number }) {
  if (row.capacity === null) return <>{taken} signed up</>;
  return (
    <>
      {taken} / {row.capacity}
      {taken > row.capacity && (
        <span className="ml-2">
          <Badge variant="warning">Over capacity</Badge>
        </span>
      )}
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'published') return <Badge variant="success">Published</Badge>;
  if (status === 'cancelled') return <Badge variant="danger">Cancelled</Badge>;
  return <Badge variant="neutral">Draft</Badge>;
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-5 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--mute)] ${className ?? ''}`}
    >
      {children}
    </th>
  );
}
