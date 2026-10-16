'use server';

import { revalidatePath } from 'next/cache';
import { ExpectedError, type FeeSubmissionInput } from '@badminton/shared';
import { createServerSupabaseClient, createServiceRoleClient } from '../supabase-server';
import { assertFeatureOn } from '../feature-gate';
import { fileFeeSubmission } from '../fee-submission-core';
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

  try {
    await fileFeeSubmission(createServiceRoleClient(), player, {
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

  revalidatePath('/membership');
  revalidatePath('/feed');
}
