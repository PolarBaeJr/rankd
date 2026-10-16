import { buildAppleAppSiteAssociation } from '@/lib/passkey/native-apps';

// Apple App Site Association: which iOS apps may use this domain's passkeys
// (the `webcredentials` service). See lib/passkey/native-apps.ts.
//
// No file extension, and served as application/json anyway, which is what
// Apple asks for. Built from env on every request (force-dynamic); 404 with an
// empty body when no app id is configured.
//
// NEVER a redirect: Apple's CDN fetches this anonymously and does not follow
// one, so the path is public in middleware (public-paths.ts and the matcher).
export const dynamic = 'force-dynamic';

export function GET() {
  const body = buildAppleAppSiteAssociation();
  if (!body) return new Response(null, { status: 404 });
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}
