import * as Sentry from '@sentry/nextjs';
import {
  ensureEntryFees,
  formatClubEventTime,
  readFeatureFlags,
  readReleaseFlags,
  sendEventConfirmationEmail,
  TOURNAMENT_EVENT_TYPE_LABELS,
} from '@badminton/shared';
import type { createAdminClient } from './supabase-server';
import { notifyPlayers, pushPlayers } from './notify';

// "CONFIRM YOUR PLACE" (00325), every five minutes from pg_cron. Three steps:
//
//   1. open: the database writes a request for every entrant of an event whose
//      confirmation window has opened;
//   2. ask: claim a batch, write the in-app row and push once, send the email,
//      and record the receipt. Claim before send, receipt after, as the
//      registration mail does (00283): a crash between the two is a retry,
//      never a drop;
//   3. release: past the deadline, an entry everyone of which was reached and
//      nobody confirmed is withdrawn, and the waitlist fills the place. The
//      database writes those notifications in the same transaction; this only
//      pushes to the promoted.
//
// NEVER A DISCORD DM. The owner's rule: email, push and the in-app row only.

type Admin = ReturnType<typeof createAdminClient>;

/** Per tick. The claim caps it at 50 as well. */
export const CONFIRM_BATCH = 20;
/** Events released per tick. */
export const RELEASE_BATCH = 10;

export interface EventConfirmationRun {
  opened: number;
  claimed: number;
  sent: number;
  suppressed: number;
  failed: number;
  released: number;
  promoted: number;
  skipped?: 'entry_confirmation_off' | 'tournaments_off' | 'migration_pending';
}

interface ClaimedRow {
  confirmation_id: string;
  player_id: string;
  email: string | null;
  first_name: string | null;
  tournament_id: string;
  tournament_name: string;
  event_id: string;
  event_type: string;
  deadline_at: string;
  already_notified: boolean;
}

function isRpcMissing(error: { code?: string } | null): boolean {
  return !!error && ['PGRST202', '42883'].includes(error.code ?? '');
}

function eventUrl(tournamentId: string, eventId: string): string {
  const base = (process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/tournaments/${tournamentId}/events/${eventId}`;
}

export function confirmUrl(tournamentId: string, eventId: string): string {
  return `${eventUrl(tournamentId, eventId)}/confirm`;
}

/** A short reason for the receipt. Never an address. */
function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[^\s@]+@[^\s@]+/g, '[address]').slice(0, 200);
}

async function receipt(admin: Admin, id: string, notified: boolean, outcome: 'sent' | 'suppressed' | 'failed', error?: string) {
  const { error: receiptError } = await admin.rpc('record_event_confirmation_receipt', {
    p_id: id,
    p_notified: notified,
    p_outcome: outcome,
    p_error: error ?? null,
  });
  // Not fatal: a sent mail with no receipt is retried once the claim is stale,
  // a duplicate and never a drop.
  if (receiptError) {
    Sentry.captureException(new Error(`Event confirmation receipt failed: ${receiptError.message}`), {
      extra: { job: 'event-confirmations', id },
    });
  }
}

export async function runEventConfirmations(admin: Admin): Promise<EventConfirmationRun> {
  const run: EventConfirmationRun = { opened: 0, claimed: 0, sent: 0, suppressed: 0, failed: 0, released: 0, promoted: 0 };

  // A failed read of either is "on", as everywhere else: the release is the
  // only step that takes anything away, and it waits for a reached member.
  if (!(await readReleaseFlags(admin)).entry_confirmation) return { ...run, skipped: 'entry_confirmation_off' };
  if (!(await readFeatureFlags(admin)).tournaments) return { ...run, skipped: 'tournaments_off' };

  const { data: opened, error: openError } = await admin.rpc('open_event_confirmations');
  if (isRpcMissing(openError)) return { ...run, skipped: 'migration_pending' };
  if (openError) throw new Error(`Could not open event confirmations: ${openError.message}`);
  run.opened = (opened as number | null) ?? 0;

  const { data: claimedRows, error: claimError } = await admin.rpc('claim_event_confirmation_requests', {
    p_limit: CONFIRM_BATCH,
  });
  if (claimError) throw new Error(`Could not claim event confirmations: ${claimError.message}`);
  for (const row of (claimedRows ?? []) as ClaimedRow[]) {
    run.claimed += 1;
    const eventLabel = (TOURNAMENT_EVENT_TYPE_LABELS as Record<string, string>)[row.event_type] ?? row.event_type;
    const deadlineText = formatClubEventTime(row.deadline_at);
    const url = confirmUrl(row.tournament_id, row.event_id);

    // The in-app row and the push once only: a retried email must not ring
    // the bell a second time.
    let notified = row.already_notified;
    if (!notified) {
      const { delivered } = await notifyPlayers(
        admin,
        [row.player_id],
        {
          type: 'general',
          title: 'Confirm your place',
          body: `${eventLabel} at ${row.tournament_name}: confirm by ${deadlineText} or your place goes to the waitlist.`,
          metadata: { kind: 'entry_confirmation', event_id: row.event_id, tournament_id: row.tournament_id },
        },
        { title: 'Confirm your place', body: `${eventLabel} at ${row.tournament_name}, by ${deadlineText}`, url },
        'tournaments',
      );
      notified = delivered.includes(row.player_id);
    }

    if (!row.email) {
      run.suppressed += 1;
      await receipt(admin, row.confirmation_id, notified, 'suppressed', 'no_address');
      continue;
    }
    try {
      const outcome = await sendEventConfirmationEmail(row.email, {
        firstName: row.first_name,
        tournamentName: row.tournament_name,
        eventLabel,
        deadlineText,
        url,
      });
      if (outcome.sent) {
        run.sent += 1;
        await receipt(admin, row.confirmation_id, notified, 'sent');
      } else {
        run.suppressed += 1;
        await receipt(admin, row.confirmation_id, notified, 'suppressed', outcome.reason);
      }
    } catch (err) {
      run.failed += 1;
      Sentry.captureException(err, { extra: { job: 'event-confirmations', id: row.confirmation_id } });
      await receipt(admin, row.confirmation_id, notified, 'failed', shortReason(err));
    }
  }

  const { data: releaseData, error: releaseError } = await admin.rpc('release_unconfirmed_event_entries', {
    p_limit: RELEASE_BATCH,
  });
  if (releaseError) throw new Error(`Could not release unconfirmed entries: ${releaseError.message}`);
  const events = ((releaseData as { events?: unknown[] } | null)?.events ?? []) as Array<{
    event_id: string;
    tournament_id: string;
    released: unknown[];
    promoted: Array<{ player_id: string }>;
  }>;
  for (const event of events) {
    run.released += (event.released ?? []).length;
    const promotedIds = (event.promoted ?? []).map((p) => p.player_id);
    if (promotedIds.length === 0) continue;
    run.promoted += promotedIds.length;
    // A promotion is an entry like any other: it owes the entry fee.
    await ensureEntryFees(admin as never, event.tournament_id, promotedIds);
    await pushPlayers(
      admin,
      promotedIds,
      { title: 'You are in', body: 'A place opened up and you were moved off the waitlist.', url: eventUrl(event.tournament_id, event.event_id) },
      'tournaments',
    );
  }
  return run;
}
