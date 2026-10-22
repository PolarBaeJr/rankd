// CHECKING A RECEIPT ON THE SERVER (00297): claim it, read it, settle or hold it.
//
// Both apps run this. The player app checks a member's receipt right after it
// is filed (in after(), so nobody waits on the OCR); the console's form poll
// sweeps whatever is left: Google Form receipts, and a member's receipt whose
// first check never finished. The OCR itself is passed in, because each app
// ships its own tesseract.js; this module only needs node:crypto, which keeps
// it out of the shared barrel (import it as
// '@badminton/shared/src/utils/receipt-check').
//
// THE SLOT COMES FIRST, THE CLAIM SECOND. OCR is the expensive part and runs
// one at a time; a claim spends one of a receipt's three attempts, so it is
// only taken once the slot is held. A full queue answers 'busy' and leaves the
// receipt queued for the sweep, its attempts untouched.
//
// NOTHING READ IS LOGGED OR RETURNED. The OCR text carries a member's name
// and SFU ID; it lives in this function's scope and nowhere else. A fault is
// thrown with the RPC's own message, which never contains it.

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MEMBERSHIP_PAYMENTS_SETTING_KEY, parseMembershipPaymentSettings } from './membership-settings';
import { decideAutoConfirm, parseReceiptText, type ReceiptFlag } from './receipt-read';

export type OcrRead = { text: string } | { error: 'timeout' | 'failed' };

export interface ReceiptOcr {
  /** Runs `work` holding the one OCR slot, or answers 'busy' when the queue is full. */
  withSlot<T>(work: () => Promise<T>): Promise<T | 'busy'>;
  read(bytes: Uint8Array): Promise<OcrRead>;
}

/** 'ok' (confirmed), a flag (held), 'busy', 'none' (nothing to claim), or 'retry' (left for the next claim). */
export type ReceiptCheckOutcome = 'ok' | ReceiptFlag | 'busy' | 'none' | 'retry';

type Claimed = {
  submission_id: string;
  club_fee_id: string;
  screenshot_path: string | null;
  method: string | null;
  fee_type: string;
  amount_cents: number | null;
  payer_name: string | null;
  attempts: number;
};

const BUCKET = 'fee-proofs';
const READABLE = /\.(jpe?g|png|webp)$/i;

async function claim(admin: SupabaseClient, submissionId: string | null): Promise<Claimed | null> {
  const { data, error } = await admin.rpc('claim_fee_submission_ocr', {
    p_submission_id: submissionId,
    p_limit: 1,
  });
  if (error) throw new Error(`Receipt check claim failed: ${error.message}`);
  const rows = Array.isArray(data) ? (data as Claimed[]) : [];
  return rows[0] ?? null;
}

async function flag(
  admin: SupabaseClient,
  id: string,
  reason: ReceiptFlag,
  extra: { detail?: string | null; reference?: string | null; hash?: string | null } = {},
): Promise<ReceiptCheckOutcome> {
  const { error } = await admin.rpc('flag_fee_submission_ocr', {
    p_submission_id: id,
    p_flag: reason,
    p_detail: extra.detail ?? null,
    p_reference: extra.reference ?? null,
    p_image_sha256: extra.hash ?? null,
  });
  if (error) throw new Error(`Receipt check flag failed: ${error.message}`);
  return reason;
}

async function clubPayee(admin: SupabaseClient): Promise<{ email: string | null; name: string | null }> {
  const { data, error } = await admin
    .from('platform_settings')
    .select('value')
    .eq('key', MEMBERSHIP_PAYMENTS_SETTING_KEY)
    .maybeSingle();
  if (error) throw new Error(`Receipt check could not read the payment settings: ${error.message}`);
  const settings = parseMembershipPaymentSettings((data as { value?: unknown } | null)?.value);
  return { email: settings.etransferEmail, name: settings.etransferPayeeName };
}

/** Reads one claimed receipt and settles or holds it. */
async function checkClaimed(admin: SupabaseClient, row: Claimed, ocr: ReceiptOcr): Promise<ReceiptCheckOutcome> {
  if (!row.screenshot_path) return flag(admin, row.submission_id, 'unreadable_format');
  const { data: blob, error } = await admin.storage.from(BUCKET).download(row.screenshot_path);
  // Left claimed: the next claim after ten minutes tries again, and the third
  // failure holds it as 'ocr_failed'.
  if (error || !blob) return 'retry';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Hashed before the format check, so a reused PDF still reserves its hash.
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!READABLE.test(row.screenshot_path)) return flag(admin, row.submission_id, 'unreadable_format', { hash });

  const read = await ocr.read(bytes);
  if ('error' in read) {
    return flag(admin, row.submission_id, read.error === 'timeout' ? 'ocr_timeout' : 'ocr_failed', { hash });
  }
  const payee = await clubPayee(admin);
  const decision = decideAutoConfirm(parseReceiptText(read.text), {
    feeType: row.fee_type,
    amountCents: row.amount_cents,
    payerName: row.payer_name,
    clubEmail: payee.email,
    clubPayeeName: payee.name,
  });
  if (!decision.confirm) {
    return flag(admin, row.submission_id, decision.flag, {
      detail: decision.detail,
      reference: decision.reference,
      hash,
    });
  }
  const { data, error: confirmError } = await admin.rpc('auto_confirm_fee_submission', {
    p_submission_id: row.submission_id,
    p_method: decision.method,
    p_reference: decision.reference,
    p_image_sha256: hash,
    p_amount_cents: decision.amountCents,
  });
  if (confirmError) throw new Error(`Receipt auto-confirm failed: ${confirmError.message}`);
  return data === 'not_found' || data === 'not_pending' ? 'none' : (data as ReceiptCheckOutcome);
}

/** Checks one receipt by id, right after it was filed. */
export async function checkSubmission(
  admin: SupabaseClient,
  submissionId: string,
  ocr: ReceiptOcr,
): Promise<ReceiptCheckOutcome> {
  return ocr.withSlot(async () => {
    const row = await claim(admin, submissionId);
    return row ? checkClaimed(admin, row, ocr) : 'none';
  });
}

/**
 * Checks the oldest queued receipts one at a time until `limit` are done, the
 * queue is empty or busy, or `deadline` (a Date.now() value) has passed.
 * Counts by outcome.
 */
export async function sweepReceiptChecks(
  admin: SupabaseClient,
  ocr: ReceiptOcr,
  opts: { deadline: number; limit: number; now?: () => number },
): Promise<Record<string, number>> {
  const now = opts.now ?? Date.now;
  const counts: Record<string, number> = {};
  for (let i = 0; i < opts.limit && now() < opts.deadline; i += 1) {
    let empty = false;
    const outcome = await ocr.withSlot(async () => {
      const row = await claim(admin, null);
      empty = row === null;
      return row ? checkClaimed(admin, row, ocr) : 'none';
    });
    if (empty) break;
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    if (outcome === 'busy') break;
  }
  return counts;
}
