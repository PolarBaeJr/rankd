import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ONE REAL ACTION THROUGH THE APP ROUTE, and the reason this file exists.
 *
 * The route only works if the website's own action, run unchanged inside the
 * actor store, (a) loads the ACTOR's player row and not somebody else's, and
 * (b) writes through the ACTOR's client, so RLS and auth.uid() see the member
 * who is asking. Both depend on createServerSupabaseClient and loadViewer
 * honouring the store, which no mocked-action test can prove.
 *
 * So acceptChallenge runs for real: requirePlayer, the feature switch, the
 * waiver gate, respond_to_challenge, notifyPlayers. Mocked are only the edges
 * that leave the process: supabase-js's createClient (two fakes, told apart by
 * the key they are built with), Sentry, PostHog, web push, next/cache, and the
 * email senders, so no test can ever reach a mail provider.
 */

type Recorded = { client: 'actor' | 'service'; table?: string; rpc?: string; filters: [string, unknown][]; op?: string };
const log: Recorded[] = [];

const CHALLENGE = '11111111-2222-4333-8444-555555555555';
const PLAYER = { id: 'player-1', user_id: 'user-1', full_name: 'Test Member', status: 'recreational', is_banned: false, active_flag: true, waiver_acceptances: [] };

function fakeClient(kind: 'actor' | 'service') {
  function builder(table: string) {
    const entry: Recorded = { client: kind, table, filters: [] };
    log.push(entry);
    const result = () => {
      if (table === 'players' && entry.op === 'select' && entry.filters.some(([c]) => c === 'user_id')) {
        return { data: PLAYER, error: null };
      }
      // The creator's email (.eq on id): none, so no mail is even attempted.
      if (table === 'players' && entry.filters.some(([c]) => c === 'id')) return { data: { email: null }, error: null };
      // The push preference lookup (.in on id): nobody opted in.
      if (table === 'players') return { data: [], error: null };
      if (table === 'legal_documents') return { data: [], error: null };
      return { data: null, error: null };
    };
    const api: Record<string, unknown> = {
      select: () => { entry.op ??= 'select'; return api; },
      insert: () => { entry.op = 'insert'; return api; },
      update: () => { entry.op = 'update'; return api; },
      eq: (c: string, v: unknown) => { entry.filters.push([c, v]); return api; },
      in: (c: string, v: unknown) => { entry.filters.push([`${c}:in`, v]); return api; },
      maybeSingle: async () => result(),
      single: async () => result(),
      then: (resolve: (v: unknown) => void) => resolve(result()),
    };
    return api;
  }
  return {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      log.push({ client: kind, rpc: fn, filters: Object.entries(args) });
      if (fn === 'respond_to_challenge') return { data: { ok: true, created_by: 'creator-1' }, error: null };
      return { data: null, error: null };
    },
    auth: {
      getUser: async (jwt?: string) =>
        jwt === 'good-token'
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: { message: 'bad jwt' } },
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, key: string) => fakeClient(key === 'service-key' ? 'service' : 'actor'),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => {
    throw new Error('the cookie client must not be built for an app request');
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => {
    throw new Error('cookies() must not be called for an app request');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ setUser: vi.fn(), captureException: vi.fn() }));
vi.mock('posthog-node', () => ({ PostHog: class {} }));
const sendPushToPlayers = vi.fn(async () => undefined);
vi.mock('@badminton/shared/src/push/send', () => ({ sendPushToPlayers: (...a: unknown[]) => sendPushToPlayers(...(a as [])) }));
const emails = vi.fn(async () => undefined);
vi.mock('@badminton/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@badminton/shared')>();
  return {
    ...real,
    sendChallengeReceivedEmail: emails,
    sendChallengeAcceptedEmail: emails,
    sendChallengeRejectedEmail: emails,
  };
});

const { POST } = await import('../[name]/route');

function call(token: string) {
  const request = new Request('https://site.example.invalid/api/app/actions/acceptChallenge', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: [CHALLENGE] }),
  });
  return POST(request, { params: Promise.resolve({ name: 'acceptChallenge' }) });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example.invalid';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  log.length = 0;
  emails.mockClear();
});

describe('acceptChallenge through /api/app/actions', () => {
  it("loads the actor's own row and answers on the actor's client", async () => {
    const res = await call('good-token');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The full player row: service role, filtered on the VERIFIED user id.
    const load = log.find((r) => r.table === 'players' && r.filters.some(([c]) => c === 'user_id'));
    expect(load).toMatchObject({ client: 'service', filters: [['user_id', 'user-1']] });

    // The answer itself: the member's own client, so auth.uid() is theirs.
    const respond = log.filter((r) => r.rpc === 'respond_to_challenge');
    expect(respond).toEqual([
      { client: 'actor', rpc: 'respond_to_challenge', filters: [['p_challenge_id', CHALLENGE], ['p_response', 'accepted']] },
    ]);

    // The waiver gate read through the member's client too, as on the website.
    expect(log.find((r) => r.table === 'legal_documents')?.client).toBe('actor');

    // The creator is told, as they are from the website.
    const notify = log.find((r) => r.table === 'notifications');
    expect(notify).toMatchObject({ client: 'service', op: 'insert' });
    expect(emails).not.toHaveBeenCalled();
  });

  it('refuses a token GoTrue does not accept, before any read or write', async () => {
    const res = await call('bad-token');
    expect(res.status).toBe(401);
    expect(log).toHaveLength(0);
  });
});
