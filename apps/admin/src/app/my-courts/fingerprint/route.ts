import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { requireConsoleUser } from '@/lib/court-helper-gate';
import { readMyCourtsFingerprint } from '@/lib/live-fingerprint';

export const dynamic = 'force-dynamic';

/**
 * My courts' change probe (quiet_refresh), behind the page's own gate. It
 * takes nothing from the client: the courts are the viewer's helper rows.
 */
export async function GET() {
  const { viewer } = await requireConsoleUser();
  const fingerprint = await readMyCourtsFingerprint(createAdminClient(), viewer.id as string);
  return NextResponse.json({ fingerprint }, { headers: { 'Cache-Control': 'no-store' } });
}
