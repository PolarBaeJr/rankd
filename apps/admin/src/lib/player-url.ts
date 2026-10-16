import { BASE_PATH } from './base-path';

/**
 * A URL on the member app, for a link out of the console.
 *
 * Deployed, both apps share one origin and the console sits under /admin, so a
 * bare path is already the member app. Locally the console is root-mounted on
 * its own port, so the member app's origin has to be named.
 *
 * Use it in a plain <a>, never a Next <Link>: Link adds the basePath and the
 * link would land back on /admin.
 */
export function memberAppUrl(path = '/'): string {
  if (BASE_PATH) return path;
  return (process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000').replace(/\/$/, '') + path;
}
