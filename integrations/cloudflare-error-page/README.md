# Branded gateway error page

A Cloudflare Worker that shows the club's own page when a browser navigation
fails with 502, 504, Cloudflare's 52x origin errors or 530 (tunnel down),
or the proxy's own "no healthy backend" 503, instead of the stock page.
Everything else, including maintenance mode's 503, passes through unchanged. See `worker.js`.

Test: `npx vitest run integrations/cloudflare-error-page`

## Deploy

1. `cp wrangler.example.toml wrangler.toml` and set the route to the site's
   host only, never a wildcard over the whole zone.
2. `npx wrangler@4 deploy`
3. In the dashboard, under the zone's Workers Routes:
   - add a route for `SITE_HOST/supabase/*` with Worker set to None, so the
     API and realtime never run through the Worker or count against the free
     plan's daily requests;
   - set the site route's request limit failure mode to Fail open, so going
     over the free limit skips the Worker rather than erroring.
