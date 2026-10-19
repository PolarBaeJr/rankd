import { describe, expect, it, vi } from 'vitest';
import { handle } from './worker.js';

const navigation = (headers = {}) =>
  new Request('https://club.example/feed', {
    headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html', ...headers },
  });

const upstreamReturning = (status, body = 'origin body', headers = {}) =>
  vi.fn(async () => new Response(body, { status, headers }));

describe('cloudflare error page worker', () => {
  it('passes a healthy page through untouched', async () => {
    const upstream = upstreamReturning(200, 'the feed');
    const response = await handle(navigation(), upstream);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('the feed');
  });

  it.each([502, 504, 521, 522, 530])('replaces a %i navigation and keeps the status', async (status) => {
    const response = await handle(navigation(), upstreamReturning(status, 'stock page', { 'cf-ray': 'abc123-YVR' }));
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('Back soon');
    expect(html).toContain(`Error ${status}`);
    expect(html).toContain('Reference abc123-YVR');
    expect(html).not.toContain('stock page');
  });

  it('shows the page when the origin cannot be fetched at all', async () => {
    const upstream = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const response = await handle(navigation(), upstream);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('Back soon');
  });

  it('leaves a maintenance 503 alone, headers and all', async () => {
    const response = await handle(
      navigation(),
      upstreamReturning(503, 'maintenance page', { 'retry-after': '600', 'x-maintenance': '1' }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('600');
    expect(response.headers.get('x-maintenance')).toBe('1');
    expect(await response.text()).toBe('maintenance page');
  });

  it("brands the proxy's own 503 when no backend is healthy", async () => {
    const proxyPage = '<div class=box><h1>Service unavailable</h1><p>Service unavailable at this time, try again later.</p></div>';
    const response = await handle(navigation(), upstreamReturning(503, proxyPage));
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain('Back soon');
    expect(html).toContain('Error 503');
  });

  it('leaves a JSON 503 alone without reading it', async () => {
    const request = new Request('https://club.example/supabase/rest/v1/players', { headers: { accept: 'application/json' } });
    const response = await handle(request, upstreamReturning(503, 'Service unavailable at this time, try again later.'));
    expect(await response.text()).toBe('Service unavailable at this time, try again later.');
  });

  it('leaves a JSON 502 from a fetch alone', async () => {
    const request = new Request('https://club.example/supabase/rest/v1/players', {
      headers: { 'sec-fetch-mode': 'cors', accept: 'application/json' },
    });
    const response = await handle(request, upstreamReturning(502, '{"message":"bad gateway"}'));
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"message":"bad gateway"}');
  });

  it('leaves a server action POST alone', async () => {
    const request = new Request('https://club.example/admin/fees', {
      method: 'POST',
      headers: { accept: 'text/x-component', 'next-action': 'abc' },
      body: '[]',
    });
    const response = await handle(request, upstreamReturning(502, 'action failure'));
    expect(await response.text()).toBe('action failure');
  });

  it('escapes the ray id', async () => {
    const response = await handle(navigation(), upstreamReturning(502, '', { 'cf-ray': '<script>' }));
    const html = await response.text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
