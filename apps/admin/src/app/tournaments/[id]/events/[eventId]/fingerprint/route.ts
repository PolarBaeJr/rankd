import { NextResponse } from 'next/server';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { readEventFingerprint } from '@/lib/live-fingerprint';

export const dynamic = 'force-dynamic';

/**
 * The event page's change probe (quiet_refresh): the fingerprint of what the
 * page shows, behind the page's own gate. A GET route and not a server action,
 * because Next runs server actions one at a time and a probe every few seconds
 * would queue in front of a save.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  await requireCapability('tournaments.page');

  const { id, eventId } = await params;
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(id) || !uuid.test(eventId)) return new NextResponse('Not found', { status: 404 });
  const fingerprint = await readEventFingerprint(createAdminClient(), id, eventId);
  return NextResponse.json({ fingerprint }, { headers: { 'Cache-Control': 'no-store' } });
}
