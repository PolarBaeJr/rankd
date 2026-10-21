import { describe, it, expect, vi, beforeEach } from 'vitest';

// /tournaments enter. The checks before an entry are resolveDiscordPlayer's
// (tested in lib/__tests__/discord-member.test.ts) and the entry is
// enterEventCore, the web's own body (tested through registerForEvent). What
// this file pins is the route's half: every refusal it can answer, that a
// waiver tournament and a doubles event are sent to the website, and that
// Discord never asks the core to record an event waiver acceptance.

const PLAYER = { id: 'player-me', full_name: 'Me Myself', status: 'competitive', is_banned: false, active_flag: true };
const EVENT_ID = '11111111-2222-4333-8444-555555555555';

let caller: { ok: true; player: typeof PLAYER } | { ok: false; refusal: string } = { ok: true, player: PLAYER };
let event: Record<string, unknown> | null = null;
let eventError: { message: string } | null = null;
let coreError: Error | null = null;
const resolveCalls: unknown[][] = [];
const coreCalls: unknown[][] = [];

vi.mock('@/lib/discord-member', () => ({
  resolveDiscordPlayer: vi.fn(async (...args: unknown[]) => {
    resolveCalls.push(args);
    return caller;
  }),
}));

vi.mock('@/lib/tournament-entry-core', () => ({
  enterEventCore: vi.fn(async (...args: unknown[]) => {
    coreCalls.push(args);
    if (coreError) throw coreError;
    return { tournamentId: 't1' };
  }),
}));

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: event, error: eventError }),
      };
      return chain;
    },
  }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const { ExpectedError } = await import('@badminton/shared');
const { POST } = await import('../route');

function post(body: unknown, auth = 'Bearer test-secret') {
  return POST(
    new Request('http://localhost/api/discord/tournament-entry', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const BODY = { discordUserId: '111111', eventId: EVENT_ID };

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = 'test-secret';
  process.env.NEXT_PUBLIC_PLAYER_URL = 'https://club.example.invalid';
  caller = { ok: true, player: PLAYER };
  event = {
    id: EVENT_ID,
    tournament_id: 't1',
    event_type: 'mens_singles',
    tournament: { status: 'active', waiver_text: null },
  };
  eventError = null;
  coreError = null;
  resolveCalls.length = 0;
  coreCalls.length = 0;
});

describe('POST /api/discord/tournament-entry', () => {
  it('is a 401 without the service secret, and enters nobody', async () => {
    expect((await post(BODY, 'Bearer nope')).status).toBe(401);
    expect(coreCalls).toHaveLength(0);
  });

  it.each([
    [{ discordUserId: 'abc', eventId: EVENT_ID }],
    [{ discordUserId: '111111', eventId: 'not-a-uuid' }],
  ])('is a 400 for a malformed body', async (body) => {
    expect((await post(body)).status).toBe(400);
  });

  it('runs the play gate with the tournaments switch and the legal documents', async () => {
    await post(BODY);
    expect(resolveCalls[0]?.[1]).toBe('111111');
    expect(resolveCalls[0]?.[2]).toEqual({ feature: 'tournaments' });
  });

  it.each(['not_linked', 'lapsed', 'standing', 'feature_off', 'waiver'])(
    'answers the %s refusal and enters nobody',
    async (refusal) => {
      caller = { ok: false, refusal };
      expect(await (await post(BODY)).json()).toEqual({ ok: false, refusal });
      expect(coreCalls).toHaveLength(0);
    },
  );

  it('is a 503 when the caller cannot be read', async () => {
    caller = { ok: false, refusal: 'unavailable' };
    expect((await post(BODY)).status).toBe(503);
  });

  it('is a 503 when the event cannot be read', async () => {
    eventError = { message: 'boom' };
    expect((await post(BODY)).status).toBe(503);
  });

  it('does not find a missing event or one in a draft tournament', async () => {
    event = null;
    expect(await (await post(BODY)).json()).toEqual({ ok: false, refusal: 'not_found' });
    event = { id: EVENT_ID, tournament_id: 't1', event_type: 'mens_singles', tournament: { status: 'draft' } };
    expect(await (await post(BODY)).json()).toEqual({ ok: false, refusal: 'not_found' });
    expect(coreCalls).toHaveLength(0);
  });

  it('sends a tournament with an event waiver to the website', async () => {
    event = { ...event, tournament: [{ status: 'active', waiver_text: 'I accept the risks.' }] };
    expect(await (await post(BODY)).json()).toEqual({
      ok: false,
      refusal: 'website',
      url: `https://club.example.invalid/tournaments/t1/events/${EVENT_ID}`,
    });
    expect(coreCalls).toHaveLength(0);
  });

  it('sends a doubles event to the website', async () => {
    event = { ...event, event_type: 'mixed_doubles' };
    expect((await (await post(BODY)).json()).refusal).toBe('website');
    expect(coreCalls).toHaveLength(0);
  });

  it("passes the core's refusal on in its own words", async () => {
    coreError = new ExpectedError('Registration is closed');
    expect(await (await post(BODY)).json()).toEqual({ ok: false, refusal: 'rule', message: 'Registration is closed' });
  });

  it('enters the caller with no options and no user agent', async () => {
    const body = await (await post(BODY)).json();
    expect(body).toEqual({ ok: true, event: "Men's Singles" });
    expect(coreCalls).toHaveLength(1);
    const [, player, eventId, opts, userAgent] = coreCalls[0]!;
    expect(player).toBe(PLAYER);
    expect(eventId).toBe(EVENT_ID);
    expect(opts).toEqual({});
    expect(userAgent).toBeNull();
  });

  it('never sends eventWaiverAccepted, whatever the body says', async () => {
    await post({ ...BODY, eventWaiverAccepted: true, soloEntryAcknowledged: true });
    for (const call of coreCalls) {
      expect(call[3]).not.toHaveProperty('eventWaiverAccepted');
      expect(call[3]).not.toHaveProperty('soloEntryAcknowledged');
    }
  });
});
