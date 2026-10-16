import * as Sentry from '@sentry/nextjs';
import { escapeHtml, readFeatureFlags, sendEmail, TOURNAMENT_EVENT_TYPE_LABELS } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';

// THE MAIL A GOOGLE FORM RESPONSE CAUSES (00283, 00284). Two kinds:
//
//   - a member's "confirm your entry" email, to the address on their ACCOUNT,
//     never the one typed into the form, pointing at /registrations/<entry>;
//   - a non-member's guest waiver invite, to the address the form gave, held
//     while the guest_waivers feature is off.
//
// Claim, send, receipt, as the session reminder job does (00195): the claim is
// taken in the database before the send and the receipt written after, so a
// crash between the two leaves a row the next tick retries rather than one
// silently dropped. The throttles (three attempts, two invites per address per
// day, a daily cap in all) live in the claim functions, not here.
//
// Every address passes the suppression list first. A non-member never opted
// in to anything, so an address that bounced or complained is never mailed
// again, and a failed suppression read refuses the send rather than guessing.

type Admin = ReturnType<typeof createAdminClient>;

/** Per tick, of each kind. The claim functions cap it at 50 as well. */
export const MAIL_BATCH = 20;
/** Guest waiver invites sent in any 24 hours, across the club. */
export const INVITE_DAILY_CAP = 40;

export interface RegistrationMailRun {
  confirmations: { claimed: number; sent: number; failed: number; suppressed: number };
  invites: { claimed: number; sent: number; failed: number; suppressed: number; skipped?: 'guest_waivers_off' };
}

function appUrl(path: string): string {
  return `${(process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000').replace(/\/$/, '')}${path}`;
}

const STYLE = 'font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #18181b; line-height: 1.5;';
const BUTTON =
  'display: inline-block; padding: 10px 18px; background: #a6192e; color: #ffffff; text-decoration: none; border-radius: 8px;';

/** Subjects are headers: no CR or LF from a typed name. */
function subjectLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 150);
}

export function confirmEmail(row: {
  entry_id: string;
  first_name: string | null;
  target_name: string | null;
  event_type: string | null;
}): { subject: string; html: string } {
  const target = row.target_name ?? 'a club event';
  const event = row.event_type
    ? ((TOURNAMENT_EVENT_TYPE_LABELS as Record<string, string>)[row.event_type] ?? row.event_type)
    : null;
  const url = appUrl(`/registrations/${row.entry_id}`);
  return {
    subject: subjectLine(`Confirm your entry: ${target}`),
    html: `<div style="${STYLE}">
<p>Hi ${escapeHtml(row.first_name ?? 'there')},</p>
<p>A response to the club's sign-up form for <strong>${escapeHtml(target)}</strong>${event ? ` (${escapeHtml(event)})` : ''} used your email address. You are not entered yet.</p>
<p>If it was you, confirm in the app and you are entered the same way as signing up there. If it was not you, say so on the same page and the club is told.</p>
<p><a href="${escapeHtml(url)}" style="${BUTTON}">Review the entry</a></p>
<p style="color: #71717a; font-size: 13px;">Club Ladder</p>
</div>`,
  };
}

export function inviteEmail(row: {
  target_name: string | null;
  target_starts: string | null;
}): { subject: string; html: string } {
  const target = row.target_name ?? 'a club event';
  const url = appUrl('/guest-waiver');
  return {
    subject: subjectLine(`Sign the guest waiver before ${target}`),
    html: `<div style="${STYLE}">
<p>Hello,</p>
<p>You are entered in <strong>${escapeHtml(target)}</strong>${row.target_starts ? ` on ${escapeHtml(row.target_starts)}` : ''} through the club's sign-up form. Before you play, please sign the club's guest waiver. It takes a minute and needs no account.</p>
<p><a href="${escapeHtml(url)}" style="${BUTTON}">Sign the guest waiver</a></p>
<p>If you did not sign up for this, you can ignore this email. You will not be emailed about it more than twice.</p>
<p style="color: #71717a; font-size: 13px;">Club Ladder</p>
</div>`,
  };
}

/** True when the address must not be mailed. Throws when the list cannot be read. */
async function isSuppressed(admin: Admin, email: string): Promise<boolean> {
  const { data, error } = await admin
    .from('email_suppressions')
    .select('email')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`Suppression check failed, refusing to send: ${error.message}`);
  return !!data;
}

/** A short reason for the receipt. Never an address. */
function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[^\s@]+@[^\s@]+/g, '[address]').slice(0, 200);
}

async function receipt(admin: Admin, kind: 'registration_confirm' | 'guest_waiver_invite', id: string, sent: boolean, error?: string) {
  const { error: receiptError } = await admin.rpc('record_registration_mail_receipt', {
    p_kind: kind,
    p_id: id,
    p_sent: sent,
    p_error: error ?? null,
  });
  // Not fatal. A sent mail with no receipt is retried after the claim goes
  // stale, which is a duplicate, never a drop.
  if (receiptError) {
    Sentry.captureException(new Error(`Registration mail receipt failed: ${receiptError.message}`), {
      extra: { job: 'registration-mail', kind, id },
    });
  }
}

export async function runRegistrationMail(admin: Admin): Promise<RegistrationMailRun> {
  const run: RegistrationMailRun = {
    confirmations: { claimed: 0, sent: 0, failed: 0, suppressed: 0 },
    invites: { claimed: 0, sent: 0, failed: 0, suppressed: 0 },
  };

  const { data: confirmRows, error: confirmError } = await admin.rpc('claim_registration_confirm_emails', {
    p_limit: MAIL_BATCH,
  });
  if (confirmError) throw new Error(`Could not claim confirmation emails: ${confirmError.message}`);
  for (const row of (confirmRows ?? []) as {
    entry_id: string;
    email: string;
    first_name: string | null;
    target_name: string | null;
    event_type: string | null;
  }[]) {
    run.confirmations.claimed += 1;
    try {
      if (await isSuppressed(admin, row.email)) {
        run.confirmations.suppressed += 1;
        await receipt(admin, 'registration_confirm', row.entry_id, false, 'suppressed');
        continue;
      }
      const mail = confirmEmail(row);
      await sendEmail(row.email, mail.subject, mail.html);
      run.confirmations.sent += 1;
      await receipt(admin, 'registration_confirm', row.entry_id, true);
    } catch (err) {
      run.confirmations.failed += 1;
      Sentry.captureException(err, { extra: { job: 'registration-mail', kind: 'registration_confirm', id: row.entry_id } });
      await receipt(admin, 'registration_confirm', row.entry_id, false, shortReason(err));
    }
  }

  // Invites wait for the feature: the page they point at is gated on it. A
  // failed flag read is treated as off here, the opposite of the session
  // reminders, because the cost of a wrong guess is mailing a stranger a link
  // to a page that says it is switched off.
  let invitesOn = false;
  try {
    invitesOn = (await readFeatureFlags(admin)).guest_waivers === true;
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'registration-mail', read: 'feature_flags' } });
  }
  if (!invitesOn) {
    run.invites.skipped = 'guest_waivers_off';
    return run;
  }

  const { data: inviteRows, error: inviteError } = await admin.rpc('claim_guest_waiver_invites', {
    p_limit: MAIL_BATCH,
    p_daily_cap: INVITE_DAILY_CAP,
  });
  if (inviteError) throw new Error(`Could not claim guest waiver invites: ${inviteError.message}`);
  for (const row of (inviteRows ?? []) as {
    id: string;
    email: string;
    target_name: string | null;
    target_starts: string | null;
  }[]) {
    run.invites.claimed += 1;
    try {
      if (await isSuppressed(admin, row.email)) {
        run.invites.suppressed += 1;
        await receipt(admin, 'guest_waiver_invite', row.id, false, 'suppressed');
        continue;
      }
      const mail = inviteEmail(row);
      await sendEmail(row.email, mail.subject, mail.html);
      run.invites.sent += 1;
      await receipt(admin, 'guest_waiver_invite', row.id, true);
    } catch (err) {
      run.invites.failed += 1;
      Sentry.captureException(err, { extra: { job: 'registration-mail', kind: 'guest_waiver_invite', id: row.id } });
      await receipt(admin, 'guest_waiver_invite', row.id, false, shortReason(err));
    }
  }
  return run;
}
