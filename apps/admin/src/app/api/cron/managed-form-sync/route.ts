import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import { runManagedFormSync } from '@/lib/managed-forms';

export const dynamic = 'force-dynamic';

// Keeps the Google Forms the console made in step with their events (00296):
// content, choices, open or closed. Called by pg_cron every five minutes, like
// registration-form-poll. Without the form maker's address and secret it
// answers 200 with `skipped` and touches nothing; the logic is in
// lib/managed-forms.ts.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const run = await runManagedFormSync(createAdminClient());
    // Counts and row ids only.
    return NextResponse.json({ ran_at: new Date().toISOString(), ...run });
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'managed-form-sync' } });
    return NextResponse.json({ error: 'Managed form sync failed' }, { status: 500 });
  }
}
