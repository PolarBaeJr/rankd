// 00333: the slide route answers the same bare 404 to every refusal, and a PNG otherwise.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

let flagOn = true;
let allowed = true;
let rendered: unknown = null;
vi.mock('@/lib/release-flags', () => ({ releaseFlagOn: vi.fn(async () => flagOn) }));
vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: vi.fn(() => ({})),
  requireCapability: vi.fn(async () => {
    if (!allowed) throw new Error('refused');
  }),
}));
vi.mock('@/lib/social-posts/sets', () => ({
  EYEBROW: { teams_full: 'MEET THE TEAMS', teams_new: 'NEW TEAMS', draw: 'THE DRAW' },
  loadRenderedSet: vi.fn(async () => rendered),
}));

const { GET } = await import('../[setId]/[slide]/route');

const SET = 'cccccccc-0000-4000-8000-000000000001';
const call = (setId: string, slide: string) => GET(new Request('http://localhost/x'), { params: Promise.resolve({ setId, slide }) });

beforeEach(() => {
  flagOn = true;
  allowed = true;
  rendered = {
    set: { kind: 'teams_full' },
    event: { name: 'Fall Open Mixed Doubles', detail: null },
    pages: [[{ title: null, lines: ['Avery Placeholder & Blake Placeholder'] }]],
  };
});

describe('GET /api/social-posts/[setId]/[slide]', () => {
  it('404 with social_posts off', async () => {
    flagOn = false;
    expect((await call(SET, '1')).status).toBe(404);
  });

  it('404 without the capability', async () => {
    allowed = false;
    expect((await call(SET, '1')).status).toBe(404);
  });

  it('404 for a bad id, a bad slide, an unknown set, or a slide past the end', async () => {
    expect((await call('not-a-uuid', '1')).status).toBe(404);
    expect((await call(SET, '0')).status).toBe(404);
    expect((await call(SET, 'x')).status).toBe(404);
    expect((await call(SET, '2')).status).toBe(404);
    rendered = null;
    expect((await call(SET, '1')).status).toBe(404);
  });

  it('a PNG, inline, never cached', async () => {
    const response = await call(SET, '1.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="teams_full-1.png"');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  }, 30_000);
});
