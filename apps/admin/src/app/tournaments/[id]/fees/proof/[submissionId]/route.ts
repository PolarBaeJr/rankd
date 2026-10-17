import { NextResponse } from 'next/server';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { browserReachableSignedUrl } from '@/lib/signed-url';
import { inlineProof } from '@/lib/fee-submissions';

/**
 * Open the screenshot sent with a receipt for this tournament's entry fee
 * (00248). The sibling of /fees/proof/[id], under /tournaments so an officer
 * holding entry money and not the club-fee section can reach it. The fee must
 * be an entry for THIS tournament: the id in the path is checked against the
 * row, not trusted. `?inline=1` answers the image itself, under the same
 * check (inlineProof).
 */

const PROOF_URL_TTL_SECONDS = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; submissionId: string }> },
) {
  await requireCapability('tournaments.fees.markpaid.write');

  const { id, submissionId } = await params;
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(id) || !uuid.test(submissionId)) return new NextResponse('Not found', { status: 404 });
  const adminClient = createAdminClient();

  const { data: sub } = await adminClient
    .from('fee_submissions')
    .select('id, club_fee_id, screenshot_path')
    .eq('id', submissionId)
    .maybeSingle();
  const { data: fee } = sub
    ? await adminClient
        .from('club_fees')
        .select('fee_type, tournament_id')
        .eq('id', sub.club_fee_id)
        .maybeSingle()
    : { data: null };

  if (!sub?.screenshot_path || fee?.fee_type !== 'tournament' || fee.tournament_id !== id) {
    return new NextResponse('Not found', { status: 404 });
  }

  if (new URL(request.url).searchParams.get('inline') === '1') return inlineProof(adminClient, sub.screenshot_path);

  const { data, error } = await adminClient.storage
    .from('fee-proofs')
    .createSignedUrl(sub.screenshot_path, PROOF_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    // A row whose object is gone (a restored copy of the database without its
    // storage) is a missing screenshot, not a broken server: a 502 here comes
    // back through Cloudflare as its own error page.
    if (error && /not found/i.test(error.message)) {
      return new NextResponse('That screenshot is not on file', { status: 404 });
    }
    console.error('[tournaments] could not sign a payment screenshot:', error?.message);
    return new NextResponse('Could not open that screenshot', { status: 502 });
  }

  const response = NextResponse.redirect(browserReachableSignedUrl(data.signedUrl), 302);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
