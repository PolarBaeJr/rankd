import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import type { createAdminClient } from './supabase-server';
import {
  BudgetExhausted,
  downloadDriveFile,
  DriveFileError,
  getDriveFileMeta,
  GoogleFormsError,
  type GoogleDeps,
  type ReadBudget,
  type ServiceAccount,
} from './google-forms';

// A FORM'S UPLOADED RECEIPT, BROUGHT INTO THE REVIEW (00288).
//
// The poll records each response's upload (record_registration_import_receipt)
// as it imports it; this runs after the forms are read, with what is left of
// the round's Google budget and time. For each receipt waiting for its bytes:
// Drive's metadata first, so a file too big or of the wrong type is never
// downloaded; then the bytes, capped; then the first bytes are checked, since
// the type Drive reports is only what the uploader's device said; then the
// upload into fee-proofs under forms/<binding>/<import>/. Then, every round,
// file_registration_import_receipts matches the downloaded ones to their fees.
//
// Serial on purpose: a handful of files a round, each up to 10 MiB, and the
// forms have already had the budget's first call.
//
// NOTHING IS LOGGED THAT NAMES THE FILE OR ITS CONTENTS. Sentry hears about
// faults on this side, with the receipt id only.

type Admin = ReturnType<typeof createAdminClient>;

/** The bucket's limit (00288) and the form's: 10 MiB. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
/** Receipts downloaded per round, at most. Each costs two Google requests. */
export const RECEIPT_BATCH = 20;
/** Downloaded receipts matched to fees per round. */
export const RECEIPT_FILE_BATCH = 50;

const BUCKET = 'fee-proofs';

/** What the uploader's device may say a receipt is. Anything else is bad_type before a download. */
export const RECEIPT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

export interface ReceiptKind {
  ext: 'jpg' | 'png' | 'webp' | 'heic' | 'heif' | 'pdf';
  contentType: string;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/** The receipt's type from its first bytes, or null when it is none of the six. */
export function sniffReceipt(bytes: Uint8Array): ReceiptKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte)
  ) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (HEIC_BRANDS.has(brand)) return { ext: 'heic', contentType: 'image/heic' };
    if (HEIF_BRANDS.has(brand)) return { ext: 'heif', contentType: 'image/heif' };
    return null;
  }
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === '%PDF-') {
    return { ext: 'pdf', contentType: 'application/pdf' };
  }
  return null;
}

interface ClaimedReceipt {
  id: string;
  import_id: string;
  binding_id: string;
  drive_file_id: string;
  mime_type: string | null;
  attempts: number;
}

type Settlement = 'pending_download' | 'pending_fee' | 'too_large' | 'bad_type' | 'drive_forbidden';

export interface ReceiptDrainOutcome {
  claimed: number;
  downloaded: number;
  refused: number;
  released: number;
  stopped?: 'rate_limited' | 'budget' | 'time' | 'auth' | 'forbidden';
  /** Counts by outcome of file_registration_import_receipts. */
  filed: Record<string, number>;
}

async function settle(
  admin: Admin,
  receipt: ClaimedReceipt,
  status: Settlement,
  path: string | null,
  size: number | null,
): Promise<boolean> {
  const { data, error } = await admin.rpc('settle_registration_import_receipt', {
    p_receipt_id: receipt.id,
    p_drive_file_id: receipt.drive_file_id,
    p_status: status,
    p_storage_path: path,
    p_size_bytes: size,
  });
  if (error) {
    Sentry.captureException(new Error(`Form receipt settle failed: ${error.message}`), {
      extra: { job: 'registration-form-poll', receipt: receipt.id },
    });
    return false;
  }
  return data === true;
}

/** Downloads one receipt and stores it. Throws what stops the downloads for the round. */
async function bringIn(
  admin: Admin,
  receipt: ClaimedReceipt,
  account: ServiceAccount,
  deps: GoogleDeps,
  budget: ReadBudget,
  outcome: ReceiptDrainOutcome,
): Promise<void> {
  try {
    const meta = await getDriveFileMeta(receipt.drive_file_id, account, deps, budget);
    if (meta.size !== null && meta.size > RECEIPT_MAX_BYTES) {
      await settle(admin, receipt, 'too_large', null, meta.size);
      outcome.refused += 1;
      return;
    }
    if (meta.mimeType === null || !RECEIPT_TYPES.has(meta.mimeType)) {
      await settle(admin, receipt, 'bad_type', null, meta.size);
      outcome.refused += 1;
      return;
    }
    const bytes = await downloadDriveFile(receipt.drive_file_id, RECEIPT_MAX_BYTES, account, deps, budget);
    const kind = sniffReceipt(bytes);
    if (!kind) {
      await settle(admin, receipt, 'bad_type', null, bytes.byteLength);
      outcome.refused += 1;
      return;
    }
    const path = `forms/${receipt.binding_id}/${receipt.import_id}/${randomUUID()}.${kind.ext}`;
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: kind.contentType, upsert: false });
    if (uploadError) {
      // Left claimed: retried once the claim goes stale, counted as an attempt.
      Sentry.captureException(new Error(`Form receipt upload failed: ${uploadError.message}`), {
        extra: { job: 'registration-form-poll', receipt: receipt.id },
      });
      return;
    }
    if (await settle(admin, receipt, 'pending_fee', path, bytes.byteLength)) {
      outcome.downloaded += 1;
    } else {
      // A newer upload superseded this one while it downloaded: nothing points here.
      await admin.storage.from(BUCKET).remove([path]);
    }
  } catch (err) {
    if (err instanceof DriveFileError) {
      await settle(admin, receipt, err.code, null, null);
      outcome.refused += 1;
      return;
    }
    if (err instanceof GoogleFormsError && (err.code === 'google_unavailable' || err.code === 'google_refused')) {
      // This file, this time: left claimed and retried after the stale window.
      return;
    }
    throw err;
  }
}

/**
 * Downloads what it can of the receipts waiting for their bytes, then files
 * every downloaded one it can match to a fee. `downloads` false (the round
 * already stopped on Google) skips straight to filing, which needs no Google.
 */
export async function drainFormReceipts(
  admin: Admin,
  account: ServiceAccount,
  deps: GoogleDeps,
  budget: ReadBudget,
  opts: { downloads: boolean; deadline: number },
): Promise<ReceiptDrainOutcome> {
  const outcome: ReceiptDrainOutcome = { claimed: 0, downloaded: 0, refused: 0, released: 0, filed: {} };

  const room = Math.floor((budget.limit - budget.used) / 2);
  if (opts.downloads && room > 0 && deps.now() < opts.deadline) {
    const { data, error } = await admin.rpc('claim_registration_import_receipts', {
      p_limit: Math.min(RECEIPT_BATCH, room),
    });
    if (error) {
      Sentry.captureException(new Error(`Form receipt claim failed: ${error.message}`), {
        extra: { job: 'registration-form-poll' },
      });
    }
    const queue = Array.isArray(data) ? (data as ClaimedReceipt[]) : [];
    outcome.claimed = queue.length;
    for (const receipt of queue) {
      if (outcome.stopped === undefined) {
        if (deps.now() >= opts.deadline) outcome.stopped = 'time';
        else if (budget.limit - budget.used < 2) outcome.stopped = 'budget';
      }
      if (outcome.stopped === undefined) {
        try {
          await bringIn(admin, receipt, account, deps, budget, outcome);
          continue;
        } catch (err) {
          if (err instanceof BudgetExhausted) outcome.stopped = 'budget';
          else if (err instanceof GoogleFormsError && (err.code === 'rate_limited' || err.code === 'auth' || err.code === 'forbidden')) {
            outcome.stopped = err.code;
          } else {
            Sentry.captureException(new Error('Form receipt download failed unexpectedly'), {
              extra: { job: 'registration-form-poll', receipt: receipt.id, kind: err instanceof Error ? err.name : typeof err },
            });
            continue;
          }
        }
      }
      // Not this file's fault: released with no attempt counted, so a Drive
      // API that is switched off never uses up a receipt's attempts.
      await settle(admin, receipt, 'pending_download', null, null);
      outcome.released += 1;
    }
  }

  const { data: filed, error: fileError } = await admin.rpc('file_registration_import_receipts', {
    p_limit: RECEIPT_FILE_BATCH,
  });
  if (fileError) {
    Sentry.captureException(new Error(`Form receipt filing failed: ${fileError.message}`), {
      extra: { job: 'registration-form-poll' },
    });
  }
  for (const row of Array.isArray(filed) ? (filed as { outcome: string }[]) : []) {
    outcome.filed[row.outcome] = (outcome.filed[row.outcome] ?? 0) + 1;
  }
  return outcome;
}
