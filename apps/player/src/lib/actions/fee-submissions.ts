'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { ExpectedError, type FeeSubmissionInput } from '@badminton/shared';
import { createServerSupabaseClient, createServiceRoleClient } from '../supabase-server';
import { assertFeatureOn } from '../feature-gate';
import { fileFeeSubmission } from '../fee-submission-core';
import { checkSubmission } from '@badminton/shared/src/utils/receipt-check';
import { serverReceiptOcr } from '../receipt-ocr-server';
import { requirePlayer, runAction, type ActionResult } from './_shared';

// A MEMBER SENDS A PAYMENT RECEIPT (00248, 00253).
//
// The browser has already uploaded the screenshot to fee-proofs under the
// member's own folder; this files the row that points at it. EVERY INPUT IS A
// CLIENT-CONTROLLED POST FIELD, and only five are read: which fee (feeId, or
// duesSeasonId for dues with no row yet), the reference, the path, and the
// method the browser read off the screenshot. player_id and the dues amount
// come from the server.
//
// The rules themselves live in ../fee-submission-core.ts, which Discord
// /receipt files through too, so both doors refuse the same things.
//
// Once filed, the server reads the screenshot itself (00297) and may confirm
// it with nobody looking. That runs after the response, so the member never
// waits on the OCR; a check that never finishes is picked up by the console's
// sweep.

export async function submitFeeSubmission(input: FeeSubmissionInput): Promise<ActionResult> {
  return runAction(() => submitFeeSubmissionImpl(input));
}

async function removeUpload(path: string | null) {
  if (!path) return;
  const { error } = await createServiceRoleClient().storage.from('fee-proofs').remove([path]);
  if (error) console.error('[membership] could not remove an orphaned receipt upload:', error.message);
}

async function submitFeeSubmissionImpl(input: FeeSubmissionInput): Promise<void> {
  const player = await requirePlayer();
  await assertFeatureOn('fees', player);

  // The path is checked before anything else, so a crafted one is refused
  // without being removed: it may name somebody else's object.
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new ExpectedError('Not authenticated');
  const path = typeof input?.screenshotPath === 'string' ? input.screenshotPath : '';
  if (!path.startsWith(`${user.id}/`) || path.includes('..')) {
    throw new ExpectedError('That screenshot could not be attached');
  }

  let submissionId: string;
  try {
    submissionId = await fileFeeSubmission(createServiceRoleClient(), player, {
      feeId: input?.feeId ?? null,
      duesSeasonId: input?.duesSeasonId ?? null,
      reference: input?.reference,
      screenshotPath: path,
      detectedMethod: input?.detectedMethod ?? null,
    });
  } catch (err) {
    await removeUpload(path);
    throw err;
  }

  after(() => checkReceipt(submissionId));

  revalidatePath('/membership');
  revalidatePath('/feed');
}

async function checkReceipt(submissionId: string): Promise<void> {
  try {
    await checkSubmission(createServiceRoleClient(), submissionId, serverReceiptOcr);
  } catch (err) {
    // The RPC's message only: nothing read off the screenshot is in it.
    console.error('[membership] the receipt check failed:', err instanceof Error ? err.message : typeof err);
  }
}
