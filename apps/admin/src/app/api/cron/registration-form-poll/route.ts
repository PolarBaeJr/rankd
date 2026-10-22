import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import { runRegistrationFormPoll } from '@/lib/registration-form-poll';
import { sweepReceiptChecks } from '@badminton/shared/src/utils/receipt-check';
import { serverReceiptOcr } from '@/lib/receipt-ocr-server';

export const dynamic = 'force-dynamic';

// Reads the Google Forms bound with a question mapping and imports their new
// and edited responses (00287). Called by pg_cron every five minutes, like
// registration-mail. Without the service account key it answers 200 with
// `skipped` and touches nothing; the logic is in lib/registration-form-poll.ts.
//
// Then, whatever the poll did, the receipts still queued for the server's own
// read (00297): a Google Form's, and any member's whose check right after
// filing never finished. One at a time, a few a round.
const RECEIPT_CHECKS_PER_ROUND = 5;
const RECEIPT_CHECK_BUDGET_MS = 60_000;

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let run: Awaited<ReturnType<typeof runRegistrationFormPoll>> | null = null;
  let failed = false;
  try {
    run = await runRegistrationFormPoll(createAdminClient());
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'registration-form-poll' } });
    failed = true;
  }
  let receiptChecks: Record<string, number> | null = null;
  try {
    receiptChecks = await sweepReceiptChecks(createAdminClient(), serverReceiptOcr, {
      deadline: Date.now() + RECEIPT_CHECK_BUDGET_MS,
      limit: RECEIPT_CHECKS_PER_ROUND,
    });
  } catch (err) {
    // The RPC's message only: nothing read off a screenshot is in it.
    Sentry.captureException(err, { extra: { job: 'receipt-check-sweep' } });
  }
  if (failed) return NextResponse.json({ error: 'Form poll job failed', receipt_checks: receiptChecks }, { status: 500 });
  // Counts and binding ids only: no answer or address is in the run.
  return NextResponse.json({ ran_at: new Date().toISOString(), ...run, receipt_checks: receiptChecks });
}
