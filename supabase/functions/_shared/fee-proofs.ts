// The e-transfer screenshots a member uploaded (00248), erased with them.
//
// Stored in the private fee-proofs bucket under `<auth user id>/`, the only
// folder the upload policy allows. Called by both purge jobs BEFORE the auth
// user is deleted and the row anonymised, while user_id is still known. The
// fee_submissions rows stay (they are the club's record of a payment) with
// screenshot_path nulled.
//
// Removes every path a row points at, then everything left in the folder: an
// upload whose receipt was never filed, or whose row went with a deleted fee.
// Idempotent: a second run finds nothing and removes nothing.
//
// A screenshot sent through a Google Form (00288) lives under forms/, not the
// member's folder, and its rows may name the member only by email: the
// response's submitter, or a named fee's manual_email from before the member
// had an account. Those are found by player id OR the member's email, removed
// the same way, and their paths nulled on the upload's record and on every
// submission that names them. The form responses themselves are Google's and
// are never touched here.

import type { createServiceClient } from './client.ts';

type ServiceClient = ReturnType<typeof createServiceClient>;

const BUCKET = 'fee-proofs';
const PAGE = 100;

export async function eraseFeeProofs(
  supabase: ServiceClient,
  playerId: string,
  userId: string | null,
): Promise<{ message: string } | null> {
  const { data: rows, error: readError } = await supabase
    .from('fee_submissions')
    .select('screenshot_path')
    .eq('player_id', playerId)
    .not('screenshot_path', 'is', null);
  if (readError) return readError;

  const paths = new Set<string>(
    ((rows ?? []) as { screenshot_path: string }[]).map((r) => r.screenshot_path),
  );

  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('email')
    .eq('id', playerId)
    .maybeSingle();
  if (playerError) return playerError;
  const email = (player as { email: string | null } | null)?.email?.trim().toLowerCase() || null;

  // The form uploads: by the response's submitter, as the member or by email.
  const receiptIds = new Set<string>();
  const submitters = [`submitter_player_id.eq.${playerId}`];
  if (email) submitters.push(`submitter_email.eq.${JSON.stringify(email)}`);
  const { data: receipts, error: receiptError } = await supabase
    .from('registration_import_receipts')
    .select('id, storage_path, registration_imports!inner(id)')
    .or(submitters.join(','), { referencedTable: 'registration_imports' });
  if (receiptError) return receiptError;
  for (const r of (receipts ?? []) as { id: string; storage_path: string | null }[]) {
    receiptIds.add(r.id);
    if (r.storage_path) paths.add(r.storage_path);
  }

  // The submissions on a named fee that carries the member's email.
  const namedFeeIds: string[] = [];
  if (email) {
    const { data: fees, error: feeError } = await supabase
      .from('club_fees')
      .select('id')
      .eq('manual_email', email);
    if (feeError) return feeError;
    namedFeeIds.push(...((fees ?? []) as { id: string }[]).map((f) => f.id));
  }
  if (namedFeeIds.length > 0) {
    const { data: named, error: namedError } = await supabase
      .from('fee_submissions')
      .select('screenshot_path')
      .in('club_fee_id', namedFeeIds)
      .not('screenshot_path', 'is', null);
    if (namedError) return namedError;
    for (const r of (named ?? []) as { screenshot_path: string }[]) paths.add(r.screenshot_path);
  }

  if (userId) {
    // Every page is listed before anything is removed, so removing cannot
    // shift the offsets under the listing.
    for (let offset = 0; ; offset += PAGE) {
      const { data: objects, error: listError } = await supabase.storage
        .from(BUCKET)
        .list(userId, { limit: PAGE, offset });
      if (listError) return listError;
      for (const o of objects ?? []) paths.add(`${userId}/${o.name}`);
      if (!objects || objects.length < PAGE) break;
    }
  }

  const all = [...paths];
  for (let i = 0; i < all.length; i += PAGE) {
    const { error: removeError } = await supabase.storage.from(BUCKET).remove(all.slice(i, i + PAGE));
    if (removeError) return removeError;
  }

  const { error: nullError } = await supabase
    .from('fee_submissions')
    .update({ screenshot_path: null })
    .eq('player_id', playerId)
    .not('screenshot_path', 'is', null);
  if (nullError) return nullError;

  // Every path removed above that a row still names, wherever it is.
  const removed = all.filter((path) => path.startsWith('forms/'));
  for (let i = 0; i < removed.length; i += PAGE) {
    const { error: formNullError } = await supabase
      .from('fee_submissions')
      .update({ screenshot_path: null })
      .in('screenshot_path', removed.slice(i, i + PAGE));
    if (formNullError) return formNullError;
  }
  const ids = [...receiptIds];
  for (let i = 0; i < ids.length; i += PAGE) {
    const { error: receiptNullError } = await supabase
      .from('registration_import_receipts')
      .update({ storage_path: null })
      .in('id', ids.slice(i, i + PAGE))
      .not('storage_path', 'is', null);
    if (receiptNullError) return receiptNullError;
  }
  return null;
}
