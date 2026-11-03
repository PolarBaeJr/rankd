import { NextResponse } from 'next/server';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { inlineProof } from '@/lib/fee-submissions';

/**
 * A receipt photo uploaded in the expense dialog and not saved yet (00313).
 *
 * The dialog uploads on pick, straight from the browser to storage, and reads
 * the photo in the browser. Chrome cannot decode a HEIC, so for one it fetches
 * the converted JPEG from here. It is also the dialog's preview of a stored
 * photo it has no File for. Always answered inline (inlineProof), never as a
 * signed URL.
 *
 * ONLY YOUR OWN FOLDER. The bucket has no read policy, and this reads with the
 * service role, so the path is the whole boundary: it must sit in the viewer's
 * own auth.uid() folder (the folder 00231's INSERT policy lets them write) and
 * may not climb out of it. Anything else is one 404, so the route confirms
 * nothing about which objects exist. Gated on being able to add or edit an
 * expense, the two dialogs that upload.
 *
 * A static segment, so Next routes /fees/expense-receipt/pending here and not
 * to [attachmentId].
 */

export async function GET(request: Request) {
  const viewer = await requireCapability('fees.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(level, viewer);
  if (
    !permits(level, permissions, 'fees.expenses.add.write') &&
    !permits(level, permissions, 'fees.expenses.update.write')
  ) {
    return new NextResponse('Not found', { status: 404 });
  }

  const path = new URL(request.url).searchParams.get('path') ?? '';
  if (!path.startsWith(`${viewer.user_id}/`) || path.includes('..') || path.length > 512) {
    return new NextResponse('Not found', { status: 404 });
  }
  return inlineProof(createAdminClient(), path, 'expense-receipts');
}
