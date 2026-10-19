// Cloudflare Worker that puts the club's own page in front of a gateway error.
//
// Without it a dead origin shows Cloudflare's stock "Bad gateway" page. The
// Worker forwards every request untouched and steps in only when a browser
// navigation comes back as a gateway failure. Fetches, server actions and
// PostgREST calls keep their real response so client error handling still
// works. A 503 is branded only when it is the proxy's generic "no healthy
// backend" page: maintenance mode answers 503 with the app's own page, and that
// one must reach the visitor as it is.

// 502/504 from the origin, Cloudflare's 52x origin errors, and 530 for a
// tunnel with no connector.
const GATEWAY_FAILURES = new Set([502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

// The sentence the proxy writes on its own 503 page (serveUnavailable).
const PROXY_UNAVAILABLE = 'Service unavailable at this time, try again later.';

export function isNavigation(request) {
  if (request.method !== 'GET') return false;
  if (request.headers.get('sec-fetch-mode') === 'navigate') return true;
  return (request.headers.get('accept') || '').includes('text/html');
}

export async function handle(request, upstream = fetch) {
  if (!isNavigation(request)) return upstream(request);
  let response;
  try {
    response = await upstream(request);
  } catch {
    return errorPage(502, '');
  }
  const ray = response.headers.get('cf-ray') || '';
  if (GATEWAY_FAILURES.has(response.status)) return errorPage(response.status, ray);
  if (response.status !== 503) return response;
  // Reading the body consumes it, so anything else is rebuilt from the text.
  const body = await response.text();
  if (body.includes(PROXY_UNAVAILABLE)) return errorPage(503, ray);
  return new Response(body, response);
}

export default {
  fetch: (request) => handle(request),
};

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The status stays the real one so uptime checks still see the outage.
export function errorPage(status, ray) {
  const reference = ray ? `<p class="ref">Reference ${escapeHtml(ray)}</p>` : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<meta name="robots" content="noindex">
<title>Back soon | SFU Badminton</title>
<style>
  :root { color-scheme: dark; --red: #c00; --bg: #0a0a0a; --surface: #111; --ink: #f0f0f0; --mute: #888; --dim: #666; --line: hsla(0, 0%, 100%, 0.08); }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
  main { width: 100%; max-width: 440px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 40px; }
  .mark { width: 32px; height: 32px; border-radius: 8px; background: var(--red); color: #fff; display: grid; place-items: center; }
  .brand b { font: 700 15px/1.1 "Barlow Condensed", "Arial Narrow", ui-sans-serif, system-ui, sans-serif; font-stretch: condensed; text-transform: uppercase; letter-spacing: 0.02em; }
  .kicker { display: flex; align-items: center; gap: 10px; font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.14em; text-transform: uppercase; color: var(--red); margin-bottom: 12px; }
  .kicker::before { content: ""; width: 18px; height: 2px; background: var(--red); }
  h1 { margin: 0 0 12px; font: 800 44px/0.95 "Barlow Condensed", "Arial Narrow", ui-sans-serif, system-ui, sans-serif; font-stretch: condensed; text-transform: uppercase; letter-spacing: -0.01em; }
  h1 span { color: var(--red); }
  p { margin: 0 0 24px; color: var(--mute); }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; }
  .button { appearance: none; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 8px; padding: 10px 16px; font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.1em; text-transform: uppercase; text-decoration: none; cursor: pointer; }
  .button.primary { background: var(--red); border-color: var(--red); color: #fff; }
  .ref { margin: 32px 0 0; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dim); }
</style>
</head>
<body>
<main>
  <div class="brand">
    <div class="mark" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="17.6" r="2.2" fill="currentColor" stroke="none"/><path d="M10.2 15.9 6 5.4"/><path d="M12 15.9V4.2"/><path d="M13.8 15.9 18 5.4"/><path d="M7.4 9.1c3-1.5 6.2-1.5 9.2 0"/></svg>
    </div>
    <b>SFU Badminton</b>
  </div>
  <div class="kicker">Error ${status}</div>
  <h1>Back soon<span>.</span></h1>
  <p>The site cannot be reached right now. It usually comes back within a few minutes, and this page will retry on its own.</p>
  <div class="actions">
    <button class="button primary" type="button" onclick="location.reload()">Try again</button>
    <a class="button" href="https://discord.sfubadminton.com">Club Discord</a>
  </div>
  ${reference}
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '30',
    },
  });
}
