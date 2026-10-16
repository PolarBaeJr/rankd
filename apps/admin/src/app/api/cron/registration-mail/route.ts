import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import { runRegistrationMail } from '@/lib/registration-mail';

export const dynamic = 'force-dynamic';

// Sends the mail Google Form registrations cause (00283): members' "confirm
// your entry" emails and non-members' guest waiver invites. Called by pg_cron
// every five minutes, like the session reminders; the logic, the throttles and
// why the claim comes before the send are in lib/registration-mail.ts.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const run = await runRegistrationMail(createAdminClient());
    return NextResponse.json({ ran_at: new Date().toISOString(), ...run });
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'registration-mail' } });
    return NextResponse.json({ error: 'Registration mail job failed' }, { status: 500 });
  }
}
