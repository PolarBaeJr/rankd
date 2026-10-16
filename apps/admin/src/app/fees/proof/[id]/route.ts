import { NextResponse } from 'next/server';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { browserReachableSignedUrl } from '@/lib/signed-url';
import { inlineProof, submissionCapability } from '@/lib/fee-submissions';

/**
 * Open the screenshot a member sent with an e-transfer receipt (00248).
 *
 * Shaped like ../../receipt/[id]/route.ts, for the reasons given there: under
 * /fees so the section gate is fees.page, a 302 to a 60-second signed URL, one
 * signing per click, and never cached. The capability that decides is the one
 * that settles the fee: club fees here, entry money for a tournament entry
 * (which also has its own route under /tournaments/[id]/fees/proof).
 *
 * `?inline=1` answers the image itself instead, under the same check, for the
 * console's OCR of a form receipt (00288, inlineProof).
 */

const PROOF_URL_TTL_SECONDS = 60;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireCapability('fees.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(level, viewer);

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse('Not found', { status: 404 });
  const adminClient = createAdminClient();

  const { data: sub } = await adminClient
    .from('fee_submissions')
    .select('id, club_fee_id, screenshot_path')
    .eq('id', id)
    .maybeSingle();
  const { data: fee } = sub
    ? await adminClient.from('club_fees').select('fee_type').eq('id', sub.club_fee_id).maybeSingle()
    : { data: null };
  const capability = submissionCapability(fee?.fee_type);

  // Missing, no screenshot, or not yours to see: one answer, so the route
  // confirms nothing about which ids exist.
  if (!sub?.screenshot_path || !capability || !permits(level, permissions, capability)) {
    return new NextResponse('Not found', { status: 404 });
  }

  if (new URL(request.url).searchParams.get('inline') === '1') return inlineProof(adminClient, sub.screenshot_path);

  const { data, error } = await adminClient.storage
    .from('fee-proofs')
    .createSignedUrl(sub.screenshot_path, PROOF_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    console.error('[fees] could not sign a payment screenshot:', error?.message);
    return new NextResponse('Could not open that screenshot', { status: 502 });
  }

  const response = NextResponse.redirect(browserReachableSignedUrl(data.signedUrl), 302);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
