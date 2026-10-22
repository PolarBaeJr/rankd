import {
  ExpectedError,
  feeSubmissionSchema,
  isPlausibleReference,
  normaliseReference,
  parseOrThrow,
} from '@badminton/shared';
import type { createServiceRoleClient } from './supabase-server';
import { seasonFeeFor } from './member-fees';
import { getMembershipPayments } from './club-socials';

// THE RULES FOR FILING A PAYMENT RECEIPT (00248, 00253), shared by both doors:
// the Membership page's server action (actions/fee-submissions.ts) and Discord
// /receipt (app/api/discord/receipts). A plain module, not a 'use server' one,
// so nothing here is reachable as a Server Action: every caller has already
// decided who the member is and has stored the screenshot at a path it built.
//
// The method is a hint for the exec, and clamped here: only dues are sold on
// the Campus Rec website, so every other line is stored as an e-transfer, and
// paying one needs the club's e-transfer address to be set. A dues receipt
// keeps the caller's answer (the browser's OCR guess), or NULL when it could
// not tell, which is always the case from Discord.
//
// Service role for every write: fee_submissions has no INSERT grant or policy
// for members, and a dues row may have to be created. Every refusal is an
// ExpectedError carrying the sentence the member sees.

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export type ReceiptPayer = {
  id: string;
  status?: string | null;
  is_exec?: boolean | null;
  fee_exempt?: boolean | null;
};

export type ReceiptFeeType = 'dues' | 'event' | 'tournament';

export interface FileFeeSubmissionInput {
  feeId: string | null;
  duesSeasonId: string | null;
  reference: string;
  /** Built by the caller under the member's own folder; never a client value here. */
  screenshotPath: string;
  detectedMethod?: 'e_transfer' | 'sfu_rec' | null;
}

/**
 * Everything checked before anything is written: which fee, the method, the
 * e-transfer address, the reference. Returns what the insert needs. Split from
 * the insert so a caller that still has to store a file (Discord) can refuse
 * before it spends the upload.
 *
 * `feeTypes` narrows which existing lines this door takes. The web takes every
 * one the page offers; Discord offers dues and club events only.
 */
export async function checkFeeSubmission(
  admin: ServiceClient,
  player: ReceiptPayer,
  input: Omit<FileFeeSubmissionInput, 'screenshotPath'> & { screenshotPath?: string },
  options: { feeTypes?: readonly ReceiptFeeType[] } = {},
): Promise<{
  feeId: string | null;
  duesSeasonId: string | null;
  reference: string;
  method: 'e_transfer' | 'sfu_rec' | null;
}> {
  // The schema wants a path; a caller checking before it has stored the file
  // passes none, and a placeholder stands in for the length check only.
  const parsed = parseOrThrow(feeSubmissionSchema, {
    feeId: input.feeId,
    duesSeasonId: input.duesSeasonId,
    reference: input.reference,
    screenshotPath: input.screenshotPath ?? 'pending',
    detectedMethod: input.detectedMethod ?? null,
  });
  const reference = normaliseReference(parsed.reference);

  const existing = parsed.feeId ? await payableFee(admin, parsed.feeId, player.id) : null;
  const feeType = existing?.fee_type ?? 'dues';
  if (options.feeTypes && !(options.feeTypes as readonly string[]).includes(feeType)) {
    throw new ExpectedError('Send the receipt for that one on the club website.');
  }
  const method = feeType === 'dues' ? (parsed.detectedMethod ?? null) : 'e_transfer';
  if (feeType !== 'dues' && !(await getMembershipPayments()).etransferEmail) {
    throw new ExpectedError('Ask an exec how to pay this one.');
  }
  if (!isPlausibleReference(reference, method)) {
    throw new ExpectedError(
      method === 'e_transfer'
        ? 'The reference is 6 to 32 letters, digits or hyphens, with no spaces, or the number exactly as your bank shows it'
        : 'The reference is 4 to 32 letters, digits or hyphens, with no spaces',
    );
  }
  // The fee the receipt would attach to, if it exists yet: the row named, or
  // this season's dues row when the member already has one.
  let attachTo = existing?.id ?? null;
  if (!existing) {
    await assertDuesPayable(admin, parsed.duesSeasonId as string, player);
    const dues = await findDuesRow(admin, player.id, parsed.duesSeasonId as string);
    if (dues?.paid_at) throw new ExpectedError('Your dues for this season are already settled.');
    attachTo = dues?.id ?? null;
  }
  // The unique index refuses a second pending receipt at insert time whatever
  // happens here; this says so before a caller spends an upload on it.
  if (attachTo) await assertNoPendingReceipt(admin, attachTo);
  return {
    feeId: existing ? existing.id : null,
    duesSeasonId: existing ? null : (parsed.duesSeasonId as string),
    reference,
    method,
  };
}

/**
 * File the receipt: the checks above, then (for dues with no row yet) the dues
 * row, then the submission. A pending receipt for the same fee is refused by
 * the unique index, whichever door the first one came through. Returns the
 * submission's id, for the server's own read of it (00297).
 */
export async function fileFeeSubmission(
  admin: ServiceClient,
  player: ReceiptPayer,
  input: FileFeeSubmissionInput,
  options: { feeTypes?: readonly ReceiptFeeType[] } = {},
): Promise<string> {
  const checked = await checkFeeSubmission(admin, player, input, options);
  // Everything is checked before duesFee, which may write.
  const feeId = checked.feeId ?? (await duesFee(admin, checked.duesSeasonId as string, player));

  const { data, error } = await admin.from('fee_submissions').insert({
    club_fee_id: feeId,
    player_id: player.id,
    reference: checked.reference,
    screenshot_path: input.screenshotPath,
    method: checked.method,
  }).select('id').single();
  // Only the one-pending index means "already waiting"; 00297's other unique
  // indexes are never written by this insert, so anything else is a fault.
  if (error?.code === '23505' && /fee_submissions_one_pending/.test(`${error.message} ${error.details ?? ''}`)) {
    throw new ExpectedError('You already have a submission waiting for this fee.');
  }
  if (error) throw new Error(`The receipt was not saved: ${error.message}`);
  return (data as { id: string }).id;
}

/** An existing fee row: the member's own, unpaid, and not a reinstatement. */
async function payableFee(
  admin: ServiceClient,
  feeId: string,
  playerId: string,
): Promise<{ id: string; fee_type: string }> {
  const { data: fee, error } = await admin
    .from('club_fees')
    .select('id, player_id, fee_type, paid_at, amount_cents')
    .eq('id', feeId)
    .maybeSingle();
  if (error) throw new Error(`Could not read that fee: ${error.message}`);
  if (!fee || fee.player_id !== playerId) throw new ExpectedError('That fee is not one of yours.');
  if (fee.fee_type === 'reinstatement') {
    throw new ExpectedError('A reinstatement fee is settled with an exec, not by receipt.');
  }
  if (fee.paid_at) throw new ExpectedError('That fee is already settled.');
  if (fee.amount_cents == null) {
    throw new ExpectedError('That fee has no amount recorded yet. Ask an exec how much to send.');
  }
  return { id: fee.id as string, fee_type: fee.fee_type as string };
}

type DuesSeason = { id: string; competitive_fee_cents: number; recreational_fee_cents: number };

type DuesRow = { id: string; paid_at: string | null; amount_cents: number | null };

/** This member's dues row for a season, or null. */
async function findDuesRow(admin: ServiceClient, playerId: string, seasonId: string): Promise<DuesRow | null> {
  const { data, error } = await admin
    .from('club_fees')
    .select('id, paid_at, amount_cents')
    .eq('player_id', playerId)
    .eq('season_id', seasonId)
    .eq('fee_type', 'dues')
    .maybeSingle();
  if (error) throw new Error(`Could not read your dues: ${error.message}`);
  return data as DuesRow | null;
}

/** Refuses when a receipt for this fee is already waiting for an exec. */
async function assertNoPendingReceipt(admin: ServiceClient, feeId: string): Promise<void> {
  const { data, error } = await admin
    .from('fee_submissions')
    .select('id')
    .eq('club_fee_id', feeId)
    .eq('status', 'submitted')
    .limit(1);
  if (error) throw new Error(`Could not read your receipts: ${error.message}`);
  if ((data ?? []).length > 0) throw new ExpectedError('You already have a submission waiting for this fee.');
}

/** Dues are owed by this member, for the season that is running. Writes nothing. */
async function assertDuesPayable(
  admin: ServiceClient,
  seasonId: string,
  player: ReceiptPayer,
): Promise<DuesSeason> {
  if (player.is_exec || player.fee_exempt) {
    throw new ExpectedError('You are not charged club dues, so there is nothing to pay.');
  }
  const { data: season, error: seasonError } = await admin
    .from('seasons')
    .select('id, competitive_fee_cents, recreational_fee_cents')
    .eq('id', seasonId)
    .eq('active_flag', true)
    .maybeSingle();
  if (seasonError) throw new Error(`Could not read the season: ${seasonError.message}`);
  if (!season) throw new ExpectedError('Dues can only be paid for the season that is running.');
  return season as DuesSeason;
}

/**
 * This season's dues, found or created. Only the active season, never for an
 * exec or fee-exempt member, priced by players.status exactly as the page shows
 * it. Read, insert, and on a unique violation read again: another tab or an
 * exec may have filed the row in between.
 */
async function duesFee(admin: ServiceClient, seasonId: string, player: ReceiptPayer): Promise<string> {
  const season = await assertDuesPayable(admin, seasonId, player);

  const find = () => findDuesRow(admin, player.id, seasonId);

  let row = await find();
  if (!row) {
    const { data, error } = await admin
      .from('club_fees')
      .insert({
        player_id: player.id,
        season_id: seasonId,
        fee_type: 'dues',
        amount_cents: seasonFeeFor(player.status, season),
      })
      .select('id, paid_at, amount_cents')
      .single();
    if (error?.code === '23505') row = await find();
    else if (error) throw new Error(`Could not record your dues: ${error.message}`);
    else row = data as DuesRow;
  }
  if (!row) throw new Error('Your dues row could not be found after it was created.');
  if (row.paid_at) throw new ExpectedError('Your dues for this season are already settled.');
  // An unpaid dues row an exec filed with no amount: price it the way the page
  // does, or the confirm could never settle it.
  if (row.amount_cents == null) {
    const { error } = await admin
      .from('club_fees')
      .update({ amount_cents: seasonFeeFor(player.status, season) })
      .eq('id', row.id)
      .is('paid_at', null)
      .is('amount_cents', null);
    if (error) throw new Error(`Could not price your dues: ${error.message}`);
  }
  return row.id;
}
