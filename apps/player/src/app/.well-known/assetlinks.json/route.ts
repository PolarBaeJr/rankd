import { buildAssetLinks } from '@/lib/passkey/native-apps';

// Digital Asset Links: which Android apps may use this domain's passkeys. See
// lib/passkey/native-apps.ts.
//
// Built from env on every request (force-dynamic) so a certificate can be
// added to a running service without a rebuild. 404 with an empty body when
// no certificate is configured, which is exactly what the site answered
// before this route existed, rather than a valid-looking empty list.
//
// NEVER a redirect. Google's verifier does not follow one, and this path is
// public in middleware (public-paths.ts and the matcher) for that reason: a
// 307 to /login here reads as "no app is trusted" and passkeys silently stop
// working in the app.
export const dynamic = 'force-dynamic';

export function GET() {
  const body = buildAssetLinks();
  if (!body) return new Response(null, { status: 404 });
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}
