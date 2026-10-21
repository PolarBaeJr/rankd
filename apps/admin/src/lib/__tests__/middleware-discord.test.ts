import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The bot has no session cookie. Without the early return the middleware sent
// /api/discord/* to /login, and fetch follows a redirect, so the bot would
// have read the login page as an answer.
const built = vi.hoisted(() => ({ clients: 0 }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => {
    built.clients += 1;
    return { auth: { getUser: async () => ({ data: { user: null } }) } };
  },
}));

const { middleware } = await import('../../middleware');

describe('middleware and the Discord console routes', () => {
  it('lets /api/discord/* through without a session, before any Supabase client', async () => {
    const res = await middleware(new NextRequest('https://console.example.invalid/api/discord/actions/archiveSession'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(built.clients).toBe(0);
  });

  it('still sends a sessionless page request to /login', async () => {
    const res = await middleware(new NextRequest('https://console.example.invalid/sessions'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});
