import { NextResponse } from 'next/server';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { browserReachableSignedUrl } from '@/lib/signed-url';
import { inlineProof, isHeicPath } from '@/lib/fee-submissions';

/**
 * Open one file of an expense's receipt (00313).
 *
 * Shaped like ../../receipt/[id]/route.ts, for the reasons given there: under
 * /fees so the section gate is fees.page and an exec with the Finance job
 * reaches it, gated on fees.expenses.read (the capability that renders the
 * row) with the passkey gate on, a 302 to a 60-second signed URL, one signing
 * per click, and never cached.
 *
 * `?inline=1` on an image answers the image itself, same origin, so the
 * receipts dialog can show it in an <img>; a HEIC or HEIF is always answered
 * that way, converted to a JPEG, because Chrome downloads a HEIC it cannot
 * show. How to answer is decided by the stored path's extension, the same
 * check inlineProof types its answer by, never by the stored content_type. A
 * PDF gets the signed URL and opens in the browser's own viewer.
 */

const RECEIPT_URL_TTL_SECONDS = 60;

export async function GET(request: Request, { params }: { params: Promise<{ attachmentId: string }> }) {
  await requireCapability('fees.expenses.read');

  const { attachmentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return new NextResponse('Not found', { status: 404 });
  const adminClient = createAdminClient();

  // The direction interlock is the table's own: its foreign key pins every
  // row to an EXPENSE, so no id can reach an income row here.
  const { data: file } = await adminClient
    .from('club_expense_receipts')
    .select('path')
    .eq('id', attachmentId)
    .maybeSingle();
  if (!file?.path) return new NextResponse('Not found', { status: 404 });

  const inline = new URL(request.url).searchParams.get('inline') === '1';
  if (isHeicPath(file.path) || (inline && !/\.pdf$/i.test(file.path))) {
    return inlineProof(adminClient, file.path, 'expense-receipts');
  }

  const { data, error } = await adminClient.storage
    .from('expense-receipts')
    .createSignedUrl(file.path, RECEIPT_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    // A row whose object is gone (a restored database without its storage)
    // is a missing receipt, not a broken server.
    if (error && /not found/i.test(error.message)) {
      return new NextResponse('That receipt is not on file', { status: 404 });
    }
    console.error('[fees] could not sign expense receipt:', error?.message);
    return new NextResponse('Could not open that receipt', { status: 502 });
  }

  const response = NextResponse.redirect(browserReachableSignedUrl(data.signedUrl), 302);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
