import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import { runRegistrationFormPoll } from '@/lib/registration-form-poll';

export const dynamic = 'force-dynamic';

// Reads the Google Forms bound with a question mapping and imports their new
// and edited responses (00287). Called by pg_cron every five minutes, like
// registration-mail. Without the service account key it answers 200 with
// `skipped` and touches nothing; the logic is in lib/registration-form-poll.ts.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const run = await runRegistrationFormPoll(createAdminClient());
    // Counts and binding ids only: no answer or address is in the run.
    return NextResponse.json({ ran_at: new Date().toISOString(), ...run });
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'registration-form-poll' } });
    return NextResponse.json({ error: 'Form poll job failed' }, { status: 500 });
  }
}
