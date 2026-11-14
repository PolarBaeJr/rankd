import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import { runEventConfirmations } from '@/lib/event-confirmations';

export const dynamic = 'force-dynamic';

// Asks entrants to confirm their place before the day, and releases the places
// nobody confirmed (00325). Called by pg_cron every five minutes, like the
// registration mail; the steps, and why the claim comes before the send, are
// in lib/event-confirmations.ts.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const run = await runEventConfirmations(createAdminClient());
    return NextResponse.json({ ran_at: new Date().toISOString(), ...run });
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'event-confirmations' } });
    return NextResponse.json({ error: 'Event confirmations job failed' }, { status: 500 });
  }
}
