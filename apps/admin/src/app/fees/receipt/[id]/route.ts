import { NextResponse } from 'next/server';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { browserReachableSignedUrl } from '@/lib/signed-url';
import { withBase } from '@/lib/base-path';

/**
 * Open the receipt attached to an expense (00231).
 *
 * WHY IT LIVES UNDER /fees AND NOT UNDER /api. This is the one thing about this
 * file that is not obvious and is worth getting right once. canAccess() resolves
 * a path through longestPrefixMatch over SECTION_CAPABILITY and returns
 * `level === 'admin'` for any path nothing claims (permissions.ts:250): fail
 * closed, deliberately. The middleware matcher covers everything including
 * /api/*, so a handler at /api/receipts would be an UNCLAIMED path, and the
 * middleware would 307 a finance-role exec to /dashboard before this code ran.
 * The exec who files the club's expenses is exactly the person this feature is
 * for, so that would have broken it for its main user while working perfectly
 * for an admin testing it.
 *
 * Sitting here, '/fees/receipt/<id>' matches the existing '/fees' prefix and
 * resolves to `fees.page`, which the exec holds. So this file needs NO
 * SECTION_CAPABILITY entry and no new row in the permissions matrix, and the
 * gate below is what actually decides who may open a receipt.
 *
 * THE GATE IS fees.expenses.read, the same capability that renders the row. It
 * is not a new capability: seeing what the club spent and seeing the receipt
 * behind it are one act, and minting a second key would have meant an admin
 * ticking two boxes to grant one thing. `fees.page` gets you to the section and
 * says nothing about the ledgers inside it, which is why the check is repeated
 * here rather than left to the middleware. requireCapability throws, and the
 * passkey gate applies as it does to every other privileged surface: a receipt is
 * private financial evidence, so this is not a place to pass { skipPasskey }.
 *
 * A 302 TO A SHORT-LIVED SIGNED URL, rather than streaming the bytes back
 * through this process. The file goes browser-to-storage on the way in and
 * storage-to-browser on the way out, so a multi-megabyte photo never crosses the
 * single Node thread that renders every other page in the console. Sixty seconds
 * is enough for a browser to follow a redirect it was handed and short enough
 * that a URL copied out of devtools is stale before it is useful. The row keeps
 * the PATH, so a fresh one can always be signed.
 *
 * ONE SIGNING PER CLICK. Nothing here runs at render time: the ledger draws a
 * plain link, and a page of forty expenses signs forty URLs only if somebody
 * opens forty receipts. Signing on render would have meant forty signatures and
 * forty URLs in the RSC payload, all expiring while the page sat open.
 */

const RECEIPT_URL_TTL_SECONDS = 60;

// SINCE 00313 an expense keeps every file of its receipt in
// club_expense_receipts and the ledger opens each through
// ../../expense-receipt/[attachmentId]. This route stays so a link to it still
// works: it sends the browser to the expense's first file, and falls back to
// signing receipt_path itself for a row that has none there.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireCapability('fees.expenses.read');

  const { id } = await params;
  const adminClient = createAdminClient();

  // `.eq('direction', 'expense')` IS A SAFETY INTERLOCK, NOT A FILTER, and every
  // id-keyed statement in finance.ts carries it for the same reason: since 00159
  // ids are unique across the WHOLE ledger, so without it an income id would
  // read a row from the other book under a capability about expenses. Income
  // rows cannot hold a receipt at all (00231's CHECK), so this can only ever
  // refuse, which is precisely why it is cheap to keep.
  const { data: row } = await adminClient
    .from('club_ledger')
    .select('id, receipt_path')
    .eq('id', id)
    .eq('direction', 'expense')
    .maybeSingle();

  // A missing row and a row with no receipt are the same answer to a browser:
  // there is nothing here. Deliberately not distinguished, because the caller
  // has already been authorised to read this ledger and telling them which of
  // the two it was would serve no purpose beyond confirming that some id exists.
  if (!row?.receipt_path) {
    return new NextResponse('Not found', { status: 404 });
  }

  const { data: first } = await adminClient
    .from('club_expense_receipts')
    .select('id')
    .eq('ledger_id', row.id)
    .order('position')
    .limit(1)
    .maybeSingle();
  if (first) {
    // A relative Location, so the redirect stays on whatever host the browser
    // used rather than the one this process sees behind the proxy.
    return new NextResponse(null, {
      status: 302,
      headers: { Location: withBase(`/fees/expense-receipt/${first.id}`), 'Cache-Control': 'private, no-store' },
    });
  }

  const { data, error } = await adminClient.storage
    .from('expense-receipts')
    .createSignedUrl(row.receipt_path, RECEIPT_URL_TTL_SECONDS);

  // NOT best-effort, unlike the Discord relay's copy of this. There, a missing
  // screenshot must never hold back the post. Here somebody clicked a link
  // asking to see one specific receipt, so silence would look like a broken
  // image and an honest failure is better than a redirect to nowhere.
  if (error || !data?.signedUrl) {
    console.error('[fees] could not sign expense receipt:', error?.message);
    return new NextResponse('Could not open that receipt', { status: 502 });
  }

  // The rewrite is why browserReachableSignedUrl exists: this client is built
  // with getServerSupabaseUrl(), which on prod is SUPABASE_INTERNAL_URL, a
  // private-network address no member's browser can resolve. See that module
  // for why the branch is untestable on staging.
  const response = NextResponse.redirect(browserReachableSignedUrl(data.signedUrl), 302);
  // The signed URL is a bearer token in a query string. A shared cache holding
  // this redirect would hand the next viewer a receipt they may not be allowed
  // to see, and a browser holding it would keep serving a URL that has expired.
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
