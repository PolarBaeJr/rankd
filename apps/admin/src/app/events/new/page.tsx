export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { PageHeader } from '@badminton/ui';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { ClubEventForm } from '../event-form';

export default async function NewClubEventPage() {
  await requireCapability('events.manage.create.write');
  // Whether 00312's column exists yet. Before it does the form leaves the
  // waitlist limit out.
  const { error: limitError } = await createAdminClient()
    .from('club_events')
    .select('waitlist_limit' as never)
    .limit(0);
  return (
    <div>
      <PageHeader
        eyebrow="EVENTS"
        title="New club event"
        sub={<Link href="/events" className="hover:underline">Back to club events</Link>}
      />
      <ClubEventForm waitlistLimitReady={!limitError} />
    </div>
  );
}
