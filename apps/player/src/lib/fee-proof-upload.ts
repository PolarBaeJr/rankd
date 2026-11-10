// Removing a receipt screenshot the member uploaded but that was never filed.
// Plain module, not 'use server': every export of a 'use server' file is a
// callable endpoint, and this one deletes storage objects by path.

import type { createServiceRoleClient } from './supabase-server';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

/**
 * Removes `path` from fee-proofs only when no receipt row names it: a filed
 * fee_submissions screenshot or a Form upload's registration_import_receipts
 * object. A path that is already on file is somebody's record of a payment,
 * however the action that is cleaning up got there. Returns whether it was
 * removed.
 *
 * A failed PostgREST read looks like an empty result, so an error on either
 * read means keep the file, never "nothing names it".
 */
export async function removeUnreferencedUpload(service: ServiceClient, path: string, tag: string): Promise<boolean> {
  const [submissions, imports] = await Promise.all([
    service.from('fee_submissions').select('id').eq('screenshot_path', path).limit(1),
    service.from('registration_import_receipts').select('id').eq('storage_path', path).limit(1),
  ]);
  if (submissions.error || imports.error) {
    console.error(
      `[${tag}] kept an upload: could not read whether a receipt names it:`,
      (submissions.error ?? imports.error)!.message,
    );
    return false;
  }
  if ((submissions.data ?? []).length > 0 || (imports.data ?? []).length > 0) return false;
  const { error } = await service.storage.from('fee-proofs').remove([path]);
  if (error) console.error(`[${tag}] could not remove an orphaned receipt upload:`, error.message);
  return true;
}
