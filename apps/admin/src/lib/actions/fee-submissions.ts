'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  ETRANSFER_REFERENCE_PATTERN,
  ExpectedError,
  SFU_REC_REFERENCE_PATTERN,
  isHiddenEtransferReference,
  normaliseReference,
  RECEIPT_METHODS,
  formatPaymentMethod,
  isReceiptMethod,
  parseOrThrow,
  readFeatureFlags,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { notifyPlayers } from '../notify';
import { runAction, type ActionResult } from '../action-result';
import { duesFor, loadOutstandingMembers, submissionCapability } from '../fee-submissions';

// RECEIPTS (00248, 00253): an exec confirms or rejects what a member sent,
// and reminds members who have not sent one.
//
// EVERY EXPORTED PARAMETER IS A CLIENT-CONTROLLED POST FIELD. Ids are
// shape-checked; who may settle a receipt is decided from the fee it points at,
// read here, never from anything the browser says about it. The settling
// itself is one locked RPC (review_fee_submission_confirm), so two execs
// confirming at once cannot both write.
//
// How it was paid is the method stored on the submission, which the member's
// browser read off the receipt. The exec's pick is read only when none was
// stored; a wrong stored method is corrected with Mark unpaid, then Mark paid.
// The reference is the same: a receipt a Google Form collected (00288) has
// none, and the exec's typed one is read only then.
//
// A receipt the server read and confirmed by itself (00297) can be put back
// to waiting with undoAutoConfirmedSubmission, for an ordinary review.
//
// A form receipt belongs to somebody who may have no account, so the purge
// cannot reach its screenshot by player. "Erase screenshot" removes it on
// request (a non-member writing to the privacy address), leaving the
// submission and the fee as the club's record of the payment.

type SubmissionRow = {
  id: string;
  club_fee_id: string;
  player_id: string | null;
  status: string;
  method: string | null;
  reference: string | null;
  screenshot_path: string | null;
  import_receipt_id: string | null;
};
type FeeRow = { id: string; fee_type: string; tournament_id: string | null; amount_cents: number | null };

const NOT_FOUND = 'That receipt no longer exists.';

const REVIEW_REFUSALS: Record<string, string> = {
  not_found: NOT_FOUND,
  not_pending: 'That receipt has already been reviewed.',
  already_paid: 'That fee is already settled. The receipt was left as it is.',
  no_amount: 'That fee has no amount recorded. Record one before confirming.',
  bad_amount: 'The amount paid must be more than $0.00 and at most $10,000.00, in whole cents.',
  bad_reason: 'Give a reason of 3 to 500 characters.',
  needs_method: 'Say how this was paid before confirming.',
  bad_method: 'That is not how this fee can be paid. Only membership dues are sold on the SFU Rec website.',
  short_reference: 'That reference is too short for an e-transfer, which has 6 to 32 characters. A 4 or 5 character number is an SFU Rec receipt.',
  needs_reference: 'Type the reference from the screenshot before confirming.',
  bad_reference: 'A reference is 4 to 32 letters, digits and hyphens, or an e-transfer number as the bank shows it.',
};

const UNDO_REFUSALS: Record<string, string> = {
  not_found: NOT_FOUND,
  not_auto: 'That receipt was not confirmed automatically, or has already been undone.',
  bad_reason: 'Give a reason of 3 to 500 characters.',
  fee_changed: 'That fee has been changed since it was confirmed. Mark it unpaid from the fee instead.',
  pending_exists: 'Another receipt for that fee is already waiting. Review that one first.',
};

/** The submission, its fee, and the capability that settles it, checked. */
async function authorise(id: string) {
  parseOrThrow(z.string().uuid(), id);
  const adminClient = createAdminClient();
  const { data: sub, error } = await adminClient
    .from('fee_submissions')
    .select('id, club_fee_id, player_id, status, method, reference, screenshot_path, import_receipt_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not read that receipt: ${error.message}`);
  const { data: fee, error: feeError } = sub
    ? await adminClient
        .from('club_fees')
        .select('id, fee_type, tournament_id, amount_cents')
        .eq('id', (sub as SubmissionRow).club_fee_id)
        .maybeSingle()
    : { data: null, error: null };
  if (feeError) throw new Error(`Could not read that fee: ${feeError.message}`);
  const capability = submissionCapability((fee as FeeRow | null)?.fee_type);
  // Nothing to find, or a fee no receipt settles: asked of the club-fee
  // capability, so a caller holding nothing learns nothing about which ids
  // exist.
  const actor = await requireCapability(capability ?? 'fees.clubfees.markpaid.write');
  if (!sub || !fee) throw new ExpectedError(NOT_FOUND);
  if (!capability) throw new ExpectedError('This fee is not settled by receipt.');
  return { adminClient, actor, sub: sub as SubmissionRow, fee: fee as FeeRow };
}

function revalidate(fee: FeeRow) {
  revalidatePath('/fees');
  revalidatePath('/finances');
  if (fee.tournament_id) revalidatePath(`/tournaments/${fee.tournament_id}/fees`);
}

export async function confirmFeeSubmission(
  id: string,
  method?: string,
  reference?: string,
  amountCents?: number,
): Promise<ActionResult> {
  return runAction(() => confirmImpl(id, method, reference, amountCents));
}

async function confirmImpl(id: string, method?: string, reference?: string, amountCents?: number): Promise<void> {
  const picked = parseOrThrow(z.enum(RECEIPT_METHODS).optional(), method);
  // What the exec says was paid, when it is not the fee (00300). Omitted keeps
  // the fee's own amount.
  const paid = parseOrThrow(
    z
      .number()
      .int(REVIEW_REFUSALS.bad_amount!)
      .positive(REVIEW_REFUSALS.bad_amount!)
      .max(1_000_000, REVIEW_REFUSALS.bad_amount!)
      .optional(),
    amountCents,
  );
  const typed = parseOrThrow(
    z
      .string()
      .transform(normaliseReference)
      .pipe(
        z
          .string()
          .refine((v) => SFU_REC_REFERENCE_PATTERN.test(v) || isHiddenEtransferReference(v), REVIEW_REFUSALS.bad_reference!),
      )
      .optional(),
    reference === '' ? undefined : reference,
  );
  const { adminClient, actor, sub, fee } = await authorise(id);
  const effective = isReceiptMethod(sub.method) ? sub.method : picked;
  if (!effective) throw new ExpectedError(REVIEW_REFUSALS.needs_method!);
  if (effective === 'sfu_rec' && fee.fee_type !== 'dues') {
    throw new ExpectedError(REVIEW_REFUSALS.bad_method!);
  }
  const effectiveReference = sub.reference ?? typed ?? null;
  // A Form receipt may have none: some banks' screens show no reference (00298).
  if (!effectiveReference && !sub.import_receipt_id) throw new ExpectedError(REVIEW_REFUSALS.needs_reference!);
  if (
    effectiveReference &&
    effective === 'e_transfer' &&
    !ETRANSFER_REFERENCE_PATTERN.test(effectiveReference) &&
    !isHiddenEtransferReference(effectiveReference)
  ) {
    throw new ExpectedError(REVIEW_REFUSALS.short_reference!);
  }
  const { data, error } = await adminClient.rpc('review_fee_submission_confirm', {
    p_submission_id: sub.id,
    p_actor: actor.id,
    p_method: effective,
    p_reference: sub.reference ? null : effectiveReference,
    // Only when given, so an ordinary approval is the call it always was.
    ...(paid !== undefined ? { p_amount_cents: paid } : {}),
  });
  if (error) throw new Error(`The receipt was not confirmed: ${error.message}`);
  if (data !== 'ok') throw new ExpectedError(REVIEW_REFUSALS[data as string] ?? 'The receipt was not confirmed.');

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'fee_submission_confirmed',
      target_type: 'club_fee',
      target_id: fee.id,
      old_value: { paid: false },
      new_value: { paid: true, method: effective, fee_submission_id: sub.id, amount_cents: paid ?? fee.amount_cents },
      reason: `Receipt confirmed (${formatPaymentMethod(effective)})`,
    },
    { submissionId: sub.id },
  );
  revalidate(fee);
}

/**
 * Puts a receipt the server confirmed by itself (00297) back to waiting, and
 * the fee back to unpaid, for an ordinary review. Needs the capability that
 * marks the fee unpaid as well as the one that settles it. The RPC refuses
 * once anybody has marked the fee since ('fee_changed'), and writes its own
 * audit row in the same transaction.
 */
export async function undoAutoConfirmedSubmission(id: string, reason: string): Promise<ActionResult> {
  return runAction(() => undoImpl(id, reason));
}

async function undoImpl(id: string, reason: string): Promise<void> {
  const why = parseOrThrow(
    z.string().trim().min(3, 'Give a reason of at least 3 characters').max(500, 'Keep the reason to 500 characters'),
    reason ?? '',
  );
  const { adminClient, sub, fee } = await authorise(id);
  const actor = await requireCapability(
    fee.fee_type === 'tournament' ? 'tournaments.fees.markunpaid.write' : 'fees.clubfees.markunpaid.write',
  );
  const { data, error } = await adminClient.rpc('undo_auto_confirmed_fee_submission', {
    p_submission_id: sub.id,
    p_actor: actor.id,
    p_reason: why,
  });
  if (error) throw new Error(`The confirmation was not undone: ${error.message}`);
  if (data !== 'ok') throw new ExpectedError(UNDO_REFUSALS[data as string] ?? 'The confirmation was not undone.');
  revalidate(fee);
}

export async function rejectFeeSubmission(id: string, reason: string): Promise<ActionResult> {
  return runAction(() => rejectImpl(id, reason));
}

async function rejectImpl(id: string, reason: string): Promise<void> {
  const why = parseOrThrow(
    z.string().trim().min(3, 'Give a reason of at least 3 characters').max(500, 'Keep the reason to 500 characters'),
    reason ?? '',
  );
  const { adminClient, actor, sub, fee } = await authorise(id);
  const { data, error } = await adminClient.rpc('review_fee_submission_reject', {
    p_submission_id: sub.id,
    p_actor: actor.id,
    p_reason: why,
  });
  if (error) throw new Error(`The receipt was not rejected: ${error.message}`);
  if (data !== 'ok') throw new ExpectedError(REVIEW_REFUSALS[data as string] ?? 'The receipt was not rejected.');

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'fee_submission_rejected',
      target_type: 'club_fee',
      target_id: fee.id,
      old_value: { status: 'submitted' },
      new_value: { status: 'rejected', fee_submission_id: sub.id },
      reason: `E-transfer receipt rejected: ${why}`,
    },
    { submissionId: sub.id },
  );

  // Best-effort by notifyPlayers' own contract: the rejection stands whether
  // or not the bell row commits. In-app only. A non-member's form receipt
  // (00288) has nobody to notify.
  if (sub.player_id) {
    await notifyPlayers(adminClient, [sub.player_id], {
      type: 'general',
      title: 'Your payment receipt was not accepted',
      body: why,
      metadata: { kind: 'fee_submission_rejected', fee_submission_id: sub.id },
    });
  }
  revalidate(fee);
}

const PROOF_BUCKET = 'fee-proofs';

/**
 * Erases the screenshot of a receipt a Google Form collected (00288): the
 * object in fee-proofs, and every path to it on the submissions from that
 * upload and on the upload's own record. The submissions and the fee stay.
 * Removed before the paths are nulled, as eraseFeeProofs does, so a failed
 * removal leaves the paths to try again with. The id is the only input.
 */
export async function eraseFormReceiptScreenshot(id: string): Promise<ActionResult> {
  return runAction(() => eraseImpl(id));
}

async function eraseImpl(id: string): Promise<void> {
  const { adminClient, actor, sub, fee } = await authorise(id);
  if (!sub.import_receipt_id) {
    throw new ExpectedError('Only a screenshot sent through a Google Form is erased here.');
  }

  const [siblings, upload] = await Promise.all([
    adminClient
      .from('fee_submissions')
      .select('id, screenshot_path')
      .eq('import_receipt_id', sub.import_receipt_id)
      .not('screenshot_path', 'is', null),
    adminClient
      .from('registration_import_receipts')
      .select('id, storage_path')
      .eq('id', sub.import_receipt_id)
      .maybeSingle(),
  ]);
  if (siblings.error) throw new Error(`Could not read the receipt's screenshots: ${siblings.error.message}`);
  if (upload.error) throw new Error(`Could not read the form upload: ${upload.error.message}`);
  const paths = new Set<string>(
    ((siblings.data ?? []) as { screenshot_path: string }[]).map((row) => row.screenshot_path),
  );
  const stored = (upload.data as { storage_path: string | null } | null)?.storage_path;
  if (stored) paths.add(stored);
  if (paths.size === 0) throw new ExpectedError('That screenshot has already been erased.');

  const { error: removeError } = await adminClient.storage.from(PROOF_BUCKET).remove([...paths]);
  if (removeError) throw new Error(`The screenshot was not erased: ${removeError.message}`);

  const { error: subError } = await adminClient
    .from('fee_submissions')
    .update({ screenshot_path: null })
    .eq('import_receipt_id', sub.import_receipt_id);
  if (subError) throw new Error(`The screenshot was removed but a receipt still names it: ${subError.message}`);
  const { error: uploadError } = await adminClient
    .from('registration_import_receipts')
    .update({ storage_path: null })
    .eq('id', sub.import_receipt_id);
  if (uploadError) throw new Error(`The screenshot was removed but the form upload still names it: ${uploadError.message}`);

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'fee_submission_screenshot_erased',
      target_type: 'club_fee',
      target_id: fee.id,
      old_value: { screenshot: true },
      new_value: { screenshot: false, fee_submission_id: sub.id, objects: paths.size },
      reason: 'Form receipt screenshot erased on request',
    },
    { submissionId: sub.id },
  );
  revalidate(fee);
}

/**
 * Reminds the named members to pay and send a receipt. The ids only say whom
 * the exec meant; who is actually reminded is decided again here from the
 * same list the page draws (loadOutstandingMembers), so a member who paid,
 * sent a receipt, or was reminded in the last three days since the page
 * rendered is skipped. In-app only: no email, no push, no Discord.
 */
export async function remindUnpaidMembers(playerIds: string[]): Promise<ActionResult<{ sent: number; skipped: number }>> {
  return runAction(() => remindImpl(playerIds));
}

async function remindImpl(playerIds: string[]): Promise<{ sent: number; skipped: number }> {
  const actor = await requireCapability('fees.clubfees.markpaid.write');
  const ids = parseOrThrow(z.array(z.string().uuid()).min(1, 'Pick someone to remind').max(1000), playerIds);
  const adminClient = createAdminClient();

  // The reminder sends members to /membership to pay. With either switch off
  // there is no pay form there to reach, so nobody is reminded.
  const flags = await readFeatureFlags(adminClient);
  if (!flags.fees || !flags.membership) {
    throw new ExpectedError('Turn on the fees and membership switches before reminding members to pay.');
  }

  const { data: season, error: seasonError } = await adminClient
    .from('seasons')
    .select('id, name, active_flag, competitive_fee_cents, recreational_fee_cents')
    .eq('active_flag', true)
    .maybeSingle();
  if (seasonError) throw new Error(`Could not read the season: ${seasonError.message}`);
  if (!season) throw new ExpectedError('Reminders need a running season.');

  const now = new Date();
  const wanted = new Set(ids);
  const members = (await loadOutstandingMembers(adminClient, season, now)).filter(
    (m) => wanted.has(m.id) && m.decision.remind,
  );
  if (members.length === 0) {
    throw new ExpectedError('Nobody here is due a reminder: they have paid, sent a receipt, or were reminded in the last 3 days.');
  }

  const { delivered } = await notifyPlayers(adminClient, members.map((m) => m.id), {
    type: 'general',
    title: 'A reminder to pay your club fees',
    body: 'You have fees unpaid. Pay on the Membership page and upload your receipt.',
    metadata: { kind: 'fee_payment_reminder' },
  });
  if (delivered.length === 0) throw new Error('The reminders could not be sent. Try again.');

  // Stamped only for members the bell row reached, so a failed send never
  // starts somebody's cooldown.
  const reached = new Set(delivered);
  const stamp = now.toISOString();
  const feeIds: string[] = [];
  for (const m of members.filter((x) => reached.has(x.id))) {
    for (const line of m.lines) {
      if (line.feeId) {
        feeIds.push(line.feeId);
        continue;
      }
      // This season's dues, with no row yet: filed now, priced by status the
      // way /fees prices it, so the reminder has somewhere to be recorded.
      const { error } = await adminClient.from('club_fees').insert({
        player_id: m.id,
        season_id: season.id,
        fee_type: 'dues',
        amount_cents: duesFor(m.status, season),
        payment_reminded_at: stamp,
      });
      if (error?.code === '23505') {
        await adminClient
          .from('club_fees')
          .update({ payment_reminded_at: stamp })
          .eq('player_id', m.id)
          .eq('season_id', season.id)
          .eq('fee_type', 'dues')
          .is('paid_at', null);
      } else if (error) {
        console.error('[fees] could not record a dues reminder:', error.message);
      }
    }
  }
  if (feeIds.length > 0) {
    const { error } = await adminClient
      .from('club_fees')
      .update({ payment_reminded_at: stamp })
      .in('id', feeIds)
      .is('paid_at', null);
    if (error) console.error('[fees] could not record reminder times:', error.message);
  }

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'fee_payment_reminders_sent',
      target_type: 'season',
      target_id: season.id,
      new_value: { count: delivered.length, player_ids: delivered },
      reason: `Payment reminder sent to ${delivered.length} ${delivered.length === 1 ? 'member' : 'members'}`,
    },
    { seasonId: season.id },
  );

  revalidatePath('/fees');
  revalidatePath('/finances');
  return { sent: delivered.length, skipped: ids.length - delivered.length };
}
